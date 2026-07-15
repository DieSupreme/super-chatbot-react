// IPC bridge for the ComfyUI (video) backend. Mirrors registerSdIpc: all HTTP
// and the WebSocket live here in main (renderer CSP allows no network); the
// renderer only sees window.api.comfy.*. Workflows are DATA — pairs of
// <name>.json + <name>.manifest.json in <appRoot>/workflows; adding a video
// model is a file drop, never a code change.
const { ipcMain, app: electronApp, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const core = require('./comfy-core.js');
const sdCore = require('./sd-core.js');            // killTree / waitPortFree / portInUse
const gpuLock = require('./gpu-lock.js');
const SD_DEFAULTS = require('../sd-defaults.json');

const LOG_CAP = 500;

function registerComfyIpc(app, getWin) {
  const settingsFile = path.join(electronApp.getPath('userData'), 'settings.json');
  const workflowsDir = path.join(electronApp.getAppPath(), 'workflows');

  function readSettings() {
    let s = {};
    try { if (fs.existsSync(settingsFile)) s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) {}
    return { ...SD_DEFAULTS, ...s };
  }
  const baseUrl = () => String(readSettings().comfyUrl || SD_DEFAULTS.comfyUrl).replace(/\/+$/, '');
  const urlHostPort = () => {
    try { const u = new URL(baseUrl()); return { host: u.hostname, port: Number(u.port) || 8188 }; }
    catch (_) { return { host: '127.0.0.1', port: 8188 }; }
  };

  function send(channel, payload) {
    const w = (typeof getWin === 'function' && getWin()) || BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  async function cfetch(route, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    return fetch(baseUrl() + route, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  }
  const offline = (err) => ({
    ok: false, offline: true, url: baseUrl(),
    error: `ComfyUI not reachable at ${baseUrl()}` + (err && err.name === 'TimeoutError' ? ' (timed out)' : '')
  });

  // ---------- process state ----------
  let proc = null;
  let status = 'stopped';           // 'stopped' | 'starting' | 'running'
  let startTimer = null;
  let jobActive = false;
  const logRing = [];

  function setStatus(next, message) {
    if (status === next && !message) return;
    status = next;
    send('comfy:status', { status, url: baseUrl(), managed: !!proc, ...(message ? { message } : {}) });
  }
  function pushLog(line) {
    logRing.push(line);
    if (logRing.length > LOG_CAP) logRing.splice(0, logRing.length - LOG_CAP);
    send('comfy:log', { line });
  }
  function stopStartPoll() { if (startTimer) { clearInterval(startTimer); startTimer = null; } }

  async function probe(timeoutMs = 1000) {
    try { return (await cfetch('/system_stats', { timeoutMs })).ok; } catch (_) { return false; }
  }

  async function stopComfy() {
    stopStartPoll();
    objectInfoCache.clear();          // node list can differ on next boot
    if (proc) {
      const pid = proc.pid;
      pushLog(`[app] stopping ComfyUI (pid ${pid})`);
      sdCore.killTree(pid);                 // taskkill /T /F — a plain kill orphans python on 8188
      proc = null;
    }
    const { host, port } = urlHostPort();
    const portFree = await sdCore.waitPortFree(host, port);
    pushLog(portFree ? '[app] ComfyUI stopped, port free' : `[app] WARNING: port ${port} still in use after kill`);
    setStatus('stopped');
    return { ok: true, portFree };
  }

  // mutual exclusion: one GPU, one backend at a time
  gpuLock.register('ComfyUI', {
    stop: stopComfy,
    isBusy: () => jobActive,
    isRunning: () => status !== 'stopped' || !!proc
  });

  // ---------- status / start / stop ----------
  ipcMain.handle('comfy:status', async () => {
    const up = await probe();
    if (up) { stopStartPoll(); setStatus('running'); }
    else if (status !== 'starting') setStatus('stopped');
    const s = readSettings();
    return { ok: true, status, url: baseUrl(), managed: !!proc, comfyPath: s.comfyPath, log: logRing.slice(-150) };
  });

  ipcMain.handle('comfy:start', async () => {
    if (status === 'running') return { ok: true, status };
    if (proc) return { ok: true, status: 'starting' };
    const root = readSettings().comfyPath;
    if (!fs.existsSync(root)) return { ok: false, error: `ComfyUI install not found at ${root}` };
    try {
      await gpuLock.claim('ComfyUI');       // stops Forge; throws if Forge is mid-generation
    } catch (err) { return { ok: false, error: err.message }; }
    try {
      proc = core.spawnComfy(root, urlHostPort().port);
    } catch (err) { proc = null; return { ok: false, error: err.message }; }
    pushLog(`[app] spawn: ${proc.spawnargs.join(' ')} (cwd=${root})`);
    objectInfoCache.clear();
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
      pushLog(`[app] ComfyUI process exited (code ${code})`);
      proc = null;
      stopStartPoll();
      setStatus('stopped');
    });

    const t0 = Date.now();
    stopStartPoll();
    startTimer = setInterval(async () => {
      if (await probe(1500)) { stopStartPoll(); setStatus('running'); pushLog('[app] ComfyUI API is ready'); return; }
      if (Date.now() - t0 > 120000) {
        stopStartPoll();
        pushLog('[app] ComfyUI did not become ready within 120s — check the log above');
        setStatus('stopped', 'ComfyUI did not become ready within 120s');
      }
    }, 2000);
    return { ok: true, status: 'starting' };
  });

  ipcMain.handle('comfy:stop', () => stopComfy());

  // never leave an orphaned python holding 8188
  app.on('before-quit', () => {
    if (proc) { try { sdCore.killTree(proc.pid); } catch (_) {} proc = null; }
  });

  // ---------- workflows (data, not code) ----------
  ipcMain.handle('comfy:workflows', () => {
    try { return { ok: true, list: core.listWorkflows(workflowsDir) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- live dropdown options ----------
  // Manifests declare "options_from": "object_info:<NodeType>:<input>" —
  // resolved here against ComfyUI's /object_info/<NodeType> so sampler /
  // scheduler / model-file lists are never hardcoded. Cached per node type;
  // the cache drops whenever the server (re)starts or stops.
  const objectInfoCache = new Map();
  ipcMain.handle('comfy:objectInfo', async (_e, { nodeType, input }) => {
    try {
      const key = String(nodeType || '');
      if (!key || /[^\w.-]/.test(key)) return { ok: false, error: 'bad node type' };
      if (!objectInfoCache.has(key)) {
        const r = await cfetch('/object_info/' + encodeURIComponent(key), { timeoutMs: 10000 });
        if (!r.ok) return { ok: false, error: `object_info ${key}: HTTP ${r.status}` };
        objectInfoCache.set(key, await r.json());
      }
      return { ok: true, options: core.objectInfoOptions(objectInfoCache.get(key), key, String(input || '')) };
    } catch (err) { return offline(err); }
  });

  // ---------- generation ----------
  // Submit the patched graph, follow progress over the WS, poll /history as a
  // dropped-socket fallback, then pull the file via /view and save it next to
  // the images with the vid-* naming convention.
  ipcMain.handle('comfy:generate', async (_e, { workflow, values }) => {
    if (jobActive) return { ok: false, error: 'a generation is already running' };
    jobActive = true;
    const t0 = Date.now();
    let ws = null, poll = null;
    try {
      let { graph, manifest } = core.loadWorkflow(workflowsDir, workflow);
      // UI-format export (ComfyUI's default Ctrl+S)? Convert to API format
      // using /object_info for the widget-name order — per-type, cached.
      if (core.isUiGraph(graph)) {
        const info = {};
        for (const t of core.uiGraphTypes(graph)) {
          if (/[^\w.-]/.test(t)) throw new Error(`workflow node type "${t}" has a name /object_info cannot serve`);
          if (!objectInfoCache.has(t)) {
            const r = await cfetch('/object_info/' + encodeURIComponent(t), { timeoutMs: 15000 });
            if (!r.ok) throw new Error(`object_info ${t}: HTTP ${r.status}`);
            objectInfoCache.set(t, await r.json());
          }
          Object.assign(info, objectInfoCache.get(t));
        }
        graph = core.uiGraphToApi(graph, info);
        pushLog(`[app] UI-format workflow converted to API format (${Object.keys(graph).length} active nodes)`);
      }
      const vals = { ...values };
      // ComfyUI has no "-1 = random" — realize the seed here and report it back
      let seed = null;
      if (manifest.controls && manifest.controls.seed) {
        seed = Number(vals.seed);
        if (!Number.isFinite(seed) || seed < 0) seed = crypto.randomInt(0, 0xffffffff);
        vals.seed = seed;
      }
      const patched = core.patchWorkflow(graph, manifest, vals);
      const clientId = crypto.randomUUID();
      pushLog('[app] POST /prompt workflow=' + workflow + ' ' + JSON.stringify(vals));

      const nodeTitle = (id) => (patched[id] && ((patched[id]._meta && patched[id]._meta.title) || patched[id].class_type)) || id;
      ws = core.openWs(baseUrl().replace(/^http/, 'http') + `/ws?clientId=${clientId}`, {
        onMessage: (msg) => {
          if (!msg || !msg.data) return;
          if (msg.type === 'executing' && msg.data.node) {
            send('comfy:progress', { phase: nodeTitle(msg.data.node), value: 0, max: 0, elapsed: (Date.now() - t0) / 1000 });
          } else if (msg.type === 'progress') {
            send('comfy:progress', {
              phase: msg.data.node ? nodeTitle(msg.data.node) : 'sampling',
              value: msg.data.value || 0, max: msg.data.max || 0, elapsed: (Date.now() - t0) / 1000
            });
          }
        }
      });

      const res = await cfetch('/prompt', { method: 'POST', body: { prompt: patched, client_id: clientId }, timeoutMs: 30000 });
      if (!res.ok) {
        let msg = (await res.text()).slice(0, 800);
        try { const j = JSON.parse(msg); msg = (j.error && (j.error.message + ' ' + JSON.stringify(j.node_errors || {}))) || msg; } catch (_) {}
        return { ok: false, status: res.status, error: msg.slice(0, 500) };
      }
      const { prompt_id: promptId } = await res.json();

      // completion: poll /history — works whether or not the WS survives
      const history = await new Promise((resolve, reject) => {
        let done = false;
        poll = setInterval(async () => {
          if (done) return;
          try {
            const h = await cfetch(`/history/${promptId}`, { timeoutMs: 5000 });
            if (!h.ok) return;
            const j = await h.json();
            const entry = j[promptId];
            if (!entry) return;
            const st = entry.status || {};
            if (st.status_str === 'error') {
              done = true;
              const errMsg = (entry.status.messages || [])
                .filter(m => m[0] === 'execution_error')
                .map(m => (m[1] && (m[1].exception_message || '')).slice(0, 300)).join('; ');
              reject(new Error(errMsg || 'workflow execution failed'));
            } else if (entry.outputs && Object.keys(entry.outputs).length) {
              done = true;
              resolve(entry);
            }
          } catch (_) {}
        }, 1500);
      });

      // find THE result file — the manifest can pin the SaveImage node whose
      // files count ("output": "<node id>"); multi-stage pipelines also save
      // intermediates and those must never win
      const media = core.workflowMedia(manifest);
      const { pick, fallback } = core.pickHistoryOutput(history.outputs, media, manifest.output);
      if (fallback) pushLog(`[app] WARNING: manifest output node ${manifest.output} produced no files — using all outputs`);
      if (!pick) return { ok: false, error: 'workflow finished but produced no files' };

      const q = new URLSearchParams({ filename: pick.filename, subfolder: pick.subfolder || '', type: pick.type || 'output' });
      const fileRes = await cfetch('/view?' + q.toString(), { timeoutMs: 120000 });
      if (!fileRes.ok) return { ok: false, error: 'could not fetch output file (' + fileRes.status + ')' };
      const bytes = Buffer.from(await fileRes.arrayBuffer());

      const dir = readSettings().sdImageDir;
      fs.mkdirSync(dir, { recursive: true });
      const ext = (pick.filename.split('.').pop() || (media === 'image' ? 'png' : 'mp4')).toLowerCase();
      const name = core.mediaFileName(dir, seed, ext, media === 'image' ? 'img' : 'vid');
      const full = path.join(dir, name);
      fs.writeFileSync(full, bytes);
      const elapsed = (Date.now() - t0) / 1000;
      pushLog(`[app] ${media} saved: ${full} (${Math.round(bytes.length / 1024)} KB, ${elapsed.toFixed(1)}s)`);
      return { ok: true, files: [{ path: full, name }], seed, elapsed, media };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return offline(err);
      return { ok: false, error: String(err && err.message || err).slice(0, 500) };
    } finally {
      if (poll) clearInterval(poll);
      if (ws) ws.close();
      jobActive = false;
      send('comfy:progress', { done: true });
    }
  });

  ipcMain.handle('comfy:interrupt', async () => {
    try { const r = await cfetch('/interrupt', { method: 'POST', body: {}, timeoutMs: 5000 }); return { ok: r.ok }; }
    catch (err) { return offline(err); }
  });

  // read a saved video back for inline playback — restricted to sdImageDir,
  // same containment rule as sd:readImage
  ipcMain.handle('comfy:readVideo', (_e, p) => {
    try {
      const dir = path.resolve(readSettings().sdImageDir);
      const full = path.resolve(String(p || ''));
      if (full !== dir && !full.startsWith(dir + path.sep)) return { ok: false, error: 'not in the output directory' };
      const ext = (full.split('.').pop() || '').toLowerCase();
      const mime = ext === 'webm' ? 'video/webm' : ext === 'webp' ? 'image/webp' : 'video/mp4';
      return { ok: true, b64: fs.readFileSync(full).toString('base64'), mime };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { registerComfyIpc };
