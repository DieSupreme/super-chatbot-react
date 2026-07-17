const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Route pty output/exit to the right session's callback through a single shared
// listener each (instead of one ipcRenderer listener per terminal panel), keyed
// by session id. O(1) dispatch, and only two listeners total regardless of how
// many terminals are open.
const termDataCbs = new Map();   // id -> Set<callback>
const termExitCbs = new Map();
ipcRenderer.on('term:data', (_e, { id, data }) => {
  const cbs = termDataCbs.get(id);
  if (cbs) for (const cb of cbs) cb(data);
});
ipcRenderer.on('term:exit', (_e, payload) => {
  const cbs = termExitCbs.get(payload.id);
  if (cbs) for (const cb of cbs) cb(payload);
});

contextBridge.exposeInMainWorld('api', {
  // key
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  loadKey: () => ipcRenderer.invoke('key:load'),
  clearKey: () => ipcRenderer.invoke('key:clear'),
  // chat
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopChat: (requestId) => ipcRenderer.invoke('chat:stop', requestId),
  onChunk: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('chat:chunk', handler);
    return () => ipcRenderer.removeListener('chat:chunk', handler);
  },
  // uploads
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  readFiles: (paths) => ipcRenderer.invoke('files:read', paths),
  // Electron 32+ removed File.path — this is the supported way to get a dropped file's disk path
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  // native clipboard (used by the embedded terminal so Ctrl+C/Ctrl+V work
  // regardless of whether an Electron edit-menu accelerator is wired up). The
  // `clipboard` module is not exposed to sandboxed preloads, so hop to main:
  // read is synchronous (the caller uses the value inline), write is send-only.
  readClipboard: () => { try { return ipcRenderer.sendSync('clipboard:read'); } catch (_) { return ''; } },
  writeClipboard: (t) => { try { ipcRenderer.send('clipboard:write', t); } catch (_) {} },
  // allow-list editing
  allowList: () => ipcRenderer.invoke('allow:list'),
  allowAdd: () => ipcRenderer.invoke('allow:add'),
  allowRemove: (p) => ipcRenderer.invoke('allow:remove', p),
  allowRead: (p) => ipcRenderer.invoke('allow:read', p),
  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),
  // conversations
  convoList: () => ipcRenderer.invoke('convo:list'),
  convoGet: (id) => ipcRenderer.invoke('convo:get', id),
  convoSave: (convo) => ipcRenderer.invoke('convo:save', convo),
  convoDelete: (id) => ipcRenderer.invoke('convo:delete', id),
  // file output
  saveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  saveZip: (payload) => ipcRenderer.invoke('file:saveZip', payload),
  // image generation
  generateImage: (payload) => ipcRenderer.invoke('image:generate', payload),
  saveImage: (payload) => ipcRenderer.invoke('image:save', payload),
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  // local Stable Diffusion via Forge — all HTTP happens in main; the renderer
  // CSP allows no network. Progress/log/status arrive as events, not polling.
  sd: {
    status: () => ipcRenderer.invoke('sd:status'),
    start: () => ipcRenderer.invoke('sd:start'),
    stop: () => ipcRenderer.invoke('sd:stop'),
    txt2img: (p) => ipcRenderer.invoke('sd:txt2img', p),
    img2img: (p) => ipcRenderer.invoke('sd:img2img', p),
    interrupt: () => ipcRenderer.invoke('sd:interrupt'),
    models: () => ipcRenderer.invoke('sd:models'),
    samplers: () => ipcRenderer.invoke('sd:samplers'),
    lists: (force) => ipcRenderer.invoke('sd:lists', force),
    refreshLists: () => ipcRenderer.invoke('sd:refreshLists'),
    pngInfo: (b64) => ipcRenderer.invoke('sd:pngInfo', b64),
    adModels: () => ipcRenderer.invoke('sd:adModels'),
    getOptions: () => ipcRenderer.invoke('sd:getOptions'),
    setModel: (title) => ipcRenderer.invoke('sd:setModel', title),
    scanCheckpoints: () => ipcRenderer.invoke('sd:scanCheckpoints'),
    scanLoras: () => ipcRenderer.invoke('sd:scanLoras'),
    scanVae: () => ipcRenderer.invoke('sd:scanVae'),
    readImage: (p) => ipcRenderer.invoke('sd:readImage', p),
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('sd:progress', h);
      return () => ipcRenderer.removeListener('sd:progress', h);
    },
    onLog: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('sd:log', h);
      return () => ipcRenderer.removeListener('sd:log', h);
    },
    onStatus: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('sd:status', h);
      return () => ipcRenderer.removeListener('sd:status', h);
    }
  },
  // ComfyUI backend (image + video workflows) — all HTTP and the progress
  // WebSocket live in main
  comfy: {
    status: () => ipcRenderer.invoke('comfy:status'),
    start: () => ipcRenderer.invoke('comfy:start'),
    stop: () => ipcRenderer.invoke('comfy:stop'),
    workflows: () => ipcRenderer.invoke('comfy:workflows'),
    rebuildManifests: () => ipcRenderer.invoke('comfy:rebuildManifests'),
    // control picker — shown/hidden + label overrides in workflows/control-overrides.json
    setControlOverride: (p) => ipcRenderer.invoke('comfy:setControlOverride', p),
    objectInfo: (nodeType, input) => ipcRenderer.invoke('comfy:objectInfo', { nodeType, input }),
    // working draft values — per-workflow last-used control values in workflows/control-values.json
    values: (workflow) => ipcRenderer.invoke('comfy:values', workflow),
    valuesSave: (p) => ipcRenderer.invoke('comfy:valuesSave', p),
    valuesClear: (workflow) => ipcRenderer.invoke('comfy:valuesClear', workflow),
    // prompt presets — per-workflow saved prompt values in workflows/prompt-presets.json
    presets: (workflow) => ipcRenderer.invoke('comfy:presets', workflow),
    presetSave: (p) => ipcRenderer.invoke('comfy:presetSave', p),
    presetRename: (p) => ipcRenderer.invoke('comfy:presetRename', p),
    presetDelete: (p) => ipcRenderer.invoke('comfy:presetDelete', p),
    generate: (p) => ipcRenderer.invoke('comfy:generate', p),
    // fidelity diagnostic: exact graph generate would POST + diff vs the raw
    // .json's pure conversion (report lands in the ComfyUI log panel too)
    dryRun: (p) => ipcRenderer.invoke('comfy:dryRun', p),
    interrupt: () => ipcRenderer.invoke('comfy:interrupt'),
    cancel: () => ipcRenderer.invoke('comfy:cancel'),
    free: () => ipcRenderer.invoke('comfy:free'),
    uploadImage: (p) => ipcRenderer.invoke('comfy:uploadImage', p),
    readVideo: (p) => ipcRenderer.invoke('comfy:readVideo', p),
    onPreview: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('comfy:preview', h);
      return () => ipcRenderer.removeListener('comfy:preview', h);
    },
    onProgress: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('comfy:progress', h);
      return () => ipcRenderer.removeListener('comfy:progress', h);
    },
    onLog: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('comfy:log', h);
      return () => ipcRenderer.removeListener('comfy:log', h);
    },
    onStatus: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('comfy:status', h);
      return () => ipcRenderer.removeListener('comfy:status', h);
    }
  },
  // embedded terminal (node-pty lives only in main; this is the whole surface)
  term: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    reattach: (id) => ipcRenderer.invoke('term:reattach', id),
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    detach: (id) => ipcRenderer.send('term:detach', id),
    list: () => ipcRenderer.invoke('term:list'),
    setPinned: (id, pinned) => ipcRenderer.invoke('term:setPinned', { id, pinned }),
    quitAll: () => ipcRenderer.invoke('term:quitAll'),
    pickFolder: () => ipcRenderer.invoke('term:pickFolder'),
    pathExists: (p) => ipcRenderer.invoke('term:pathExists', p),
    // per-session data/exit registration; each returns a disposer.
    onData: (id, cb) => {
      if (!termDataCbs.has(id)) termDataCbs.set(id, new Set());
      termDataCbs.get(id).add(cb);
      return () => { termDataCbs.get(id)?.delete(cb); };
    },
    onExit: (id, cb) => {
      if (!termExitCbs.has(id)) termExitCbs.set(id, new Set());
      termExitCbs.get(id).add(cb);
      return () => { termExitCbs.get(id)?.delete(cb); };
    }
  }
});
