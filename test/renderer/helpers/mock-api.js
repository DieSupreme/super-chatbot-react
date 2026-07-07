export function createMockApi() {
  const calls = [];
  const savedConvos = {};
  let chunkCb = null;
  const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

  const api = {
    loadKey: async () => ({ ok: true, key: 'sk-or-v1-test' }),
    saveKey: async () => ({ ok: true, encrypted: true }),
    clearKey: async () => ({ ok: true }),
    getSettings: async () => ({ ok: true, settings: {} }),
    saveSettings: async () => ({ ok: true }),
    convoList: async () => ({
      ok: true,
      list: Object.values(savedConvos).map(c => ({
        id: c.id, title: c.title, model: c.model, cost: c.cost || 0, updated: c.updated || Date.now()
      }))
    }),
    convoGet: async (id) => savedConvos[id] ? { ok: true, convo: savedConvos[id] } : { ok: false },
    convoSave: async (c) => { c.updated = Date.now(); savedConvos[c.id] = c; calls.push(['convoSave', c]); return { ok: true }; },
    convoDelete: async (id) => { delete savedConvos[id]; return { ok: true }; },
    allowList: async () => ({ ok: true, paths: ['C:\\proj\\app.js'] }),
    allowAdd: async () => ({ ok: true, paths: [] }),
    allowRemove: async () => ({ ok: true, paths: [] }),
    pickFiles: async () => ({ ok: true, files: [] }),
    readFiles: async () => ({ ok: true, files: [] }),
    getPathForFile: () => null,
    writeFile: async () => ({ ok: true }),
    saveAs: async () => ({ ok: true, path: 'x' }),
    saveZip: async (p) => ({ ok: true, count: p.files.length }),
    generateImage: async () => ({ ok: true, b64: 'aGk=', mime: 'image/png', cost: 0.01 }),
    saveImage: async () => ({ ok: true }),
    stopChat: async () => ({ ok: true }),
    onChunk: (cb) => { chunkCb = cb; return () => { if (chunkCb === cb) chunkCb = null; }; },
    sendChat: async ({ messages, requestId }) => {
      calls.push(['sendChat', messages]);
      await tick();
      chunkCb?.({ requestId, reasoning: 'thinking about it… ' });
      await tick();
      chunkCb?.({ requestId, delta: 'Here is **bold** and `inline`.\n\n' });
      await tick();
      chunkCb?.({ requestId, delta: '```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n' });
      await tick();
      chunkCb?.({ requestId, delta: '```edit path=C:\\proj\\app.js\nnew contents\n```\n' });
      await tick();
      const full = 'Here is **bold** and `inline`.\n\n```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n```edit path=C:\\proj\\app.js\nnew contents\n```\n';
      return { ok: true, full, cost: 0.0123, tokens: { prompt: 10, completion: 20, total: 30 }, citations: [{ url: 'https://example.com/a', title: 'Example' }] };
    },
    readClipboard: () => '',
    writeClipboard: () => {},
    term: {
      create: async () => ({ ok: true, id: 1, cwd: '', cwdFallback: false }),
      reattach: async () => ({ ok: true, ring: '' }),
      write: () => {},
      resize: () => {},
      kill: async () => ({ ok: true }),
      detach: () => {},
      list: async () => ({ ok: true, sessions: [] }),
      setPinned: async () => ({ ok: true }),
      quitAll: async () => ({ ok: true }),
      pickFolder: async () => ({ ok: false, canceled: true }),
      pathExists: async () => ({ ok: true, exists: false }),
      onData: () => () => {},
      onExit: () => () => {}
    }
  };

  return { api, calls, savedConvos, tick };
}
