// Manifest auto-generation: buildManifest extracts runtime-editable controls
// from a UI-format workflow export (subgraphs included), emitting the same
// manifest shape the hand-written ones used — so patchWorkflow, workflowMedia,
// pickHistoryOutput and the options_from resolver keep working unchanged.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../../src/main/comfy-core.js');

const fixture = (f) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');
const sha256 = (t) => 'sha256:' + crypto.createHash('sha256').update(t).digest('hex');
// find a control by its patch target — key names for hidden potentials are
// derived from titles and may shift; node:input identity is the stable handle
const byTarget = (controls, node, input) => Object.entries(controls).find(([, c]) =>
  (c.targets || [{ node: c.node, input: c.input }]).some(t => t.node === node && t.input === input)) || [];

test('buildManifest: DR34ML4Y img2vid — subgraph seeds, titled constants, loras, video output', () => {
  const text = fixture('DR34ML4Y Img2Vid 2.0.json');
  const m = core.buildManifest(text, 'DR34ML4Y Img2Vid 2.0');
  assert.equal(m.label, 'DR34ML4Y Img2Vid 2.0');
  assert.equal(m.backend, 'comfy');
  assert.equal(m.media, 'video');
  assert.equal(m.output, '140');                                   // VHS_VideoCombine
  assert.equal(m.generated.sourceHash, sha256(text));
  const c = m.controls;
  // prompts: positive by title, negative by title/wordlist
  assert.deepEqual([c.prompt.node, c.prompt.input, c.prompt.type], ['121', 'text', 'textarea']);
  assert.deepEqual([c.negative.node, c.negative.input], ['110', 'text']);
  // both RandomNoise seeds inside the ENGINE subgraph, multi-target form
  assert.equal(c.seed.type, 'seed');
  assert.deepEqual(c.seed.targets, [
    { node: '361:114', input: 'noise_seed' }, { node: '361:115', input: 'noise_seed' }
  ]);
  // titled INTConstants beat the link-driven EmptyLTXVLatentVideo
  assert.deepEqual([c.width.node, c.width.input, c.width.default], ['292', 'value', 512]);
  assert.deepEqual([c.height.node, c.height.default], ['293', 704]);
  assert.deepEqual([c.length.node, c.length.default, c.length.type], ['291', 5, 'int']);
  assert.deepEqual([c.fps.node, c.fps.default, c.fps.type], ['285', 24, 'float']);
  // LoadImage as a select over the server's input files (upload deferred)
  assert.deepEqual([c.image.node, c.image.input, c.image.type], ['167', 'image', 'select']);
  assert.equal(c.image.options_from, 'object_info:LoadImage:image');
  // T2V toggle keyed by slugified title, labelled for the UI
  assert.deepEqual([c.t2v_mode.node, c.t2v_mode.input, c.t2v_mode.type, c.t2v_mode.default],
    ['290', 'value', 'checkbox', false]);
  assert.equal(c.t2v_mode.label, 'T2V MODE (False=image mode)');
  // Power Lora row -> dotted path; plain LoraLoaderModelOnly -> lora_name
  assert.deepEqual([c.lora.node, c.lora.input, c.lora.default],
    ['301', 'lora_1.lora', 'DR34ML4Y_LT3X_V3.safetensors']);
  assert.equal(c.lora.options_from, 'object_info:LoraLoaderModelOnly:lora_name');
  assert.deepEqual([c.lora_2.node, c.lora_2.input], ['134', 'lora_name']);
  // link-driven widgets never become controls (VHS frame_rate is wired) —
  // static widgets on the same node (format, trim_to_audio) may
  for (const ctl of Object.values(c)) {
    for (const t of ctl.targets || [{ node: ctl.node, input: ctl.input }])
      assert.ok(!(t.node === '140' && t.input === 'frame_rate'), 'wired frame_rate must never be a control');
  }
});

