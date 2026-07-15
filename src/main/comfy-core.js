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
// data drop, never a code change. `media` says what the workflow produces
// ('image' | 'video'); manifests written before the field existed are video.
function workflowMedia(manifest) {
  return manifest && manifest.media === 'image' ? 'image' : 'video';
}

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
      out.push({ name, label: manifest.label || name, media: workflowMedia(manifest), controls: manifest.controls || {} });
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
// Readonly controls always patch their manifest default — the value is a
// model constraint (e.g. a distilled checkpoint's locked cfg), not a choice.
function patchWorkflow(graph, manifest, values) {
  const out = JSON.parse(JSON.stringify(graph));
  for (const [key, ctl] of Object.entries(manifest.controls || {})) {
    let v = ctl.type === 'readonly' && ctl.default != null ? ctl.default : values[key];
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
// <prefix>-YYYYMMDD-HHMMSS-<seed>.<ext>, suffixed -2, -3… on collision — the
// same convention as sd-core.imageFileName. vid-* for video workflows,
// img-* for ComfyUI image workflows (sd-* stays Forge's).
function mediaFileName(dir, seed, ext, prefix, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const baseName = `${prefix}-${stamp}-${seed != null ? seed : 'x'}`;
  let name = `${baseName}.${ext}`, i = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${baseName}-${++i}.${ext}`;
  return name;
}
function videoFileName(dir, seed, ext = 'mp4', now = new Date()) {
  return mediaFileName(dir, seed, ext, 'vid', now);
}

// ---------- UI-graph -> API-format conversion ----------
// ComfyUI's default Ctrl+S export is the UI/graph format (nodes[] + links[]),
// not the API format /prompt expects. Rather than force users to re-export
// with "Save (API format)", convert at generate time. Widget values in the
// graph are a POSITIONAL array; /object_info supplies the input-name order,
// so conversion needs a running server (which generation implies anyway).
const UI_NOTE_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNote']);

function isUiGraph(graph) {
  return !!graph && Array.isArray(graph.nodes);
}

// active = executed by ComfyUI: not a note, not muted (mode 2), not bypassed
// (mode 4 — e.g. an optional img2img branch left greyed out in the editor)
function uiGraphActiveNodes(graph) {
  return (graph.nodes || []).filter(n => n && !UI_NOTE_TYPES.has(n.type) && !(n.mode === 2 || n.mode === 4));
}

function uiGraphTypes(graph) {
  return [...new Set(uiGraphActiveNodes(graph).map(n => n.type))];
}

// info: merged /object_info responses covering every active node type.
// Returns the id-keyed API graph ({ inputs, class_type, _meta } per node).
function uiGraphToApi(graph, info) {
  const active = uiGraphActiveNodes(graph);
  const activeIds = new Set(active.map(n => n.id));
  const byId = new Map((graph.nodes || []).map(n => [n.id, n]));
  const linkSrc = new Map();   // link id -> [srcNodeId, srcSlot]
  for (const l of graph.links || []) if (Array.isArray(l)) linkSrc.set(l[0], [l[1], l[2]]);

  // follow a link upstream; a bypassed source node forwards its same-typed
  // input straight through (that is what mode 4 means in the editor)
  function resolveLink(linkId, wantType) {
    for (let hops = 0; linkId != null && hops < 64; hops++) {
      const src = linkSrc.get(linkId);
      if (!src) return null;
      const n = byId.get(src[0]);
      if (!n) return null;
      if (activeIds.has(n.id)) return [String(n.id), src[1]];
      const through = (n.inputs || []).find(i => i.type === wantType && i.link != null);
      if (!through) return null;
      linkId = through.link;
    }
    return null;
  }

  const CONTROL_AFTER = ['fixed', 'increment', 'decrement', 'randomize'];
  const out = {};
  for (const n of active) {
    const def = info && info[n.type];
    if (!def) throw new Error(`workflow uses node type "${n.type}" (id ${n.id}) that this ComfyUI does not provide`);
    const specs = { ...((def.input && def.input.required) || {}), ...((def.input && def.input.optional) || {}) };
    const linked = new Map((n.inputs || []).map(i => [i.name, i]));
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const inputs = {};
    let w = 0;
    for (const [name, spec] of Object.entries(specs)) {
      const typeSpec = Array.isArray(spec) ? spec[0] : spec;
      const opts = (Array.isArray(spec) && spec[1]) || {};
      // combos are arrays; primitive types are widgets; anything else
      // (MODEL, LATENT, CONDITIONING, …) is a connection
      const isWidget = Array.isArray(typeSpec) ||
        typeSpec === 'INT' || typeSpec === 'FLOAT' || typeSpec === 'STRING' ||
        typeSpec === 'BOOLEAN' || typeSpec === 'COMBO';
      const conn = linked.get(name);
      if (isWidget) {
        const v = wv[w++];
        // seed-style widgets carry a hidden "control_after_generate" slot
        if (opts.control_after_generate === true ||
            ((name === 'seed' || name === 'noise_seed') && CONTROL_AFTER.includes(wv[w]))) w++;
        if (conn && conn.link != null) {          // widget promoted to input
          const src = resolveLink(conn.link, conn.type);
          if (src) { inputs[name] = src; continue; }
        }
        if (v !== undefined) inputs[name] = v;
      } else if (conn && conn.link != null) {
        const src = resolveLink(conn.link, conn.type);
        if (!src) throw new Error(`node ${n.id} (${n.type}) input "${name}" is wired to a bypassed or missing node`);
        inputs[name] = src;
      }
    }
    out[String(n.id)] = {
      inputs,
      class_type: n.type,
      _meta: { title: n.title || (n.properties && n.properties['Node name for S&R']) || n.type }
    };
  }
  return out;
}

// ---------- history output picking ----------
// /history outputs are { nodeId: { images|gifs|…: [{filename,…}] } }. Pick
// THE result file: manifest "output" pins the node whose files count (a
// multi-stage pipeline saves intermediates too — those must never win), then
// prefer the extension matching the workflow's media. Returns
// { pick, fallback } — fallback=true means the pinned node produced nothing.
function pickHistoryOutput(outputs, media, outputNode) {
  let src = outputs || {};
  const want = outputNode != null ? String(outputNode) : null;
  const fallback = !!(want && !src[want]);
  if (want && src[want]) src = { [want]: src[want] };
  const produced = [];
  for (const nodeOut of Object.values(src)) {
    for (const arr of Object.values(nodeOut || {})) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) if (item && item.filename) produced.push(item);
    }
  }
  const isVideo = (f) => /\.(mp4|webm|mov|avi|gif|webp)$/i.test(f.filename);
  const isImage = (f) => /\.(png|jpe?g|webp|bmp)$/i.test(f.filename);
  const pick = (media === 'image' ? produced.find(isImage) : produced.find(isVideo)) || produced[0] || null;
  return { pick, fallback };
}

// ---------- /object_info dropdowns ----------
// A manifest select can declare "options_from": "object_info:<NodeType>:<input>"
// to populate live from ComfyUI (samplers, schedulers, model files) instead of
// hardcoding lists. This extracts the options array from a /object_info/<Type>
// response: combo inputs are [[...options], {meta}] under input.required/optional.
function objectInfoOptions(info, nodeType, input) {
  const node = info && info[nodeType];
  const inputs = (node && node.input) || {};
  const def = (inputs.required && inputs.required[input]) || (inputs.optional && inputs.optional[input]);
  return Array.isArray(def) && Array.isArray(def[0]) ? def[0].map(String) : [];
}

// ---------- WebSocket client ----------
// Electron 43's main process (Node 22+) ships a native global WebSocket —
// preferred when present. The manual RFC 6455 client below stays as the
// tested fallback for older runtimes. Either way ComfyUI's /ws only needs us
// to RECEIVE JSON events; binary preview frames are skipped.
function openWs(url, handlers) {
  return typeof WebSocket === 'function' ? openNativeWs(url, handlers) : openManualWs(url, handlers);
}

function openNativeWs(url, { onMessage, onClose } = {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch (_) {}
    onClose && onClose();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;   // binary preview frames
    try { onMessage && onMessage(JSON.parse(ev.data)); } catch (_) {}
  };
  ws.onclose = close;
  ws.onerror = close;
  return { close, get open() { return ws.readyState === 1 && !closed; } };
}

// Manual receive-oriented RFC 6455 client on http+crypto builtins: upgrade
// handshake, unmasked server frames (text/ping/close), fragmented
// continuation, masked pong replies. Kept fully tested — it is the fallback
// if the app ever runs on a WebSocket-less Node again.
function openManualWs(url, { onMessage, onClose } = {}) {
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
  listWorkflows, loadWorkflow, patchWorkflow, workflowMedia,
  isUiGraph, uiGraphTypes, uiGraphToApi, pickHistoryOutput,
  mediaFileName, videoFileName, objectInfoOptions,
  openWs, openNativeWs, openManualWs
};
