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
const stub = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'term') return stubTerm;
    if (name === 'readClipboard') return () => '';
    if (name === 'writeClipboard') return () => {};
    if (name === 'getPathForFile') return () => null;
    if (name === 'onChunk') return () => () => {};
    return stubFn;
  }
});

function resolveApi() {
  return (typeof window !== 'undefined' && window.api) ? window.api : stub;
}

const api = new Proxy({}, {
  get(_t, name) {
    const a = resolveApi();
    const v = a[name];
    if (name === 'term' && v && typeof v === 'object') {
      return new Proxy(v, {
        get(t, n) {
          const fn = t[n];
          return typeof fn === 'function' ? fn.bind(t) : fn;
        }
      });
    }
    return typeof v === 'function' ? v.bind(a) : v;
  }
});
export default api;
