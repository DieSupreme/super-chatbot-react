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
