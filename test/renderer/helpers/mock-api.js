export function createMockApi() {
  const calls = [];
  const savedConvos = {};
  const presetStore = {};   // workflow -> [{ name, values }], mirrors prompt-presets.json
  const valuesStore = {};   // workflow -> { key: value }, mirrors control-values.json
  let chunkCb = null;
  const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

  const api = {
    loadKey: async () => ({ ok: true, present: true }),
    saveKey: async () => ({ ok: true, encrypted: true }),
    onNotice: () => () => {},
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
    sd: {
      status: async () => ({ ok: true, status: 'stopped', url: 'http://127.0.0.1:7860', managed: false, log: [] }),
      start: async () => ({ ok: true, status: 'starting' }),
      stop: async () => ({ ok: true, portFree: true }),
      txt2img: async (p) => { calls.push(['sd:txt2img', p]); return { ok: true, files: [{ path: 'D:\\Devlopment\\AI\\IMG\\sd-1.png', name: 'sd-1.png' }], seed: 42 }; },
      img2img: async (p) => { calls.push(['sd:img2img', p]); return { ok: true, files: [{ path: 'D:\\Devlopment\\AI\\IMG\\sd-2.png', name: 'sd-2.png' }], seed: 43 }; },
      interrupt: async () => ({ ok: true }),
      models: async () => ({ ok: true, data: [] }),
      samplers: async () => ({ ok: true, data: [] }),
      lists: async () => ({
        ok: true,
        samplers: [{ name: 'Euler a' }, { name: 'DPM++ 2M' }],
        schedulers: [{ name: 'automatic', label: 'Automatic' }, { name: 'karras', label: 'Karras' }],
        upscalers: [{ name: 'None' }, { name: 'Lanczos' }, { name: 'ESRGAN_4x' }],
        latentUpscaleModes: [{ name: 'Latent' }],
        models: [],
        styles: [{ name: 'cinematic' }]
      }),
      refreshLists: async () => { calls.push(['sd:refreshLists']); return { ok: true }; },
      pngInfo: async (b64) => { calls.push(['sd:pngInfo', b64]); return { ok: true, info: '', items: {} }; },
      adModels: async () => ({ ok: true, models: ['face_yolov8n.pt', 'hand_yolov8n.pt', 'mediapipe_face_full'] }),
      getOptions: async () => ({ ok: true, checkpoint: '', vae: 'Automatic', clipSkip: 1 }),
      setModel: async () => ({ ok: true }),
      scanCheckpoints: async () => ({ ok: true, list: [] }),
      scanLoras: async () => ({ ok: true, list: [] }),
      scanVae: async () => ({ ok: true, list: [] }),
      readImage: async () => ({ ok: true, b64: 'aGk=', mime: 'image/png' }),
      onProgress: () => () => {},
      onLog: () => () => {},
      onStatus: () => () => {}
    },
    comfy: {
      status: async () => ({ ok: true, status: 'stopped', url: 'http://127.0.0.1:8188', managed: false, log: [] }),
      start: async () => ({ ok: true, status: 'starting' }),
      stop: async () => ({ ok: true, portFree: true }),
      workflows: async () => ({
        ok: true,
        list: [{
          // no `media` field — exercises the pre-media default of 'video'
          name: 'smoke-test', label: 'Smoke test — solid-color clip (no model needed)',
          controls: {
            prompt: { node: '9', input: 'text', type: 'text' },
            width: { node: '1', input: 'width', type: 'int', default: 320, min: 64, max: 2048 },
            frames: { node: '1', input: 'batch_size', type: 'int', default: 24, min: 1, max: 480 },
            fps: { node: '2', input: 'fps', type: 'float', default: 12, min: 1, max: 60 },
            seed: { node: '3', input: 'noise_seed', type: 'seed' }
          }
        }, {
          name: 'krea-image', label: 'Krea2 — LUSTIFY', media: 'image',
          controls: {
            prompt: { node: '198', input: 'text', type: 'textarea' },
            seed: { node: '201', input: 'seed', type: 'seed' },
            steps: { node: '201', input: 'steps', type: 'int', default: 8, min: 1, max: 50, group: 'Sampling' },
            cfg: { node: '201', input: 'cfg', type: 'readonly', default: 1.0, min: 1.0, max: 1.0, group: 'Sampling',
                   tooltip: 'Locked at 1.0 — distilled model' },
            sampler: { node: '201', input: 'sampler_name', type: 'select', default: 'euler',
                       options_from: 'object_info:KSampler:sampler_name', group: 'Sampling' },
            width: { node: '200', input: 'width', type: 'int', default: 1024, min: 256, max: 2048 },
            height: { node: '200', input: 'height', type: 'int', default: 1024, min: 256, max: 2048 }
          }
        }]
      }),
      objectInfo: async (nodeType, input) => {
        calls.push(['comfy:objectInfo', nodeType, input]);
        return { ok: true, options: ['euler', 'euler_ancestral', 'dpmpp_2m'] };
      },
      generate: async (p) => {
        calls.push(['comfy:generate', p]);
        if (p.workflow === 'krea-image') {
          return { ok: true, files: [{ path: 'D:\\Devlopment\\AI\\IMG\\img-1.png', name: 'img-1.png' }], seed: 77, elapsed: 1.1, media: 'image' };
        }
        return { ok: true, files: [{ path: 'D:\\Devlopment\\AI\\IMG\\vid-1.mp4', name: 'vid-1.mp4' }], seed: 99, elapsed: 3.2 };
      },
      interrupt: async () => ({ ok: true }),
      cancel: async () => { calls.push(['comfy:cancel']); return { ok: true, interrupted: true, cleared: false }; },
      free: async () => { calls.push(['comfy:free']); return { ok: true }; },
      uploadImage: async (p) => { calls.push(['comfy:uploadImage', p]); return { ok: true, name: 'up.png' }; },
      onPreview: () => () => {},
      readVideo: async () => ({ ok: true, b64: 'AAAA', mime: 'video/mp4' }),
      rebuildManifests: async () => {
        calls.push(['comfy:rebuildManifests']);
        return { ok: true, results: [], list: (await api.comfy.workflows()).list };
      },
      setControlOverride: async (p) => {
        calls.push(['comfy:setControlOverride', p]);
        return { ok: true, list: (await api.comfy.workflows()).list };
      },
      values: async (workflow) => {
        calls.push(['comfy:values', workflow]);
        return { ok: true, values: valuesStore[workflow] || {} };
      },
      valuesSave: async (p) => {
        calls.push(['comfy:valuesSave', p]);
        valuesStore[p.workflow] = { ...p.values };
        return { ok: true };
      },
      valuesClear: async (workflow) => {
        calls.push(['comfy:valuesClear', workflow]);
        delete valuesStore[workflow];
        return { ok: true };
      },
      presets: async (workflow) => {
        calls.push(['comfy:presets', workflow]);
        return { ok: true, presets: presetStore[workflow] || [] };
      },
      presetSave: async (p) => {
        calls.push(['comfy:presetSave', p]);
        const list = presetStore[p.workflow] = presetStore[p.workflow] || [];
        const ex = list.find(x => x.name === p.name);
        if (ex) ex.values = p.values; else list.push({ name: p.name, values: p.values });
        return { ok: true, presets: list };
      },
      presetRename: async (p) => {
        calls.push(['comfy:presetRename', p]);
        const list = presetStore[p.workflow] || [];
        const x = list.find(y => y.name === p.oldName);
        if (x) x.name = p.newName;
        return { ok: true, presets: list };
      },
      presetDelete: async (p) => {
        calls.push(['comfy:presetDelete', p]);
        presetStore[p.workflow] = (presetStore[p.workflow] || []).filter(x => x.name !== p.name);
        return { ok: true, presets: presetStore[p.workflow] };
      },
      onProgress: () => () => {},
      onLog: () => () => {},
      onStatus: () => () => {}
    },
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

  return { api, calls, savedConvos, presetStore, valuesStore, tick };
}
