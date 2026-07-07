const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

// Route pty output/exit to the right session's callback through a single shared
// listener each (instead of one ipcRenderer listener per terminal panel), keyed
// by session id. O(1) dispatch, and only two listeners total regardless of how
// many terminals are open.
const termDataCbs = new Map();
const termExitCbs = new Map();
ipcRenderer.on('term:data', (_e, { id, data }) => { const cb = termDataCbs.get(id); if (cb) cb(data); });
ipcRenderer.on('term:exit', (_e, payload) => { const cb = termExitCbs.get(payload.id); if (cb) cb(payload); });

contextBridge.exposeInMainWorld('api', {
  // key
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  loadKey: () => ipcRenderer.invoke('key:load'),
  clearKey: () => ipcRenderer.invoke('key:clear'),
  // chat
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopChat: (requestId) => ipcRenderer.invoke('chat:stop', requestId),
  onChunk: (cb) => ipcRenderer.on('chat:chunk', (_e, data) => cb(data)),
  // uploads
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  readFiles: (paths) => ipcRenderer.invoke('files:read', paths),
  // Electron 32+ removed File.path — this is the supported way to get a dropped file's disk path
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  // native clipboard (used by the embedded terminal so Ctrl+V works regardless of
  // whether an Electron edit-menu accelerator is wired up)
  readClipboard: () => { try { return clipboard.readText(); } catch (_) { return ''; } },
  writeClipboard: (t) => { try { clipboard.writeText(t); } catch (_) {} },
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
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    start: (id) => ipcRenderer.send('term:start', id),
    pickFolder: () => ipcRenderer.invoke('term:pickFolder'),
    pathExists: (p) => ipcRenderer.invoke('term:pathExists', p),
    // per-session data/exit registration; each returns a disposer that unhooks
    // just this session (no per-panel global listener).
    onData: (id, cb) => { termDataCbs.set(id, cb); return () => termDataCbs.delete(id); },
    onExit: (id, cb) => { termExitCbs.set(id, cb); return () => termExitCbs.delete(id); }
  }
});
