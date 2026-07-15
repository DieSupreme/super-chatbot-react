const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const core = require('../../src/main/comfy-core.js');

const GRAPH = {
  '1': { class_type: 'EmptyImage', inputs: { width: 320, height: 240, batch_size: 24 } },
  '2': { class_type: 'CreateVideo', inputs: { images: ['1', 0], fps: 12 } }
};
const MANIFEST = {
  label: 'test',
  controls: {
    width: { node: '1', input: 'width', type: 'int', min: 64, max: 2048 },
    frames: { node: '1', input: 'batch_size', type: 'int', min: 1, max: 480 },
    fps: { targets: [{ node: '2', input: 'fps' }], type: 'float', min: 1, max: 60 }
  }
};

test('patchWorkflow: patches only mapped inputs, clamps, leaves graph untouched', () => {
  const out = core.patchWorkflow(GRAPH, MANIFEST, { width: 4096, frames: 30.7, fps: 24 });
  assert.equal(out['1'].inputs.width, 2048);        // clamped to max
  assert.equal(out['1'].inputs.batch_size, 31);     // int-rounded
  assert.equal(out['2'].inputs.fps, 24);            // multi-target form
  assert.equal(out['1'].inputs.height, 240);        // unmapped input untouched
  assert.equal(GRAPH['1'].inputs.width, 320);       // original not mutated
});

test('patchWorkflow: null/empty values leave the template default in place', () => {
  const out = core.patchWorkflow(GRAPH, MANIFEST, { width: null, frames: '', fps: undefined });
  assert.equal(out['1'].inputs.width, 320);
  assert.equal(out['1'].inputs.batch_size, 24);
  assert.equal(out['2'].inputs.fps, 12);
});

test('patchWorkflow: manifest pointing at a missing node throws clearly', () => {
  assert.throws(
    () => core.patchWorkflow(GRAPH, { controls: { x: { node: '99', input: 'y' } } }, { x: 1 }),
    /missing node 99/
  );
});

test('listWorkflows: pairs only, sorted by label, malformed manifests skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.manifest.json'), JSON.stringify({ label: 'Beta', controls: {} }));
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.manifest.json'), JSON.stringify({ label: 'Alpha', controls: {} }));
  fs.writeFileSync(path.join(dir, 'orphan.manifest.json'), JSON.stringify({ label: 'NoGraph' }));  // no .json pair
  fs.writeFileSync(path.join(dir, 'bad.json'), '{}');
  fs.writeFileSync(path.join(dir, 'bad.manifest.json'), 'not json');
  const list = core.listWorkflows(dir);
  assert.deepEqual(list.map(w => w.label), ['Alpha', 'Beta']);
  assert.deepEqual(core.listWorkflows(path.join(dir, 'nope')), []);
});

test('listWorkflows: media is image when declared, video otherwise (pre-media manifests)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  fs.writeFileSync(path.join(dir, 'pic.json'), '{}');
  fs.writeFileSync(path.join(dir, 'pic.manifest.json'), JSON.stringify({ label: 'Pic', media: 'image', controls: {} }));
  fs.writeFileSync(path.join(dir, 'clip.json'), '{}');
  fs.writeFileSync(path.join(dir, 'clip.manifest.json'), JSON.stringify({ label: 'Clip', controls: {} }));
  const byName = Object.fromEntries(core.listWorkflows(dir).map(w => [w.name, w.media]));
  assert.equal(byName.pic, 'image');
  assert.equal(byName.clip, 'video');       // backwards compat: no field -> video
  assert.equal(core.workflowMedia({ media: 'nonsense' }), 'video');
});

test('patchWorkflow: readonly controls always patch the manifest default, ignoring the value', () => {
  const graph = { '1': { class_type: 'KSampler', inputs: { cfg: 1 } } };
  const manifest = { controls: { cfg: { node: '1', input: 'cfg', type: 'readonly', default: 1.0, min: 1.0, max: 1.0 } } };
  assert.equal(core.patchWorkflow(graph, manifest, { cfg: 7 })['1'].inputs.cfg, 1);
  assert.equal(core.patchWorkflow(graph, manifest, {})['1'].inputs.cfg, 1);
});

test('patchWorkflow: checkbox booleans and select strings pass through untouched', () => {
  const graph = { '1': { class_type: 'X', inputs: { add_noise: true, sampler_name: 'euler' } } };
  const manifest = { controls: {
    noise: { node: '1', input: 'add_noise', type: 'checkbox' },
    sampler: { node: '1', input: 'sampler_name', type: 'select' }
  } };
  const out = core.patchWorkflow(graph, manifest, { noise: false, sampler: 'dpmpp_2m' });
  assert.equal(out['1'].inputs.add_noise, false);
  assert.equal(out['1'].inputs.sampler_name, 'dpmpp_2m');
});