test('buildManifest: DR34ML4Y — model/vae/encoder/upscaler selects live-listed from object_info', () => {
  const c = core.buildManifest(fixture('DR34ML4Y Img2Vid 2.0.json'), 'DR34ML4Y Img2Vid 2.0').controls;
  assert.deepEqual([c.model.node, c.model.input, c.model.type, c.model.default],
    ['345', 'unet_name', 'select', 'ltx-2.3-22b-dev-Q3_K_M.gguf']);
  assert.equal(c.model.options_from, 'object_info:UnetLoaderGGUF:unet_name');
  assert.equal(c.model.label, 'MODEL (dev GGUF)');
  // text encoder pair on the DualCLIPLoaderGGUF
  assert.deepEqual([c.text_encoder.node, c.text_encoder.input, c.text_encoder.default],
    ['346', 'clip_name1', 'gemma-3-12b-it-Q4_K_M.gguf']);
  assert.equal(c.text_encoder.options_from, 'object_info:DualCLIPLoaderGGUF:clip_name1');
  assert.deepEqual([c.text_encoder_2.node, c.text_encoder_2.input,
    c.text_encoder_2.default], ['346', 'clip_name2', 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors']);
  assert.equal(c.text_encoder_2.label, 'TEXT ENCODER (Gemma) 2');   // same node, disambiguated
  // all three VAEs (audio KJ / tiny preview / video), disambiguated by title
  assert.deepEqual([c.vae.node, c.vae.options_from, c.vae.label],
    ['196', 'object_info:VAELoaderKJ:vae_name', 'AUDIO VAE']);
  assert.deepEqual([c.vae_2.node, c.vae_2.default], ['330', 'taeltx2_3.safetensors']);
  assert.deepEqual([c.vae_3.node, c.vae_3.default, c.vae_3.options_from],
    ['184', 'LTX23_video_vae_bf16.safetensors', 'object_info:VAELoader:vae_name']);
  assert.deepEqual([c.upscale_model.node, c.upscale_model.input, c.upscale_model.options_from],
    ['189', 'model_name', 'object_info:LatentUpscaleModelLoader:model_name']);
  for (const k of ['model', 'text_encoder', 'text_encoder_2', 'vae', 'vae_2', 'vae_3', 'upscale_model'])
    assert.equal(c[k].group, 'Models', k + ' sits in the Models group');
});

test('buildManifest: DR34ML4Y — lora strengths and on-toggles ride with the file selects', () => {
  const c = core.buildManifest(fixture('DR34ML4Y Img2Vid 2.0.json'), 'DR34ML4Y Img2Vid 2.0').controls;
  // Power Lora slot: dotted-path strength + on, keyed off the file control
  assert.deepEqual([c.lora_strength.node, c.lora_strength.input, c.lora_strength.type, c.lora_strength.default],
    ['301', 'lora_1.strength', 'float', 1]);
  assert.deepEqual([c.lora_strength.min, c.lora_strength.max, c.lora_strength.step], [0, 2, 0.05]);
  assert.deepEqual([c.lora_on.node, c.lora_on.input, c.lora_on.type, c.lora_on.default],
    ['301', 'lora_1.on', 'checkbox', true]);
  // plain LoraLoaderModelOnly: strength_model (0 = effective bypass)
  assert.deepEqual([c.lora_2_strength.node, c.lora_2_strength.input, c.lora_2_strength.default],
    ['134', 'strength_model', 0.3]);
  assert.deepEqual([c.lora_2_strength.min, c.lora_2_strength.max, c.lora_2_strength.step], [0, 2, 0.05]);
  for (const k of ['lora_strength', 'lora_on', 'lora_2_strength'])
    assert.equal(c[k].group, 'LoRA');
});

test('buildManifest: DR34ML4Y — sampling: identical pairs collapse to multi-target, different values split per pass', () => {
  const c = core.buildManifest(fixture('DR34ML4Y Img2Vid 2.0.json'), 'DR34ML4Y Img2Vid 2.0').controls;
  // both CFGGuiders sat at 1 -> ONE control moving both
  assert.deepEqual([c.cfg.type, c.cfg.min, c.cfg.max, c.cfg.step, c.cfg.default], ['float', 1, 10, 0.5, 1]);
  assert.deepEqual(c.cfg.targets.sort((a, b) => a.node.localeCompare(b.node)),
    [{ node: '361:103', input: 'cfg' }, { node: '361:129', input: 'cfg' }]);
  // both i2v strengths sat at 1 -> ONE control
  assert.deepEqual([c.i2v_strength.min, c.i2v_strength.max, c.i2v_strength.step, c.i2v_strength.default], [0, 1, 0.05, 1]);
  assert.deepEqual(c.i2v_strength.targets.sort((a, b) => a.node.localeCompare(b.node)),
    [{ node: '361:160', input: 'strength' }, { node: '361:161', input: 'strength' }]);
  // the two KSamplerSelects differ -> separate controls labeled by consuming pass
  assert.deepEqual([c.sampler.node, c.sampler.default, c.sampler.label],
    ['361:137', 'lcm', 'Sampler (main pass)']);
  assert.equal(c.sampler.options_from, 'object_info:KSamplerSelect:sampler_name');
  assert.deepEqual([c.sampler_2.node, c.sampler_2.default, c.sampler_2.label],
    ['361:138', 'euler_cfg_pp', 'Sampler (refine pass)']);
  // all three sigma strings differ -> three text controls: main, refine, then the unwired titled spare
  assert.deepEqual([c.sigmas.node, c.sigmas.type, c.sigmas.label], ['361:360', 'text', 'Sigmas (main pass)']);
  assert.match(c.sigmas.default, /^1\.0, 0\.9938/);
  assert.deepEqual([c.sigmas_2.node, c.sigmas_2.label], ['361:359', 'Sigmas (refine pass)']);
  assert.match(c.sigmas_2.default, /^0\.85, 0\.75/);
  assert.deepEqual([c.sigmas_3.node, c.sigmas_3.label], ['361:100', 'ManualSigmas (LTX 2.0)']);
  for (const k of ['cfg', 'i2v_strength', 'sampler', 'sampler_2', 'sigmas', 'sigmas_2', 'sigmas_3'])
    assert.equal(c[k].group, 'Sampling (advanced)', k + ' sits in Sampling (advanced)');
});

test('buildManifest: DR34ML4Y — VHS output: format select + trim checkbox, wired frame_rate untouched', () => {
  const c = core.buildManifest(fixture('DR34ML4Y Img2Vid 2.0.json'), 'DR34ML4Y Img2Vid 2.0').controls;
  assert.deepEqual([c.format.node, c.format.input, c.format.type, c.format.default],
    ['140', 'format', 'select', 'video/h264-mp4']);
  assert.ok(c.format.options.includes('video/h264-mp4') && c.format.options.includes('image/gif'),
    'offline fallback options cover mp4 and gif');
  assert.equal(c.format.options_from, 'object_info:VHS_VideoCombine:format');
  assert.deepEqual([c.trim_to_audio.node, c.trim_to_audio.input, c.trim_to_audio.type, c.trim_to_audio.default],
    ['140', 'trim_to_audio', 'checkbox', true]);
  assert.equal(c.format.group, 'Output');
  assert.equal(c.trim_to_audio.group, 'Output');
});

test('buildManifest: Lustify Final — checkpoint/encoder/vae selects + multi-target cfg and sampler (identical values)', () => {
  const c = core.buildManifest(fixture('Lustify Final.json'), 'Lustify Final').controls;
  assert.deepEqual([c.model.node, c.model.input, c.model.default],
    ['1', 'unet_name', 'lustifyNSFWCheckpoint_v10Krea2.safetensors']);
  assert.equal(c.model.options_from, 'object_info:UNETLoader:unet_name');
  assert.deepEqual([c.text_encoder.node, c.text_encoder.input, c.text_encoder.default],
    ['3', 'clip_name', 'qwen3vl_4b_fp8_scaled.safetensors']);
  assert.deepEqual([c.vae.node, c.vae.default], ['16', 'qwen_image_vae.safetensors']);
  assert.deepEqual([c.upscale_model.node, c.upscale_model.default],
    ['157:142', '4x_NMKD-Superscale-SP_178000_G.pth']);
  // both KSamplers run cfg 1 / euler -> single multi-target controls
  assert.deepEqual(c.cfg.targets.sort((a, b) => a.node.localeCompare(b.node)),
    [{ node: '123:6', input: 'cfg' }, { node: '157:150', input: 'cfg' }]);
  assert.equal(c.cfg.default, 1);
  assert.deepEqual(c.sampler.targets.sort((a, b) => a.node.localeCompare(b.node)),
    [{ node: '123:6', input: 'sampler_name' }, { node: '157:150', input: 'sampler_name' }]);
  assert.deepEqual([c.sampler.default, c.sampler.options_from], ['euler', 'object_info:KSampler:sampler_name']);
  // the Power Lora Loader still has no configured rows -> no lora controls at all
  assert.equal(c.lora, undefined);
  assert.equal(c.lora_strength, undefined);
});

test('buildManifest: Lustify + img2img — model select and multi-target cfg/sampler; existing keys stable', () => {
  const c = core.buildManifest(fixture('Lustify.json'), 'Lustify').controls;
  assert.deepEqual([c.model.node, c.model.default], ['195', 'lustifyNSFWCheckpoint_v10Krea2.safetensors']);
  assert.deepEqual(c.cfg.targets.sort((a, b) => a.node.localeCompare(b.node)),
    [{ node: '201', input: 'cfg' }, { node: '207', input: 'cfg' }]);
  assert.equal(c.sampler.default, 'euler');
  assert.deepEqual([c.text_encoder.node, c.vae.node, c.upscale_model.node], ['196', '197', '205']);
  const c2 = core.buildManifest(fixture('Lustify_Final_img2img.json'), 'Lustify_Final_img2img').controls;
  assert.deepEqual([c2.model.node, c2.cfg.targets.length, c2.sampler.targets.length], ['1', 2, 2]);
  assert.deepEqual([c2.image.node, c2.use_img2img.node, c2.prompt.node], ['211', '214', '119']);   // untouched
});

test('buildManifest: Lustify Final — PrimitiveStringMultiline prompt, subgraph sampler seed, no false positives', () => {
  const text = fixture('Lustify Final.json');
  const m = core.buildManifest(text, 'Lustify Final');
  assert.equal(m.media, 'image');
  assert.equal(m.output, '186');
  const c = m.controls;
  // the top-level "User Prompt" primitive wins over the Face Detailer's static
  // CLIPTextEncode and the enhancer's "System Prompt" inside the subgraph
  assert.deepEqual([c.prompt.node, c.prompt.input, c.prompt.type], ['119', 'value', 'textarea']);
  assert.equal(c.negative, undefined);                             // negatives are zeroed-out, not text
  // both static seeds: the Second Pass sampler (subgraph) and the rgthree Seed
  assert.deepEqual(c.seed.targets, [
    { node: '157:150', input: 'seed' }, { node: '12', input: 'seed' }
  ]);
  assert.deepEqual([c.width.node, c.width.input, c.width.default], ['11', 'width', 1152]);
  assert.deepEqual([c.height.node, c.height.input, c.height.default], ['11', 'height', 1536]);
  assert.deepEqual([c.enable_prompt_enhancer.node, c.enable_prompt_enhancer.type], ['121', 'checkbox']);
  assert.equal(c.add_lora_trigger_to_enhanced_prompt.node, '122');
  // the Power Lora Loader has no configured rows -> no lora control
  assert.equal(c.lora, undefined);
  assert.equal(c.image, undefined);                                // txt2img variant
});

test('buildManifest: Lustify (simple, no subgraphs) — both KSampler seeds, SD3 latent size', () => {
  const m = core.buildManifest(fixture('Lustify.json'), 'Lustify');
  assert.equal(m.media, 'image');
  assert.equal(m.output, '203');
  const c = m.controls;
  assert.deepEqual([c.prompt.node, c.prompt.input], ['198', 'text']);
  assert.equal(c.negative, undefined);
  assert.deepEqual(c.seed.targets, [{ node: '201', input: 'seed' }, { node: '207', input: 'seed' }]);
  assert.deepEqual([c.width.node, c.width.default, c.height.default], ['200', 1216, 832]);
});

test('buildManifest: Lustify img2img — adds the LoadImage select and the img2img toggle', () => {
  const m = core.buildManifest(fixture('Lustify_Final_img2img.json'), 'Lustify_Final_img2img');
  const c = m.controls;
  assert.deepEqual([c.image.node, c.image.input, c.image.type], ['211', 'image', 'select']);
  assert.equal(c.image.options_from, 'object_info:LoadImage:image');
  assert.deepEqual([c.use_img2img.node, c.use_img2img.type, c.use_img2img.default], ['214', 'checkbox', false]);
  assert.deepEqual([c.prompt.node, c.seed.targets.length], ['119', 2]);   // shared base intact
});

// ---------- ensureManifests: the scan-path hook ----------
const MINI_WF = JSON.stringify({
  nodes: [
    { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], outputs: [], widgets_values: ['a cat'] },
    { id: 2, type: 'KSampler', mode: 0, inputs: [], outputs: [], widgets_values: [42, 'fixed', 8, 1, 'euler', 'simple', 1] },
    { id: 3, type: 'SaveImage', mode: 0, inputs: [], outputs: [], widgets_values: ['ComfyUI'] }
  ],
  links: []
});

test('ensureManifests: creates missing manifests, skips fresh ones, regenerates stale ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, 'mini.json'), MINI_WF);
  let res = await core.ensureManifests(dir);
  assert.deepEqual(res, [{ name: 'mini', action: 'created' }]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'mini.manifest.json'), 'utf8'));
  assert.equal(m.controls.prompt.node, '1');
  assert.equal(m.controls.seed.node, '2');
  assert.equal(m.output, '3');
  assert.equal(m.generated.sourceHash, sha256(MINI_WF));
  // unchanged file -> untouched
  res = await core.ensureManifests(dir);
  assert.deepEqual(res, [{ name: 'mini', action: 'fresh' }]);
  // changed file -> regenerated
  const changed = MINI_WF.replace('a cat', 'a dog');
  fs.writeFileSync(path.join(dir, 'mini.json'), changed);
  res = await core.ensureManifests(dir);
  assert.deepEqual(res, [{ name: 'mini', action: 'updated' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'mini.manifest.json'), 'utf8')).generated.sourceHash, sha256(changed));
});

