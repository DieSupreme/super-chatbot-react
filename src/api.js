// The preload script exposes window.api (contextBridge). This module is the
// single import point so components never touch window.api directly, and so
// the app fails loudly (with a stub) if opened outside Electron.
const stub = new Proxy({}, {
  get: (_t, name) => () => {
    console.warn(`window.api.${String(name)} called outside Electron`);
    return Promise.resolve({ ok: false, error: 'not running in Electron' });
  }
});

const api = (typeof window !== 'undefined' && window.api) ? window.api : stub;
export default api;