test('objectInfoOptions: extracts combo options from /object_info, [] when absent', () => {
  const info = { KSampler: { input: {
    required: { sampler_name: [['euler', 'dpmpp_2m'], {}], steps: ['INT', { default: 20 }] },
    optional: { extra: [['a', 'b']] }
  } } };
  assert.deepEqual(core.objectInfoOptions(info, 'KSampler', 'sampler_name'), ['euler', 'dpmpp_2m']);
  assert.deepEqual(core.objectInfoOptions(info, 'KSampler', 'extra'), ['a', 'b']);
  assert.deepEqual(core.objectInfoOptions(info, 'KSampler', 'steps'), []);      // INT, not a combo
  assert.deepEqual(core.objectInfoOptions(info, 'Nope', 'x'), []);
  assert.deepEqual(core.objectInfoOptions(null, 'KSampler', 'x'), []);
});

test('videoFileName: stamped, seed-suffixed, collision-suffixed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const now = new Date(2026, 6, 14, 3, 4, 5);
  const a = core.videoFileName(dir, 42, 'mp4', now);
  assert.equal(a, 'vid-20260714-030405-42.mp4');
  fs.writeFileSync(path.join(dir, a), '');
  assert.equal(core.videoFileName(dir, 42, 'mp4', now), 'vid-20260714-030405-42-2.mp4');
  // image workflows get img-*, keeping sd-* for Forge and vid-* for video
  assert.equal(core.mediaFileName(dir, 42, 'png', 'img', now), 'img-20260714-030405-42.png');
});

test('detectComfyLayout: portable vs clone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-'));
  fs.mkdirSync(path.join(dir, 'python_embeded'));
  fs.writeFileSync(path.join(dir, 'python_embeded', 'python.exe'), '');
  fs.mkdirSync(path.join(dir, 'ComfyUI'));
  fs.writeFileSync(path.join(dir, 'ComfyUI', 'main.py'), '');
  const l = core.detectComfyLayout(dir);
  assert.equal(l.portable, true);
  assert.equal(l.base, path.join(dir, 'ComfyUI'));
  const c = core.detectComfyLayout(path.join(dir, 'ComfyUI'));
  assert.equal(c.portable, false);
  assert.equal(c.python, 'python');
});

// ---------- UI-graph -> API conversion ----------
// fixture /object_info shaped like the real server's: [typeSpec, opts] per
// input, connection inputs as bare type strings, combos as option arrays
const OBJECT_INFO = {
  UNETLoader: { input: { required: {
    unet_name: [['lustifyNSFWCheckpoint_v10Krea2.safetensors'], {}], weight_dtype: [['default', 'fp8_e4m3fn'], {}]
  } } },
  CLIPLoader: { input: { required: {
    clip_name: [['qwen3vl_4b_fp8_scaled.safetensors'], {}], type: [['krea2', 'sdxl'], {}]
  }, optional: { device: [['default', 'cpu'], { advanced: true }] } } },
  VAELoader: { input: { required: { vae_name: [['qwen_image_vae.safetensors'], {}] } } },
  CLIPTextEncode: { input: { required: {
    text: ['STRING', { multiline: true, dynamicPrompts: true }], clip: ['CLIP', {}]
  } } },
  ConditioningZeroOut: { input: { required: { conditioning: ['CONDITIONING', {}] } } },
  EmptySD3LatentImage: { input: { required: {
    width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }], batch_size: ['INT', { default: 1 }]
  } } },
  KSampler: { input: { required: {
    model: ['MODEL', {}], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}],
    sampler_name: [['euler', 'dpmpp_2m'], {}], scheduler: [['simple', 'normal'], {}],
    positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], denoise: ['FLOAT', {}]
  } } },
  VAEDecode: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE', {}], vae: ['VAE', {}] } } },
  UpscaleModelLoader: { input: { required: { model_name: [['4x_NMKD-Siax_200k.pth'], {}] } } },
  ImageUpscaleWithModel: { input: { required: { upscale_model: ['UPSCALE_MODEL', {}], image: ['IMAGE', {}] } } },
  ImageScale: { input: { required: {
    image: ['IMAGE', {}], upscale_method: [['nearest-exact', 'lanczos'], {}],
    width: ['INT', {}], height: ['INT', {}], crop: [['disabled', 'center'], {}]
  } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } } }
};