test('ensureManifests: hand-authored manifests (no generated marker) are never touched, even with force', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, 'hand.json'), MINI_WF);
  const handWritten = '{ "label": "Hand Tuned", "media": "image",\n  "controls": {} }\n';
  fs.writeFileSync(path.join(dir, 'hand.manifest.json'), handWritten);
  assert.deepEqual(await core.ensureManifests(dir), [{ name: 'hand', action: 'manual' }]);
  assert.deepEqual(await core.ensureManifests(dir, { force: true }), [{ name: 'hand', action: 'manual' }]);
  assert.equal(fs.readFileSync(path.join(dir, 'hand.manifest.json'), 'utf8'), handWritten);   // byte-for-byte
});

test('ensureManifests: force regenerates fresh auto-generated manifests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, 'mini.json'), MINI_WF);
  await core.ensureManifests(dir);
  assert.deepEqual(await core.ensureManifests(dir, { force: true }), [{ name: 'mini', action: 'updated' }]);
});

test('ensureManifests: unparseable workflow gets an error manifest, never throws; listWorkflows hides it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, 'good.json'), MINI_WF);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json');
  const res = await core.ensureManifests(dir);
  const byName = Object.fromEntries(res.map(r => [r.name, r]));
  assert.equal(byName.good.action, 'created');
  assert.equal(byName.broken.action, 'error');
  const errM = JSON.parse(fs.readFileSync(path.join(dir, 'broken.manifest.json'), 'utf8'));
  assert.ok(errM.error && errM.error.length);
  assert.equal(errM.generated.sourceHash, sha256('{ this is not json'));   // no retry until the file changes
  // the broken pair never reaches the workflow list; the good one does
  assert.deepEqual(core.listWorkflows(dir).map(w => w.name), ['good']);
  // and the next scan leaves it alone instead of re-parsing every time
  assert.equal((await core.ensureManifests(dir)).find(r => r.name === 'broken').action, 'fresh');
});

