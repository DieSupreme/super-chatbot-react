// Electron-free core for the ComfyUI (video) backend: portable-install layout
// detection, process spawn, workflow loading + manifest-driven patching, a
// minimal WebSocket client (Electron 33 main = Node 20.18, no global
// WebSocket; node builtins only), and output file naming. Mirrors sd-core.js
// so node --test can exercise everything without Electron.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ---------- install layout ----------
// Portable build: <root>\python_embeded\python.exe + <root>\ComfyUI\main.py.
// A git clone (no embedded python) gets base = root and python from PATH.
function detectComfyLayout(root) {
  const embedded = path.join(root, 'python_embeded', 'python.exe');
  const portable = fs.existsSync(embedded) && fs.existsSync(path.join(root, 'ComfyUI', 'main.py'));
  return {
    root,
    portable,
    base: portable ? path.join(root, 'ComfyUI') : root,
    python: portable ? embedded : 'python'
  };
}

// Spawn mirrors run_nvidia_gpu.bat plus --disable-auto-launch; cwd must be the
// install root (the portable build resolves everything relative to it).
function spawnComfy(root, port) {
  const layout = detectComfyLayout(root);
  const args = ['-s', path.join('ComfyUI', 'main.py'), '--windows-standalone-build', '--disable-auto-launch'];
  if (!layout.portable) args.splice(0, 2, path.join(layout.base, 'main.py'));
  if (port && Number(port) !== 8188) args.push('--port', String(port));
  return spawn(layout.python, args, {
    cwd: layout.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

// ---------- workflows are data ----------
// A workflow is a PAIR in workflowsDir: <name>.json (ComfyUI API format) and
// <name>.manifest.json (control -> node/input mapping). Adding a model is a
// data drop, never a code change.
function listWorkflows(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.manifest.json')) continue;
    const name = f.slice(0, -'.manifest.json'.length);
    const graphFile = path.join(dir, name + '.json');
    if (!fs.existsSync(graphFile)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ name, label: manifest.label || name, controls: manifest.controls || {} });
    } catch (_) { /* malformed manifest -> skipped, surfaced by absence */ }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function loadWorkflow(dir, name) {
  const graph = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, name + '.manifest.json'), 'utf8'));
  return { graph, manifest };
}

// Patch ONLY manifest-mapped inputs into a deep copy of the graph. A control
// is either { node, input } or { targets: [{ node, input }, ...] }.
function patchWorkflow(graph, manifest, values) {
  const out = JSON.parse(JSON.stringify(graph));
  for (const [key, ctl] of Object.entries(manifest.controls || {})) {
    let v = values[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      if (ctl.min != null) v = Math.max(ctl.min, v);
      if (ctl.max != null) v = Math.min(ctl.max, v);
      if (ctl.type === 'int' || ctl.type === 'seed') v = Math.round(v);
    }
    const targets = ctl.targets || [{ node: ctl.node, input: ctl.input }];
    for (const t of targets) {
      const node = out[t.node];
      if (!node || !node.inputs) throw new Error(`manifest control "${key}" points at missing node ${t.node}`);
      node.inputs[t.input] = v;
    }
  }
  return out;
}

// ---------- output naming ----------
// vid-YYYYMMDD-HHMMSS-<seed>.<ext>, suffixed -2, -3… on collision — the same
// convention as sd-core.imageFileName.
function videoFileName(dir, seed, ext = 'mp4', now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const baseName = `vid-${stamp}-${seed != null ? seed : 'x'}`;
  let name = `${baseName}.${ext}`, i = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${baseName}-${++i}.${ext}`;
  return name;
}

// ---------- minimal WebSocket client (receive-oriented, builtins only) ----------
// Electron 33's main process is Node 20.18 — no global WebSocket. ComfyUI's
// /ws only needs us to RECEIVE JSON events; we never send text. Handles the
// RFC 6455 upgrade, unmasked server frames (text/ping/close), fragmented
// continuation, and replies to pings with a masked pong. Binary preview
// frames (opcode 2) are skipped.
function openWs(url, { onMessage, onClose } = {}) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  let socket = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket && socket.destroy(); } catch (_) {}
    onClose && onClose();
  };

  const req = http.request({
    host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13
    }
  });
  req.on('error', close);
  req.on('response', close);   // server refused the upgrade
  req.on('upgrade', (_res, sock, head) => {
    if (closed) { sock.destroy(); return; }
    socket = sock;
    sock.on('error', close);
    sock.on('close', close);
    let buf = Buffer.alloc(0);
    let fragments = null;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 8) { close(); return; }             // close
        if (opcode === 9) {                                 // ping -> masked pong
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
          try { sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | masked.length]), mask, masked])); } catch (_) {}
          continue;
        }
        if (opcode === 10 || opcode === 2) continue;        // pong / binary preview
        if (opcode === 1 && !fin) { fragments = [payload]; continue; }
        if (opcode === 0) {                                 // continuation
          if (fragments) fragments.push(payload);
          if (!fin) continue;
          const whole = Buffer.concat(fragments || [payload]);
          fragments = null;
          deliver(whole);
          continue;
        }
        if (opcode === 1) deliver(payload);
      }
    };
    const deliver = (payload) => {
      try { onMessage && onMessage(JSON.parse(payload.toString('utf8'))); } catch (_) {}
    };
    sock.on('data', onData);
    // frames that rode in on the same packet as the 101 handshake
    if (head && head.length) onData(head);
  });
  req.end();
  return { close, get open() { return !!socket && !closed; } };
}

module.exports = {
  detectComfyLayout, spawnComfy,
  listWorkflows, loadWorkflow, patchWorkflow,
  videoFileName, openWs
};