test('isUiGraph: nodes[] array marks the UI export, API format does not', () => {
  assert.equal(core.isUiGraph({ nodes: [], links: [] }), true);
  assert.equal(core.isUiGraph(GRAPH), false);
  assert.equal(core.isUiGraph(null), false);
});

test('uiGraphToApi: widgets map positionally, seed skips control_after_generate, links resolve', () => {
  const ui = {
    nodes: [
      { id: 1, type: 'EmptySD3LatentImage', mode: 0, inputs: [], outputs: [], widgets_values: [640, 480, 1] },
      { id: 2, type: 'KSampler', mode: 0, widgets_values: [42, 'randomize', 8, 1, 'euler', 'simple', 0.35],
        inputs: [{ name: 'latent_image', type: 'LATENT', link: 10 }], outputs: [] },
      { id: 3, type: 'MarkdownNote', mode: 0, widgets_values: ['docs'] }
    ],
    links: [[10, 1, 0, 2, 3, 'LATENT']]
  };
  const api = core.uiGraphToApi(ui, OBJECT_INFO);
  assert.deepEqual(api['1'].inputs, { width: 640, height: 480, batch_size: 1 });
  assert.equal(api['2'].inputs.seed, 42);
  assert.equal(api['2'].inputs.steps, 8);            // 'randomize' slot skipped
  assert.equal(api['2'].inputs.sampler_name, 'euler');
  assert.equal(api['2'].inputs.denoise, 0.35);
  assert.deepEqual(api['2'].inputs.latent_image, ['1', 0]);
  assert.equal(api['3'], undefined);                  // notes never execute
  assert.equal(api['2'].class_type, 'KSampler');
});

test('uiGraphToApi: bypassed (mode 4) nodes drop out and links forward through them', () => {
  const ui = {
    nodes: [
      { id: 1, type: 'EmptySD3LatentImage', mode: 0, inputs: [], widgets_values: [64, 64, 1] },
      // a bypassed "adjust" node between 1 and 3 — mode 4 forwards LATENT through
      { id: 2, type: 'VAEEncode', mode: 4, widgets_values: [],
        inputs: [{ name: 'pixels', type: 'IMAGE', link: null }, { name: 'vae', type: 'VAE', link: null }] },
      { id: 3, type: 'KSampler', mode: 0, widgets_values: [0, 'fixed', 4, 1, 'euler', 'simple', 1],
        inputs: [{ name: 'latent_image', type: 'LATENT', link: 20 }] }
    ],
    links: [[20, 1, 0, 3, 3, 'LATENT']]
  };
  const api = core.uiGraphToApi(ui, OBJECT_INFO);
  assert.equal(api['2'], undefined);
  assert.deepEqual(api['3'].inputs.latent_image, ['1', 0]);
});

test('uiGraphToApi: unknown node type throws with the type named', () => {
  const ui = { nodes: [{ id: 1, type: 'NotARealNode', mode: 0, inputs: [], widgets_values: [] }], links: [] };
  assert.throws(() => core.uiGraphToApi(ui, OBJECT_INFO), /NotARealNode/);
});

test('uiGraphToApi: converts the shipped Super Duper Lustify UI export correctly', () => {
  const ui = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workflows', 'Super_Duper_Lustify_Final.json'), 'utf8'));
  assert.equal(core.isUiGraph(ui), true);
  for (const t of core.uiGraphTypes(ui)) assert.ok(OBJECT_INFO[t], `fixture object_info missing ${t}`);
  const api = core.uiGraphToApi(ui, OBJECT_INFO);

  // base sampler: denoise 1, 8 steps, latent from the size node
  assert.equal(api['201'].inputs.steps, 8);
  assert.equal(api['201'].inputs.denoise, 1);
  assert.deepEqual(api['201'].inputs.latent_image, ['200', 0]);
  // refine samplers keep their baked tuning
  assert.equal(api['207'].inputs.denoise, 0.35);
  assert.equal(api['210'].inputs.denoise, 0.2);
  // prompt + size nodes
  assert.match(api['198'].inputs.text, /PASTE YOUR PROMPT/);
  assert.deepEqual([api['200'].inputs.width, api['200'].inputs.height], [1216, 832]);
  // both SaveImage nodes present with their prefixes
  assert.equal(api['203'].inputs.filename_prefix, 'krea2_final');
  assert.equal(api['211'].inputs.filename_prefix, 'krea2_base');
  assert.deepEqual(api['203'].inputs.images, ['208', 0]);   // final = decode of stage-3
  assert.deepEqual(api['211'].inputs.images, ['202', 0]);   // base preview = decode of stage-1
  // bypassed edit-mode branch and the note are gone
  assert.equal(api['250'], undefined);
  assert.equal(api['251'], undefined);
  assert.equal(api['259'], undefined);
  // upscale chain wiring survived
  assert.deepEqual(api['204'].inputs.image, ['202', 0]);
  assert.deepEqual(api['209'].inputs.image, ['204', 0]);
  assert.deepEqual([api['209'].inputs.width, api['209'].inputs.height], [2432, 1664]);
  assert.deepEqual(api['206'].inputs.pixels, ['209', 0]);
  // the manifest's controls all point at inputs that exist post-conversion
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workflows', 'Super_Duper_Lustify_Final.manifest.json'), 'utf8'));
  const patched = core.patchWorkflow(api, manifest, { prompt: 'a test', seed: 7, width: 1216, height: 832 });
  assert.equal(patched['198'].inputs.text, 'a test');
  assert.equal(patched['201'].inputs.seed, 7);
  assert.equal(patched['207'].inputs.denoise, 0.35);        // refine untouched by patch
});