test('ensureManifests: API-format workflows get an explanatory error manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({ '1': { class_type: 'KSampler', inputs: {} } }));
  const res = await core.ensureManifests(dir);
  assert.equal(res[0].action, 'error');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'api.manifest.json'), 'utf8'));
  assert.match(m.error, /by hand/);
});

// ---------- generic, schema-driven extraction ----------
// The heuristics above only pick what is VISIBLE by default. Everything else
// with a static widget value is still extracted — typed from the server's
// /object_info spec when available (the frozen real capture below), from the
// stored JS value otherwise — and marked hidden for the picker UI to opt in.
const objectInfo = JSON.parse(fixture('object-info.json'));

test('generic extraction: the default VISIBLE set is identical to the curated one, with and without specs', () => {
  const expected = {
    'DR34ML4Y Img2Vid 2.0.json': [
      'prompt', 'negative', 'seed', 'width', 'height', 'length', 'fps', 'image', 't2v_mode',
      'lora', 'lora_strength', 'lora_on', 'lora_2', 'lora_2_strength',
      'vae', 'vae_2', 'vae_3', 'upscale_model', 'text_encoder', 'text_encoder_2', 'model',
      'cfg', 'sampler', 'sampler_2', 'sigmas', 'sigmas_2', 'sigmas_3', 'i2v_strength',
      'format', 'trim_to_audio'
    ],
    'Lustify Final.json': [
      'prompt', 'seed', 'width', 'height',
      'add_lora_trigger_to_enhanced_prompt', 'enable_prompt_enhancer',
      'model', 'upscale_model', 'text_encoder', 'vae', 'cfg', 'sampler'
    ],
    'Lustify.json': [
      'prompt', 'seed', 'width', 'height',
      'model', 'text_encoder', 'vae', 'upscale_model', 'cfg', 'sampler'
    ],
    'Lustify_Final_img2img.json': [
      'prompt', 'seed', 'width', 'height', 'image',
      'add_lora_trigger_to_enhanced_prompt', 'enable_prompt_enhancer', 'use_img2img',
      'model', 'upscale_model', 'text_encoder', 'vae', 'cfg', 'sampler'
    ]
  };
  for (const [f, keys] of Object.entries(expected)) {
    for (const info of [null, objectInfo]) {   // offline scan and spec-enriched scan agree
      const m = core.buildManifest(fixture(f), f.replace(/\.json$/, ''), info);
      const visible = Object.entries(m.controls).filter(([, c]) => !c.hidden).map(([k]) => k);
      assert.deepEqual(visible, keys, `${f} (info=${!!info}) visible set drifted`);
      assert.ok(Object.keys(m.controls).length > keys.length, `${f}: hidden potentials extracted too`);
    }
  }
});

