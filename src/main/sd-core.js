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
const VAE_EXTS = new Set(['.safetensors', '.ckpt', '.pt']);

function scanCheckpoints(base) { return scanModelDir(path.join(base, 'models', 'Stable-diffusion'), CKPT_EXTS); }
function scanLoras(base) { return scanModelDir(path.join(base, 'models', 'Lora'), LORA_EXTS); }
// /sdapi/v1/sd-vae is a 404 in Forge f2.0.1, so the VAE dropdown scans disk
function scanVae(base) { return scanModelDir(path.join(base, 'models', 'VAE'), VAE_EXTS); }

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

// Forge's browser auto-open is driven by the `auto_launch_browser` *setting*
// (default "Local"), not by a flag — f2.0.1 has no CLI flag to turn it off,
// only --autolaunch to force it on. webui.py skips the whole auto-launch block
// when SD_WEBUI_RESTARTING=1 (its only effect), so set it to guarantee an
// app-spawned Forge never opens a tab regardless of the user's config.json.
function forgeSpawnEnv() {
  return { ...process.env, COMMANDLINE_ARGS: FORGE_ARGS, SD_WEBUI_RESTARTING: '1' };
}

function spawnForge(root) {
  const layout = detectLayout(root);
  const env = forgeSpawnEnv();
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

// ---------- request-body sanitizer ----------
// Forge's pydantic models accept Optional numerics, then processing does
// arithmetic on them: a null steps/cfg_scale/width/batch_size/n_iter/
// subseed_strength/hr_* all 500 with a NoneType TypeError (verified live,
// only seed tolerates null). An empty <input type="number"> yields "" in the
// renderer, which would serialize to null — so the LAST step before the fetch
// scrubs the whole body, schema-driven, no field special-cased: null-ish
// values become the field's schema default, or the key is dropped when the
// schema default is itself null.
function sanitizeRequestBody(body) {
  const FIELDS = { ...SD_SCHEMA.txt2img, ...SD_SCHEMA.img2img };
  const bad = (v) => v === null || v === undefined || v === ''
    || (typeof v === 'number' && !Number.isFinite(v));
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (bad(v)) {
      const meta = FIELDS[k];
      if (meta && meta.def !== null && meta.def !== undefined) out[k] = meta.def;
      continue;   // no usable default -> omit the key entirely
    }
    if (k === 'override_settings' && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      for (const [ok, ov] of Object.entries(v)) if (!bad(ov)) o[ok] = ov;
      if (Object.keys(o).length) out[k] = o;
      continue;
    }
    out[k] = v;
  }
  return out;
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
//
// Contract: fields the user never touched are OMITTED (Forge then applies its
// own schema default) — values equal to the schema default in sd-schema.json
// are dropped, nulls are dropped, everything else is sent verbatim. The hires
// block only exists when enable_hr is on, the refiner block only when a
// refiner checkpoint is picked, and override_settings always travels with
// override_settings_restore_afterwards: true so a per-generation override
// (VAE / CLIP skip / checkpoint) never permanently mutates Forge's options.
const SD_SCHEMA = require('../sd-schema.json');

// copy p[k] into body for every schema field that differs from its default
function applySchemaFields(body, p, fields, skip) {
  for (const k of Object.keys(fields)) {
    if (skip && skip.has(k)) continue;
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { if (v.length) body[k] = v; continue; }
    if (fields[k].def !== null && v === fields[k].def) continue;
    body[k] = v;
  }
}

const HR_FIELDS = new Set(Object.keys(SD_SCHEMA.txt2img).filter(k => k === 'enable_hr' || k.startsWith('hr_')));
const REFINER_FIELDS = new Set(['refiner_checkpoint', 'refiner_switch_at']);
const SD_SCHEMA_NON_HR = Object.keys(SD_SCHEMA.txt2img).filter(k => !HR_FIELDS.has(k));

function buildTxt2ImgBody(p) {
  const body = {
    prompt: String(p.prompt || ''),
    negative_prompt: String(p.negative || ''),
    steps: Number(p.steps) || SD_SCHEMA.txt2img.steps.def,
    cfg_scale: Number(p.cfg) || SD_SCHEMA.txt2img.cfg_scale.def,
    width: Number(p.width) || SD_SCHEMA.txt2img.width.def,
    height: Number(p.height) || SD_SCHEMA.txt2img.height.def,
    seed: Number.isFinite(Number(p.seed)) ? Number(p.seed) : -1
  };
  const sampler = p.sampler || p.sampler_name;
  if (sampler) body.sampler_name = sampler;
  applySchemaFields(body, p, SD_SCHEMA.txt2img, new Set([...HR_FIELDS, ...REFINER_FIELDS,
    'seed', 'steps', 'cfg_scale', 'width', 'height', 'sampler_name']));
  if (p.enable_hr) {
    body.enable_hr = true;
    // Forge f2.0.1 API bug: hr_additional_modules schema-defaults to null but
    // processing.py:1405 iterates it -> 500 "NoneType is not iterable". The
    // Forge UI's own default is ["Use same choices"]; mirror that unless the
    // caller picked modules explicitly.
    body.hr_additional_modules = Array.isArray(p.hr_additional_modules) ? p.hr_additional_modules : ['Use same choices'];
    applySchemaFields(body, p, SD_SCHEMA.txt2img, new Set([...SD_SCHEMA_NON_HR, 'enable_hr', 'hr_additional_modules']));
    // hires REQUIRES a denoising strength: the API default is None and Forge
    // crashes on "'>' not supported between NoneType and int" (verified live).
    // 0.7 is the Forge UI's own default for the hires denoise control.
    if (body.denoising_strength == null) {
      const d = Number(p.denoising_strength != null ? p.denoising_strength : p.denoise);
      body.denoising_strength = Number.isFinite(d) ? d : 0.7;
    }
  }
  if (p.refiner_checkpoint) {
    body.refiner_checkpoint = p.refiner_checkpoint;
    if (p.refiner_switch_at != null) body.refiner_switch_at = p.refiner_switch_at;
  }
  if (p.override_settings && Object.keys(p.override_settings).length) {
    body.override_settings = { ...p.override_settings };
    body.override_settings_restore_afterwards = true;
  }
  // ADetailer (extension v26.2.0): alwayson script with POSITIONAL args —
  // [enable, skip_img2img, unit1, unit2, ...]. Unit keys verified against
  // /adetailer/v1/schema; keys left unset take the extension's defaults.
  // When disabled the whole alwayson_scripts.ADetailer key is OMITTED —
  // never send an args array with enable=false.
  if (p.adetailer && p.adetailer.enabled) {
    const AD = SD_SCHEMA.adetailer;
    const units = (p.adetailer.units || [])
      .filter(u => u && u.ad_model && u.ad_model !== 'None')
      .map(u => {
        const out = { ad_model: u.ad_model };
        for (const k of Object.keys(AD)) {
          if (k === 'ad_model' || k.startsWith('_')) continue;
          const v = u[k];
          if (v === undefined || v === null || v === '') continue;
          if (v === AD[k].def) continue;
          out[k] = v;
        }
        return out;
      });
    if (units.length) {
      body.alwayson_scripts = { ...(body.alwayson_scripts || {}), ADetailer: { args: [true, false, ...units] } };
    }
  }
  return body;
}

function buildImg2ImgBody(p, initB64) {
  const body = {
    ...buildTxt2ImgBody(p),
    init_images: [initB64]
  };
  // legacy short name from the panel's original slider; schema name wins
  const denoise = p.denoising_strength != null ? p.denoising_strength : p.denoise;
  if (Number.isFinite(Number(denoise))) body.denoising_strength = Number(denoise);
  applySchemaFields(body, p, SD_SCHEMA.img2img, new Set(['denoising_strength']));
  // inpaint: mask arrives as raw pixels; scale it to the source image's exact
  // dimensions, then encode. White = repaint.
  if (p.maskData && p.maskData.data) {
    const { width, height, data } = p.maskData;
    const tw = Number(p.srcW) || width;
    const th = Number(p.srcH) || height;
    body.mask = encodeMaskPng(tw, th, scaleMask(data, width, height, tw, th));
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
  detectLayout, scanCheckpoints, scanLoras, scanVae, reconcileCheckpoints,
  FORGE_ARGS, forgeSpawnEnv, spawnForge, killTree, portInUse, waitPortFree,
  encodeMaskPng, scaleMask, buildTxt2ImgBody, buildImg2ImgBody, sanitizeRequestBody, imageFileName
};