test('pickHistoryOutput: manifest output node pins the result; media filters; fallback flagged', () => {
  const outputs = {
    '211': { images: [{ filename: 'krea2_base_00001_.png', type: 'output' }] },
    '203': { images: [{ filename: 'krea2_final_00001_.png', type: 'output' }] }
  };
  const pinned = core.pickHistoryOutput(outputs, 'image', '203');
  assert.equal(pinned.pick.filename, 'krea2_final_00001_.png');
  assert.equal(pinned.fallback, false);
  // no pin -> first image found (legacy behaviour)
  assert.ok(core.pickHistoryOutput(outputs, 'image', null).pick);
  // pinned node absent -> falls back to everything, flagged
  const fb = core.pickHistoryOutput({ '211': outputs['211'] }, 'image', '203');
  assert.equal(fb.fallback, true);
  assert.equal(fb.pick.filename, 'krea2_base_00001_.png');
  // media preference still applies inside the pinned node
  const mixed = { '9': { images: [{ filename: 'a.mp4' }, { filename: 'b.png' }] } };
  assert.equal(core.pickHistoryOutput(mixed, 'image', '9').pick.filename, 'b.png');
  assert.equal(core.pickHistoryOutput(mixed, 'video', '9').pick.filename, 'a.mp4');
  assert.equal(core.pickHistoryOutput({}, 'image', null).pick, null);
});

// toy RFC6455 server: handshake, then a text frame, a fragmented text
// message, and a ping — records whether the client answered with a pong
function makeWsServer() {
  const state = { pongSeen: false };
  const sockets = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = (s) => Buffer.concat([Buffer.from([0x81, s.length]), Buffer.from(s)]);
    socket.write(text(JSON.stringify({ type: 'hello' })));
    const whole = JSON.stringify({ type: 'frag' });
    const p1 = whole.slice(0, 5), p2 = whole.slice(5);
    socket.write(Buffer.concat([Buffer.from([0x01, p1.length]), Buffer.from(p1)]));
    socket.write(Buffer.concat([Buffer.from([0x80, p2.length]), Buffer.from(p2)]));
    socket.write(Buffer.from([0x89, 0x00]));   // ping, empty
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 0x0a) state.pongSeen = true; });
    socket.on('error', () => {});
  });
  // upgraded sockets leave the server's connection tracking, so
  // closeAllConnections() misses them — destroy them by hand or the native
  // WebSocket client waits forever for a close reply and pins the event loop
  const destroy = () => {
    for (const s of sockets) { try { s.destroy(); } catch (_) {} }
    server.close();
  };
  return { server, state, destroy };
}

test('openManualWs: RFC6455 handshake, text frames, fragmentation, ping->pong', async () => {
  const got = [];
  const { server, state, destroy } = makeWsServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ws = core.openManualWs(`http://127.0.0.1:${server.address().port}/ws?clientId=t`,
    { onMessage: (m) => got.push(m.type) });
  await new Promise(r => setTimeout(r, 300));
  ws.close();
  destroy();
  assert.deepEqual(got, ['hello', 'frag']);
  assert.equal(state.pongSeen, true);
});

test('openWs: prefers the native WebSocket when the runtime has one', async (t) => {
  if (typeof WebSocket !== 'function') { t.skip('no native WebSocket in this runtime'); return; }
  const got = [];
  const { server, destroy } = makeWsServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ws = core.openWs(`http://127.0.0.1:${server.address().port}/ws?clientId=t`,
    { onMessage: (m) => got.push(m.type) });
  await new Promise(r => setTimeout(r, 400));
  ws.close();
  destroy();
  assert.deepEqual(got, ['hello', 'frag']);
});
