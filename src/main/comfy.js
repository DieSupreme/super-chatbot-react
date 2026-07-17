// IPC bridge for the ComfyUI (video) backend. Mirrors registerSdIpc: all HTTP
// and the WebSocket live here in main (renderer CSP allows no network); the
// renderer only sees window.api.comfy.*. Workflows are DATA — pairs of
// <name>.json + <name>.manifest.json in <appRoot>/workflows; adding a video
// model is a file drop, never a code change. Manifests are auto-generated
// from the workflow graph on scan (hand-written ones are left alone).
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
  let previewHintShown = false;     // the no-preview-frames nudge logs once per session
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
  // Every scan first (re)generates manifest sidecars for bare/changed .json
  // drops — content-hashed, so an unchanged file costs one read. Hand-written
  // manifests (no "generated" marker) are never touched. When ComfyUI is
  // reachable the scan feeds /object_info specs into extraction (real types,
  // ranges, combos for EVERY node — no per-type code); offline scans fall
  // back to widget markers and upgrade automatically on the first online one.
  async function syncManifests(force) {
    let serverUp = null;   // probed once per scan, not per workflow
    const getInfo = async (types) => {
      if (serverUp === null) serverUp = await probe(1200);
      if (!serverUp) return null;
      try {
        return await core.fetchTypeInfo(types, (route) => cfetch(route, { timeoutMs: 15000 }), objectInfoCache);
      } catch (_) { return null; }
    };
    const results = await core.ensureManifests(workflowsDir, { force, getInfo });
    for (const r of results) {
      if (r.action === 'fresh' || (r.action === 'manual' && !force)) continue;
      pushLog(`[app] manifest ${r.action}: ${r.name}` + (r.error ? ` (${r.error})` : ''));
    }
    return results;
  }

  ipcMain.handle('comfy:workflows', async () => {
    try {
      await syncManifests(false);
      return { ok: true, list: core.listWorkflows(workflowsDir) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('comfy:rebuildManifests', async () => {
    try { return { ok: true, results: await syncManifests(true), list: core.listWorkflows(workflowsDir) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- control overrides (the "Configure controls" picker) ----------
  // Shown/hidden + custom labels per control, keyed "<node>:<input>" in
  // workflows/control-overrides.json — applied at read time in listWorkflows,
  // so rescans and regenerations never wipe the user's choices.
  ipcMain.handle('comfy:setControlOverride', (_e, { workflow, id, hidden, label }) => {
    try {
      const patch = {};
      if (typeof hidden === 'boolean') patch.hidden = hidden;
      if (typeof label === 'string' || label === null) patch.label = label;
      const { error } = core.setControlOverride(workflowsDir, String(workflow || ''), String(id || ''), patch);
      if (error) pushLog('[app] ' + error);
      return { ok: true, list: core.listWorkflows(workflowsDir) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- working control values (the implicit per-workflow draft) ----------
  // The panel's current values, persisted so unmounts (tab switches) and app
  // restarts never lose typed state. Pruned against the live manifest on both
  // read and write so a control removed by a rescan drops silently.
  const manifestControls = (workflow) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(workflowsDir, workflow + '.manifest.json'), 'utf8'));
      return m.controls || null;
    } catch (_) { return null; }   // manifest missing/unreadable — skip pruning
  };
  ipcMain.handle('comfy:values', (_e, workflow) => {
    try {
      const wf = String(workflow || '');
      const { values, error } = core.readControlValues(workflowsDir);
      if (error) pushLog('[app] ' + error);
      const mine = values[wf] || {};
      const controls = manifestControls(wf);
      return { ok: true, values: controls ? core.pruneControlValues(mine, controls) : mine };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('comfy:valuesSave', (_e, { workflow, values }) => {
    try {
      const wf = String(workflow || '');
      const controls = manifestControls(wf);
      // stale keys drop, and so do values equal to the manifest default — the
      // draft only pins DELIBERATE deviations, so editing the workflow .json
      // later can never be shadowed by defaults captured at draft-save time
      const vals = controls
        ? core.pruneUnchangedValues(core.pruneControlValues(values || {}, controls), controls)
        : (values || {});
      const { error } = core.saveControlValues(workflowsDir, wf, vals);
      if (error) pushLog('[app] ' + error);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('comfy:valuesClear', (_e, workflow) => {
    try {
      core.clearControlValues(workflowsDir, String(workflow || ''));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ---------- prompt presets ----------
  // Named prompt snapshots, per workflow, in ONE file the workflows dir
  // already owns: workflows/prompt-presets.json. Never inside the manifests
  // (those are regenerated); a corrupt file reads as empty and is logged,
  // never fatal — the next save recreates it.
  const presetErr = (error) => { if (error) pushLog('[app] ' + error); };
  ipcMain.handle('comfy:presets', (_e, workflow) => {
    try {
      const { presets, error } = core.readPromptPresets(workflowsDir);
      presetErr(error);
      return { ok: true, presets: presets[String(workflow || '')] || [] };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('comfy:presetSave', (_e, { workflow, name, values }) => {
    try {
      const { list, error } = core.savePromptPreset(workflowsDir, String(workflow || ''), name, values || {});
      presetErr(error);
      return { ok: true, presets: list };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('comfy:presetRename', (_e, { workflow, oldName, newName }) => {
    try {
      const { list, error } = core.renamePromptPreset(workflowsDir, String(workflow || ''), oldName, newName);
      presetErr(error);
      return { ok: true, presets: list };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('comfy:presetDelete', (_e, { workflow, name }) => {
    try {
      const { list, error } = core.deletePromptPreset(workflowsDir, String(workflow || ''), name);
      presetErr(error);
      return { ok: true, presets: list };
    } catch (err) { return { ok: false, error: err.message }; }
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
      let route;   // rgthree-style names have spaces/parens — legal once encoded
      try { route = core.objectInfoRoute(key); } catch (_) { return { ok: false, error: 'bad node type' }; }
      if (!objectInfoCache.has(key)) {
        const r = await cfetch(route, { timeoutMs: 10000 });
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
    let ws = null, poll = null, sendPreview = null;
    // per-job preview evidence: frames received off the socket vs forwarded
    // to the renderer (throttled), plus whether sampling progress ever ran —
    // that combination decides the one-time "server sends no previews" hint
    const previewStats = { received: 0, forwarded: 0, bytes: 0, sampled: false };
    try {
      let { graph, manifest } = core.loadWorkflow(workflowsDir, workflow);
      // UI-format export (ComfyUI's default Ctrl+S)? Convert to API format
      // using /object_info for the widget-name order — per-type, cached.
      if (core.isUiGraph(graph)) {
        // per-type /object_info, cached; names with spaces/parens (rgthree)
        // are encoded by objectInfoRoute inside fetchTypeInfo
        const info = await core.fetchTypeInfo(core.uiGraphTypes(graph),
          (route) => cfetch(route, { timeoutMs: 15000 }), objectInfoCache);
        graph = core.uiGraphToApi(graph, info);
        pushLog(`[app] UI-format workflow converted to API format (${Object.keys(graph).length} active nodes)`);
      }
      // FIDELITY: the renderer sends its whole control state (defaults
      // included) — keep only values that differ from the manifest defaults,
      // so untouched widgets pass through the workflow file byte-identical
      const vals = core.pruneUnchangedValues({ ...values }, manifest.controls);
      // ComfyUI has no "-1 = random" — realize EVERY seed-type control here
      // (a workflow can carry several decorrelated noise streams) and report
      // them back so Regenerate can replay the exact result
      let seed = null;
      const seeds = {};
      for (const [k, ctl] of Object.entries(manifest.controls || {})) {
        if (ctl.type !== 'seed') continue;
        let v = Number(vals[k]);
        if (!Number.isFinite(v) || v < 0) v = crypto.randomInt(0, 0xffffffff);
        vals[k] = seeds[k] = v;
      }
      if (seeds.seed != null) seed = seeds.seed;
      const patched = core.patchWorkflow(graph, manifest, vals);
      const clientId = crypto.randomUUID();
      pushLog('[app] POST /prompt workflow=' + workflow + ' ' + JSON.stringify(vals));

      const nodeTitle = (id) => (patched[id] && ((patched[id]._meta && patched[id]._meta.title) || patched[id].class_type)) || id;
      // retry wrapper: if ComfyUI restarts mid-job the socket reconnects with
      // backoff, so progress/preview recover without an app restart
      // (completion is independently covered by the /history poll below)
      sendPreview = core.latestFrameThrottle((p) => {
        previewStats.forwarded++;
        send('comfy:preview', { b64: Buffer.from(p.bytes).toString('base64'), mime: p.mime });
      });
      ws = core.openWsWithRetry(baseUrl() + `/ws?clientId=${clientId}`, {
        onMessage: (msg) => {
          if (!msg || !msg.data) return;
          if (msg.type === 'executing' && msg.data.node) {
            send('comfy:progress', { phase: nodeTitle(msg.data.node), value: 0, max: 0, elapsed: (Date.now() - t0) / 1000 });
          } else if (msg.type === 'progress') {
            previewStats.sampled = true;
            send('comfy:progress', {
              phase: msg.data.node ? nodeTitle(msg.data.node) : 'sampling',
              value: msg.data.value || 0, max: msg.data.max || 0, elapsed: (Date.now() - t0) / 1000
            });
          }
        },
        // binary preview frames (needs a --preview-method that produces them —
        // absent frames simply mean no comfy:preview events); only the newest
        // frame per throttle window reaches the renderer
        onBinary: (buf) => {
          const p = core.parseBinaryPreview(buf);
          if (!p) return;
          previewStats.received++;
          previewStats.bytes += p.bytes.length;
          sendPreview(p);
        },
        onReconnect: (delay, attempt) =>
          pushLog(`[app] progress socket dropped — reconnect ${attempt} in ${Math.round(delay / 1000)}s`)
      }, { active: () => jobActive });

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
      return { ok: true, files: [{ path: full, name }], seed, seeds, elapsed, media };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return offline(err);
      return { ok: false, error: String(err && err.message || err).slice(0, 500) };
    } finally {
      if (poll) clearInterval(poll);
      if (sendPreview) sendPreview.close();
      if (ws) ws.close();
      jobActive = false;
      if (previewStats.received) {
        pushLog(`[app] preview frames: ${previewStats.received} received (${Math.round(previewStats.bytes / 1024)} KB), ${previewStats.forwarded} forwarded to panel`);
      } else if (previewStats.sampled && !previewHintShown) {
        previewHintShown = true;   // once per app session — it's a config nudge, not an error
        pushLog('[app] no live-preview frames arrived from ComfyUI — if it was started outside this app, launch it with --preview-method auto (the app\'s own Start button and the updated run_nvidia_gpu.bat both do)');
      }
      send('comfy:progress', { done: true });
    }
  });

  // ---------- fidelity dry run ----------
  // Diagnostic: the EXACT final API graph comfy:generate would POST for this
  // workflow + values, plus a diff against a pure conversion of the raw .json
  // with no app patching, and any wired inputs the converter had to drop.
  // Shares the generate path's own pruning/conversion code so it can never
  // drift from the real POST. Seed is left as sent (not realized) so the diff
  // only shows deliberate patches.
  ipcMain.handle('comfy:dryRun', async (_e, { workflow, values }) => {
    try {
      const { graph, manifest } = core.loadWorkflow(workflowsDir, String(workflow || ''));
      let info = null;
      if (core.isUiGraph(graph)) {
        info = await core.fetchTypeInfo(core.uiGraphTypes(graph),
          (route) => cfetch(route, { timeoutMs: 15000 }), objectInfoCache);
      }
      const vals = core.pruneUnchangedValues(values || {}, manifest.controls);
      const r = core.dryRunGraph(graph, manifest, vals, info);
      const unexplained = r.diff.filter(d => !d.control);
      pushLog(`[app] dry run ${workflow}: ${Object.keys(r.patched).length} nodes, ` +
        `${r.diff.length} patched input(s) (${unexplained.length} unexplained), ` +
        `${r.droppedWires.length} dropped wire(s)`);
      for (const d of r.diff) {
        pushLog(`[app]   ${d.control ? 'control "' + d.control + '"' : 'UNEXPLAINED'} ` +
          `${d.node}.${d.input} (${d.class_type || '?'}): ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
      }
      for (const w of r.droppedWires) {
        pushLog(`[app]   dropped wire: ${w.node}.${w.input} (${w.class_type}, ${w.type})`);
      }
      return { ok: true, values: vals, diff: r.diff, droppedWires: r.droppedWires, graph: r.patched };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return offline(err);
      return { ok: false, error: String(err && err.message || err).slice(0, 500) };
    }
  });

  ipcMain.handle('comfy:interrupt', async () => {
    try { const r = await cfetch('/interrupt', { method: 'POST', body: {}, timeoutMs: 5000 }); return { ok: r.ok }; }
    catch (err) { return offline(err); }
  });

  // cancel EVERYTHING: pending queue entries cleared, running job interrupted
  ipcMain.handle('comfy:cancel', async () => {
    try {
      const r = await core.cancelAll((route, opts) => cfetch(route, opts));
      pushLog(`[app] cancel: interrupted=${r.interrupted}` + (r.cleared ? ', pending queue cleared' : ''));
      return r;
    } catch (err) { return offline(err); }
  });

  // release models between image and video runs — one 10GB card
  ipcMain.handle('comfy:free', async () => {
    try {
      const r = await cfetch('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: 30000 });
      if (r.ok) pushLog('[app] /free — models unloaded, VRAM released');
      return r.ok ? { ok: true } : { ok: false, error: 'free failed (HTTP ' + r.status + ')' };
    } catch (err) { return offline(err); }
  });

  // put a local image into ComfyUI's input folder (multipart /upload/image)
  // so the workflow's LoadImage select can use it as e.g. the i2v start image
  ipcMain.handle('comfy:uploadImage', async (_e, p) => {
    try {
      const r = await core.uploadImage(baseUrl(), path.resolve(String(p || '')));
      pushLog('[app] uploaded to ComfyUI input: ' + r.name);
      return { ok: true, name: r.name };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return offline(err);
      return { ok: false, error: String(err && err.message || err).slice(0, 300) };
    }
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
