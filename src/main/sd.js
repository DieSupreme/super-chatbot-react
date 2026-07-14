// IPC bridge for the local Stable Diffusion (Forge) panel. All HTTP to Forge
// happens here in main (the renderer CSP allows no network at all); the
// renderer only sees window.api.sd.*. Mirrors the registerTerminalIpc pattern.
const { ipcMain, app: electronApp, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./sd-core.js');
const SD_DEFAULTS = require('../sd-defaults.json');

const LOG_CAP = 500;

function registerSdIpc(app, getWin) {
  const settingsFile = path.join(electronApp.getPath('userData'), 'settings.json');

  // sdForgeUrl / sdForgePath / sdImageDir live in the one settings.json the
  // rest of the app uses; defaults come from sd-defaults.json (single source).
  function readSettings() {
    let s = {};
    try { if (fs.existsSync(settingsFile)) s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) {}
    return { ...SD_DEFAULTS, ...s };
  }
  const baseUrl = () => String(readSettings().sdForgeUrl || SD_DEFAULTS.sdForgeUrl).replace(/\/+$/, '');

  function send(channel, payload) {
    const w = (typeof getWin === 'function' && getWin()) || BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  // ---------- HTTP ----------
  async function sdFetch(route, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    return fetch(baseUrl() + route, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  }
  const offline = (err) => ({
    ok: false, offline: true, url: baseUrl(),
    error: `Forge not reachable at ${baseUrl()}` + (err && err.name === 'TimeoutError' ? ' (timed out)' : '')
  });

  async function getJson(route, timeoutMs = 10000) {
    try {
      const res = await sdFetch(route, { timeoutMs });
      if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
      return { ok: true, data: await res.json() };
    } catch (err) { return offline(err); }
  }

  // ---------- process state ----------
  let proc = null;             // child we spawned (null if Forge wasn't started by us)
  let status = 'stopped';      // 'stopped' | 'starting' | 'running'
  let startTimer = null;
  const logRing = [];

  function setStatus(next, message) {
    if (status === next && !message) return;
    if (next === 'running' && status !== 'running') listsCache = null;   // fresh Forge, fresh lists
    status = next;
    send('sd:status', { status, url: baseUrl(), managed: !!proc, ...(message ? { message } : {}) });
  }
  function pushLog(line) {
    logRing.push(line);
    if (logRing.length > LOG_CAP) logRing.splice(0, logRing.length - LOG_CAP);
    send('sd:log', { line });
  }
  function stopStartPoll() { if (startTimer) { clearInterval(startTimer); startTimer = null; } }

  // Is anything answering on the Forge URL? /internal/ping first, /progress as fallback.
  async function probe(timeoutMs = 1000) {
    for (const route of ['/internal/ping', '/sdapi/v1/progress?skip_current_image=true']) {
      try { if ((await sdFetch(route, { timeoutMs })).ok) return true; } catch (_) {}
    }
    return false;
  }

  function urlHostPort() {
    try { const u = new URL(baseUrl()); return { host: u.hostname, port: Number(u.port) || 7860 }; }
    catch (_) { return { host: '127.0.0.1', port: 7860 }; }
  }

  // ---------- status / start / stop ----------
  ipcMain.handle('sd:status', async () => {
    const up = await probe();
    if (up) { stopStartPoll(); setStatus('running'); }
    else if (status !== 'starting') setStatus('stopped');
    const s = readSettings();
    return { ok: true, status, url: baseUrl(), managed: !!proc, forgePath: s.sdForgePath, log: logRing.slice(-150) };
  });

  ipcMain.handle('sd:start', async () => {
    if (status === 'running') return { ok: true, status };
    if (proc) return { ok: true, status: 'starting' };
    const root = readSettings().sdForgePath;
    if (!fs.existsSync(root)) return { ok: false, error: `Forge install not found at ${root}` };
    try {
      proc = core.spawnForge(root);
    } catch (err) { proc = null; return { ok: false, error: err.message }; }
    pushLog(`[app] spawn: ${proc.spawnargs.join(' ')} (cwd=${root}, COMMANDLINE_ARGS=${core.FORGE_ARGS}, SD_WEBUI_RESTARTING=1)`);
    setStatus('starting');

    let buf = { out: '', err: '' };
    const onChunk = (key) => (d) => {
      buf[key] += d.toString();
      let i;
      while ((i = buf[key].indexOf('\n')) >= 0) {
        const line = buf[key].slice(0, i).replace(/\r$/, '');
        buf[key] = buf[key].slice(i + 1);
        if (line.trim()) pushLog(line);
      }
    };
    proc.stdout.on('data', onChunk('out'));
    proc.stderr.on('data', onChunk('err'));
    proc.on('exit', (code) => {
      pushLog(`[app] Forge process exited (code ${code})`);
      proc = null;
      stopStartPoll();
      setStatus('stopped');
    });

    // Forge takes 30-90s; poll every 2s, give up flagging after 120s. Never blocks.
    const t0 = Date.now();
    stopStartPoll();
    startTimer = setInterval(async () => {
      if (await probe(1500)) { stopStartPoll(); setStatus('running'); pushLog('[app] Forge API is ready'); return; }
      if (Date.now() - t0 > 120000) {
        stopStartPoll();
        pushLog('[app] Forge did not become ready within 120s — check the log above');
        setStatus('stopped', 'Forge did not become ready within 120s');
      }
    }, 2000);
    return { ok: true, status: 'starting' };
  });

  async function stopForge() {
    if (!proc) return { ok: false, error: 'Forge was not started by this app' };
    const pid = proc.pid;
    pushLog(`[app] stopping Forge (pid ${pid})`);
    core.killTree(pid);
    proc = null;
    stopStartPoll();
    const { host, port } = urlHostPort();
    const portFree = await core.waitPortFree(host, port);
    pushLog(portFree ? '[app] Forge stopped, port free' : `[app] WARNING: port ${port} still in use after kill`);
    setStatus('stopped');
    return { ok: true, portFree };
  }
  ipcMain.handle('sd:stop', () => stopForge());

  // Never leave an orphaned python holding 7860. Synchronous taskkill so it
  // completes even as the app tears down (pty.js defers quit once, so this can
  // run on either pass — proc is null on the second).
  app.on('before-quit', () => {
    if (proc) { try { core.killTree(proc.pid); } catch (_) {} proc = null; }
  });

  // ---------- model / sampler lists ----------
  ipcMain.handle('sd:models', () => getJson('/sdapi/v1/sd-models'));
  ipcMain.handle('sd:samplers', () => getJson('/sdapi/v1/samplers'));

  // Dropdown sources, one round trip for the renderer. Cached until Forge
  // (re)starts or sd:refresh clears it. /sdapi/v1/sd-vae and /loras are 404 in
  // Forge f2.0.1 — VAE/LoRA pickers come from disk scans instead (sd:scanVae /
  // sd:scanLoras), so they are deliberately absent here.
  let listsCache = null;
  const LIST_ROUTES = {
    samplers: '/sdapi/v1/samplers',
    schedulers: '/sdapi/v1/schedulers',
    upscalers: '/sdapi/v1/upscalers',
    latentUpscaleModes: '/sdapi/v1/latent-upscale-modes',
    models: '/sdapi/v1/sd-models',
    styles: '/sdapi/v1/prompt-styles'
  };
  ipcMain.handle('sd:lists', async (_e, force) => {
    if (listsCache && !force) return listsCache;
    const keys = Object.keys(LIST_ROUTES);
    const results = await Promise.all(keys.map(k => getJson(LIST_ROUTES[k])));
    if (results.every(r => !r.ok)) return results[0];   // Forge down -> one offline error
    const out = { ok: true };
    keys.forEach((k, i) => { out[k] = results[i].ok ? results[i].data : []; });
    listsCache = out;
    return out;
  });

  // POST refresh-* so models added on disk appear without a Forge restart,
  // then drop the cache. refresh-vae/-loras may not exist in every build —
  // best effort, never an error.
  ipcMain.handle('sd:refreshLists', async () => {
    for (const route of ['/sdapi/v1/refresh-checkpoints', '/sdapi/v1/refresh-vae', '/sdapi/v1/refresh-loras']) {
      try { await sdFetch(route, { method: 'POST', body: {}, timeoutMs: 30000 }); } catch (_) {}
    }
    listsCache = null;
    return { ok: true };
  });

  ipcMain.handle('sd:getOptions', async () => {
    const r = await getJson('/sdapi/v1/options');
    if (!r.ok) return r;
    return {
      ok: true,
      checkpoint: r.data.sd_model_checkpoint || '',
      vae: r.data.sd_vae,
      clipSkip: r.data.CLIP_stop_at_last_layers
    };
  });

  // PNG-info: recover the generation parameters embedded in a Forge PNG
  ipcMain.handle('sd:pngInfo', async (_e, b64) => {
    try {
      const res = await sdFetch('/sdapi/v1/png-info', {
        method: 'POST', body: { image: 'data:image/png;base64,' + String(b64 || '') }, timeoutMs: 30000
      });
      if (!res.ok) return { ok: false, status: res.status, error: apiErrorText((await res.text()).slice(0, 800)).slice(0, 500) };
      const data = await res.json();
      return { ok: true, info: data.info || '', items: data.items || {} };
    } catch (err) { return offline(err); }
  });
  ipcMain.handle('sd:setModel', async (_e, title) => {
    try {
      // switching checkpoints loads gigabytes — allow plenty of time
      const res = await sdFetch('/sdapi/v1/options', {
        method: 'POST', body: { sd_model_checkpoint: title }, timeoutMs: 180000
      });
      if (!res.ok) return { ok: false, status: res.status, error: apiErrorText((await res.text()).slice(0, 800)).slice(0, 500) };
      return { ok: true };
    } catch (err) { return offline(err); }
  });

  ipcMain.handle('sd:scanCheckpoints', () => {
    const layout = core.detectLayout(readSettings().sdForgePath);
    try { return { ok: true, list: core.scanCheckpoints(layout.base), base: layout.base }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('sd:scanLoras', () => {
    const layout = core.detectLayout(readSettings().sdForgePath);
    try { return { ok: true, list: core.scanLoras(layout.base) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('sd:scanVae', () => {
    const layout = core.detectLayout(readSettings().sdForgePath);
    try { return { ok: true, list: core.scanVae(layout.base) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- generation ----------
  let jobActive = false;

  // Forge can return 200 with the real story tucked into the `info` JSON string.
  function parseInfo(infoStr) {
    try { return JSON.parse(infoStr); } catch (_) { return null; }
  }

  // Forge error payloads spread the story across error/detail/message
  // (e.g. {"error":"RuntimeError","detail":"","message":"model '…' not found"}).
  // Join the human-readable parts instead of dumping raw JSON at the user.
  function apiErrorText(raw) {
    try {
      const j = JSON.parse(raw);
      const parts = [j.error, j.detail, j.message].filter(v => v && typeof v === 'string');
      if (parts.length) return parts.join(': ');
      if (j.errors) return typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors);
    } catch (_) {}
    return raw;
  }

  // dev-console visibility of exactly what goes to Forge, minus the pixels
  function sanitizeBody(b) {
    const out = { ...b };
    if (out.init_images) out.init_images = out.init_images.map(s => `<base64 ${s.length} chars>`);
    if (out.mask) out.mask = `<base64 png ${out.mask.length} chars>`;
    return out;
  }

  async function runJob(route, body) {
    if (jobActive) return { ok: false, error: 'a generation is already running' };
    jobActive = true;
    // Forge restore bug workaround (processing.py:820): stored_opts only keeps
    // override keys already present in opts.data, so an option still at its
    // default is skipped by the restore and the override sticks permanently.
    // POSTing the current values first puts the keys into opts.data, which
    // arms Forge's own override_settings_restore_afterwards path.
    if (body.override_settings) {
      try {
        const cur = await sdFetch('/sdapi/v1/options', { timeoutMs: 10000 });
        if (cur.ok) {
          const opts = await cur.json();
          const preSeed = {};
          for (const k of Object.keys(body.override_settings)) if (k in opts) preSeed[k] = opts[k];
          if (Object.keys(preSeed).length) {
            await sdFetch('/sdapi/v1/options', { method: 'POST', body: preSeed, timeoutMs: 30000 });
          }
        }
      } catch (_) {}
    }
    // the resolved request body, visible in the panel's Forge log (minus pixels)
    pushLog('[app] POST ' + route + ' ' + JSON.stringify(sanitizeBody(body)));
    // progress: main polls, renderer just listens to sd:progress events
    const poll = setInterval(async () => {
      try {
        const res = await sdFetch('/sdapi/v1/progress?skip_current_image=true', { timeoutMs: 1500 });
        if (res.ok) {
          const j = await res.json();
          send('sd:progress', { progress: j.progress || 0, eta: j.eta_relative || 0 });
        }
      } catch (_) {}
    }, 500);
    try {
      const res = await sdFetch(route, { method: 'POST', body, timeoutMs: 600000 });
      if (!res.ok) {
        const msg = apiErrorText((await res.text()).slice(0, 800));
        return { ok: false, status: res.status, error: msg.slice(0, 500) };
      }
      const data = await res.json();
      const info = parseInfo(data.info);
      if (info && info.error) return { ok: false, error: String(info.error).slice(0, 500) + (info.detail ? ': ' + String(info.detail).slice(0, 300) : '') };
      if (!data.images || !data.images.length) {
        return { ok: false, error: 'Forge returned no image' + (typeof data.info === 'string' && data.info ? ` — info: ${data.info.slice(0, 300)}` : '') };
      }
      const seed = info && info.seed != null ? info.seed : body.seed;
      const dir = readSettings().sdImageDir;
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      for (const b64 of data.images) {
        const name = core.imageFileName(dir, seed);
        const full = path.join(dir, name);
        fs.writeFileSync(full, Buffer.from(b64, 'base64'));
        files.push({ path: full, name });
      }
      return { ok: true, files, seed, info: info ? { seed: info.seed, sampler: info.sampler_name, model: info.sd_model_name } : null };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return offline(err);
      return { ok: false, error: err.message };
    } finally {
      clearInterval(poll);
      jobActive = false;
      send('sd:progress', { progress: 0, eta: 0, done: true });
    }
  }

  ipcMain.handle('sd:txt2img', (_e, p) => runJob('/sdapi/v1/txt2img', core.buildTxt2ImgBody(p)));

  ipcMain.handle('sd:img2img', async (_e, p) => {
    let initB64 = p.initB64 || '';
    if (!initB64 && p.initPath) {
      try { initB64 = fs.readFileSync(p.initPath).toString('base64'); }
      catch (err) { return { ok: false, error: 'could not read source image: ' + err.message }; }
    }
    if (!initB64) return { ok: false, error: 'no source image' };
    // buildImg2ImgBody scales the mask to the source image's exact dimensions
    // (srcW/srcH) and encodes the black/white PNG; white = repaint.
    let body;
    try { body = core.buildImg2ImgBody(p, initB64); }
    catch (err) { return { ok: false, error: 'bad mask: ' + err.message }; }
    return runJob('/sdapi/v1/img2img', body);
  });

  ipcMain.handle('sd:interrupt', async () => {
    try {
      const res = await sdFetch('/sdapi/v1/interrupt', { method: 'POST', body: {}, timeoutMs: 5000 });
      return { ok: res.ok };
    } catch (err) { return offline(err); }
  });

  // ---------- read a generated image back for display ----------
  // Only serves files inside sdImageDir — the renderer can't use this to read
  // arbitrary disk paths.
  ipcMain.handle('sd:readImage', (_e, p) => {
    try {
      const dir = path.resolve(readSettings().sdImageDir);
      const full = path.resolve(String(p || ''));
      if (full !== dir && !full.startsWith(dir + path.sep)) return { ok: false, error: 'not in the image directory' };
      return { ok: true, b64: fs.readFileSync(full).toString('base64'), mime: 'image/png' };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { registerSdIpc };
