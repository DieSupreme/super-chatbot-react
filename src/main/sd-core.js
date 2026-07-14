// Electron-free core for the Stable Diffusion (Forge) integration: install
// layout detection, model-folder scanning, process spawn/kill, port probing,
// and a minimal grayscale PNG encoder for inpaint masks. Kept free of any
// electron require so node --test can exercise it and a plain-node harness
// can drive the real spawn/kill path outside the app.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const zlib = require('zlib');

// ---------- install layout ----------
// One-click package: <root>\webui\webui-user.bat exists and everything lives
// under <root>\webui. Git clone: webui-user.bat sits at the root itself.
function detectLayout(root) {
  const oneClick = fs.existsSync(path.join(root, 'webui', 'webui-user.bat'));
  return { root, oneClick, base: oneClick ? path.join(root, 'webui') : root };
}

// ---------- model folder scan ----------
function scanModelDir(dir, exts) {
  const list = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (exts.has(path.extname(e.name).toLowerCase())) {
        list.push({ file: p, rel: r, name: path.basename(e.name, path.extname(e.name)) });
      }
    }
  };
  walk(dir, '');
  return list.sort((a, b) => a.rel.localeCompare(b.rel));
}

const CKPT_EXTS = new Set(['.safetensors', '.ckpt']);
const LORA_EXTS = new Set(['.safetensors', '.ckpt', '.pt']);

function scanCheckpoints(base) { return scanModelDir(path.join(base, 'models', 'Stable-diffusion'), CKPT_EXTS); }
function scanLoras(base) { return scanModelDir(path.join(base, 'models', 'Lora'), LORA_EXTS); }

// ---------- checkpoint reconcile ----------
// Disk scan populates the dropdown while Forge is stopped; when it's running,
// /sdapi/v1/sd-models wins because its `title` is the exact string
// /sdapi/v1/options wants. Match the two by filename.
function reconcileCheckpoints(diskList, apiList) {
  const out = [];
  const seen = new Set();
  for (const m of apiList || []) {
    const fname = path.basename(m.filename || m.title || '').toLowerCase();
    seen.add(fname);
    out.push({ value: m.title, label: m.model_name || m.title, title: m.title, onDisk: true });
  }
  for (const d of diskList || []) {
    const fname = path.basename(d.file).toLowerCase();
    if (seen.has(fname)) continue;
    // no API title yet (Forge stopped) — value is the bare name, not switchable
    out.push({ value: d.name, label: d.name, title: null, onDisk: true });
  }
  return out;
}

// ---------- Forge process ----------
// Spawn strategy (per approved plan): replicate run.bat but skip webui-user.bat,
// because webui-user.bat hard-sets COMMANDLINE_ARGS and would clobber ours.
// webui.bat itself never sets it, so the env var survives.
// NOTE: no --skip-loading-model-at-start — Forge f2.0.1 doesn't know that flag
// (argparse kills the launch with exit 2); its --skip-load-model-at-start
// variant only applies under --nowebui, and Forge loads weights on demand anyway.
const FORGE_ARGS = '--api --xformers';

function spawnForge(root) {
  const layout = detectLayout(root);
  const env = { ...process.env, COMMANDLINE_ARGS: FORGE_ARGS };
  if (process.platform === 'win32') {
    // .\ prefixes are required: if NoDefaultCurrentDirectoryInExePath is set
    // in the parent env, cmd refuses to resolve bare .bat names from the cwd.
    const chain = layout.oneClick
      ? 'call .\\environment.bat && cd /d webui && call .\\webui.bat'
      : 'call .\\webui.bat';
    return spawn('cmd.exe', ['/d', '/s', '/c', chain], {
      cwd: layout.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  }
  return spawn('bash', ['webui.sh'], { cwd: layout.base, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Kill the whole tree: the .bat is only a cmd wrapper — a plain kill would
// orphan the python child holding port 7860, so on Windows use taskkill /T.
function killTree(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGTERM'); return true; }
  catch (_) { try { process.kill(pid, 'SIGTERM'); return true; } catch (_) { return false; } }
}

// TCP probe: resolves true if something is listening on host:port.
function portInUse(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Poll until the port stops accepting connections (Forge teardown isn't instant).
async function waitPortFree(host, port, maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!(await portInUse(host, port, 500))) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return !(await portInUse(host, port, 500));
}

// ---------- grayscale PNG encoder (for inpaint masks) ----------
// The renderer keeps the mask as a Uint8Array (jsdom has no canvas rasterizer,
// so mask logic stays pure JS); this turns it into a black/white PNG for the
// /sdapi/v1/img2img `mask` field. 8-bit grayscale, one IDAT, zlib-deflated.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

// data: Uint8Array of w*h values; any value >= 128 becomes white (inpaint).
function encodeMaskPng(width, height, data) {
  if (!width || !height || !data || data.length < width * height) throw new Error('bad mask dimensions');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0;  // filter: none
    for (let x = 0; x < width; x++) raw[row + 1 + x] = data[y * width + x] >= 128 ? 255 : 0;
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return png.toString('base64');
}

// Nearest-neighbour resize of a 0/255 mask so the exported PNG exactly
// matches the source image dimensions (the panel paints at a capped
// resolution to keep the preview buffers small).
function scaleMask(data, w, h, w2, h2) {
  if (w === w2 && h === h2) return data;
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / h2));
    for (let x = 0; x < w2; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / w2));
      out[y * w2 + x] = data[sy * w + sx];
    }
  }
  return out;
}

// ---------- request bodies ----------
// Built here (electron-free) so tests and harnesses exercise the exact JSON
// the app POSTs to /sdapi/v1/txt2img and /sdapi/v1/img2img.
function buildTxt2ImgBody(p) {
  return {
    prompt: String(p.prompt || ''),
    negative_prompt: String(p.negative || ''),
    steps: Number(p.steps) || 25,
    cfg_scale: Number(p.cfg) || 7,
    width: Number(p.width) || 1024,
    height: Number(p.height) || 1024,
    sampler_name: p.sampler || 'Euler a',
    seed: Number.isFinite(Number(p.seed)) ? Number(p.seed) : -1
  };
}

function buildImg2ImgBody(p, initB64) {
  const body = {
    ...buildTxt2ImgBody(p),
    init_images: [initB64],
    denoising_strength: Number.isFinite(Number(p.denoise)) ? Number(p.denoise) : 0.5
  };
  // inpaint: mask arrives as raw pixels; scale it to the source image's exact
  // dimensions, then encode. White = repaint.
  if (p.maskData && p.maskData.data) {
    const { width, height, data } = p.maskData;
    const tw = Number(p.srcW) || width;
    const th = Number(p.srcH) || height;
    body.mask = encodeMaskPng(tw, th, scaleMask(data, width, height, tw, th));
    body.inpainting_fill = 1;
    body.inpaint_full_res = true;
    body.inpaint_full_res_padding = 32;
  }
  return body;
}

// ---------- generated-image filenames ----------
// sd-YYYYMMDD-HHMMSS-<seed>.png, suffixed -2, -3… on collision.
function imageFileName(dir, seed, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const baseName = `sd-${stamp}-${seed}`;
  let name = baseName + '.png', i = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${baseName}-${++i}.png`;
  return name;
}

module.exports = {
  detectLayout, scanCheckpoints, scanLoras, reconcileCheckpoints,
  FORGE_ARGS, spawnForge, killTree, portInUse, waitPortFree,
  encodeMaskPng, scaleMask, buildTxt2ImgBody, buildImg2ImgBody, imageFileName
};