test('generic extraction: unclaimed static widgets become hidden controls, spec-typed when known', () => {
  const c = core.buildManifest(fixture('DR34ML4Y Img2Vid 2.0.json'), 'x', objectInfo).controls;
  // VHS pix_fmt/crf are DYNAMIC widgets (absent from the static spec) -> typed from the stored value
  const [, pixFmt] = byTarget(c, '140', 'pix_fmt');
  assert.deepEqual([pixFmt.hidden, pixFmt.type, pixFmt.default], [true, 'text', 'yuv420p']);
  const [, crf] = byTarget(c, '140', 'crf');
  assert.deepEqual([crf.hidden, crf.type, crf.default], [true, 'float', 19]);
  // spec-typed FLOAT with server ranges, inside the subgraph
  const [, maxShift] = byTarget(c, '361:206', 'max_shift');
  assert.deepEqual([maxShift.hidden, maxShift.type, maxShift.min, maxShift.max, maxShift.step],
    [true, 'float', 0, 100, 0.01]);
  // combo -> select with options_from, zero code knowledge of the node type
  const [, encType] = byTarget(c, '346', 'type');
  assert.deepEqual([encType.hidden, encType.type, encType.options_from],
    [true, 'select', 'object_info:DualCLIPLoaderGGUF:type']);
  // every control (visible ones included) carries node metadata for the picker
  for (const [k, ctl] of Object.entries(c)) assert.ok(ctl.node_type, `${k} has node_type`);
  assert.equal(c.model.node_type, 'UnetLoaderGGUF');
  assert.equal(c.model.node_title, 'MODEL (dev GGUF)');
  // no input is targeted twice (hidden sweep must skip what heuristics claimed)
  const seen = new Set();
  for (const [k, ctl] of Object.entries(c)) {
    for (const t of ctl.targets || [{ node: ctl.node, input: ctl.input }]) {
      const id = t.node + ':' + t.input;
      assert.ok(!seen.has(id), `duplicate target ${id} (${k})`);
      seen.add(id);
    }
  }
});

