// The preload script exposes window.api (contextBridge). This module is the
// single import point so components never touch window.api directly, and so
// the app fails loudly (with a stub) if opened outside Electron.
const stubFn = () => {
  console.warn('window.api called outside Electron');
  return Promise.resolve({ ok: false, error: 'not running in Electron' });
};
const stubTerm = {
  create: stubFn,
  reattach: stubFn,
  write: stubFn,
  resize: stubFn,
  kill: stubFn,
  detach: () => {},
  list: stubFn,
  setPinned: stubFn,
  quitAll: stubFn,
  pickFolder: stubFn,
  pathExists: stubFn,
  onData: () => () => {},
  onExit: () => () => {}
};
const stubSd = {
  status: stubFn, start: stubFn, stop: stubFn,
  txt2img: stubFn, img2img: stubFn, interrupt: stubFn,
  models: stubFn, samplers: stubFn, getOptions: stubFn, setModel: stubFn,
  scanCheckpoints: stubFn, scanLoras: stubFn, readImage: stubFn,
  onProgress: () => () => {}, onLog: () => () => {}, onStatus: () => () => {}
};
const stub = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'term') return stubTerm;
    if (name === 'sd') return stubSd;
    if (name === 'readClipboard') return () => '';
    if (name === 'writeClipboard') return () => {};
    if (name === 'getPathForFile') return () => null;
    if (name === 'onChunk') return () => () => {};
    if (name === 'onNotice') return () => () => {};
    return stubFn;
  }
});

function resolveApi() {
  return (typeof window !== 'undefined' && window.api) ? window.api : stub;
}

// Pass through contextBridge values as-is — rebinding/wrapping breaks Electron's
// read-only non-configurable function properties (e.g. api.term.create).
const api = new Proxy({}, {
  get(_t, name) {
    return resolveApi()[name];
  }
});
export default api;