test('generic extraction: Lustify hidden extras — weight_dtype combo, KSampler steps/denoise with spec ranges + tooltips', () => {
  const c = core.buildManifest(fixture('Lustify.json'), 'Lustify', objectInfo).controls;
  const [, wdt] = byTarget(c, '195', 'weight_dtype');
  assert.deepEqual([wdt.hidden, wdt.type, wdt.options_from], [true, 'select', 'object_info:UNETLoader:weight_dtype']);
  const [, steps] = byTarget(c, '201', 'steps');
  assert.deepEqual([steps.hidden, steps.type, steps.default, steps.min, steps.max], [true, 'int', 8, 1, 10000]);
  assert.ok(steps.tooltip && /steps/i.test(steps.tooltip), 'spec tooltip rides along');
  const [, den] = byTarget(c, '207', 'denoise');
  assert.deepEqual([den.type, den.default, den.min, den.max], ['float', 0.35, 0, 1]);
});

test('a NEVER-SEEN custom node type yields controls purely from its /object_info spec — zero code updates', () => {
  const wf = JSON.stringify({
    nodes: [
      { id: 1, type: 'FrobnicatorXL', mode: 0, title: 'Frob ✨', outputs: [{ name: 'IMAGE', links: [1] }],
        inputs: [
          { name: 'amount', widget: true, link: null },
          { name: 'algorithm', widget: true, link: null },
          { name: 'iterations', widget: true, link: null },
          { name: 'fancy_mode', widget: true, link: null },
          { name: 'recipe', widget: true, link: null }
        ],
        widgets_values: [0.7, 'bicubic', 3, true, 'two eggs'] },
      { id: 2, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 1 }], outputs: [], widgets_values: ['out'] }
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE']]
  });
  const info = {
    FrobnicatorXL: { input: { required: {
      amount: ['FLOAT', { default: 0.5, min: 0, max: 2, step: 0.05, tooltip: 'how hard to frob' }],
      algorithm: [['bicubic', 'bilinear'], {}],
      iterations: ['INT', { default: 1, min: 1, max: 10 }],
      fancy_mode: ['BOOLEAN', { default: false }],
      recipe: ['STRING', { multiline: true }]
    } } },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } } }
  };
  const m = core.buildManifest(wf, 'custom', info);
  assert.equal(m.generated.withInfo, true);
  const c = m.controls;
  const [amountKey, amount] = byTarget(c, '1', 'amount');
  assert.equal(amountKey, 'frob_amount');                          // slugged node title + input
  assert.deepEqual([amount.hidden, amount.type, amount.min, amount.max, amount.step, amount.default],
    [true, 'float', 0, 2, 0.05, 0.7]);
  assert.equal(amount.tooltip, 'how hard to frob');
  assert.deepEqual([amount.node_type, amount.node_title], ['FrobnicatorXL', 'Frob']);
  const [, algo] = byTarget(c, '1', 'algorithm');
  assert.deepEqual([algo.type, algo.options_from, algo.default],
    ['select', 'object_info:FrobnicatorXL:algorithm', 'bicubic']);
  const [, iters] = byTarget(c, '1', 'iterations');
  assert.deepEqual([iters.type, iters.min, iters.max, iters.step, iters.default], ['int', 1, 10, 1, 3]);
  const [, fancy] = byTarget(c, '1', 'fancy_mode');
  assert.deepEqual([fancy.type, fancy.default], ['checkbox', true]);
  const [, recipe] = byTarget(c, '1', 'recipe');
  assert.deepEqual([recipe.type, recipe.default], ['textarea', 'two eggs']);   // multiline STRING
  // classic positional export (no widget markers) still maps via spec order
  const [, prefix] = byTarget(c, '2', 'filename_prefix');
  assert.deepEqual([prefix.hidden, prefix.type, prefix.default], [true, 'text', 'out']);
});

test('buildManifest: every emitted control patches cleanly into the converted graph', () => {
  // end-to-end coherence: the ids the manifest emits must exist in the API
  // graph uiGraphToApi produces, and patchWorkflow must accept every control
  const files = ['DR34ML4Y Img2Vid 2.0.json', 'Lustify Final.json', 'Lustify.json', 'Lustify_Final_img2img.json'];
  for (const f of files) {
    const text = fixture(f);
    const g = JSON.parse(text);
    const m = core.buildManifest(text, f.replace(/\.json$/, ''));
    const info = {};
    for (const n of core.flattenUiGraph(g).nodes) {
      info[n.type] = info[n.type] || { input: { required: {} } };
      for (const inp of n.inputs || []) info[n.type].input.required[inp.name] = ['ANY', {}];
    }
    const api = core.uiGraphToApi(g, info);
    assert.ok(api[m.output], `${f}: manifest output node ${m.output} missing from API graph`);
    const values = {};
    for (const [key, ctl] of Object.entries(m.controls)) {
      values[key] = ctl.type === 'checkbox' ? true
        : ctl.type === 'seed' ? 7
        : ctl.type === 'int' || ctl.type === 'float' ? (ctl.default != null ? ctl.default : 1)
        : 'test-value';
    }
    const patched = core.patchWorkflow(api, m, values);            // throws on any bad node ref
    for (const ctl of Object.values(m.controls)) {
      for (const t of ctl.targets || [{ node: ctl.node, input: ctl.input }])
        assert.ok(patched[t.node], `${f}: control target ${t.node} missing`);
    }
  }
});
