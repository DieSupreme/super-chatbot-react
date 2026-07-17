// Generation fidelity: the graph the app POSTs must equal a pure conversion
// of the workflow .json except where a value was DELIBERATELY changed in the
// app. Covers the pruning layer (untouched controls never patch), the
// dry-run diff tool itself, the LTX2LoraLoaderAdvanced (comfyui-kjnodes)
// widget-order conversion, and VHS_VideoCombine's dynamic per-format widgets
// that the static /object_info spec does not list.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../src/main/comfy-core.js');

const fixture = (f) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');
const objectInfo = JSON.parse(fixture('object-info.json'));

// mirror of the renderer's defaultsFor (VideoPanel.jsx): the payload a
// freshly-opened panel sends when the user touches nothing
function rendererDefaults(controls) {
  const v = {};
  for (const [key, ctl] of Object.entries(controls || {})) {
    if (ctl.type === 'text' || ctl.type === 'textarea') v[key] = '';
    else if (ctl.type === 'seed') v[key] = -1;
    else if (ctl.type === 'checkbox') v[key] = ctl.default != null ? !!ctl.default : false;
    else if (ctl.type === 'select' || ctl.type === 'readonly') v[key] = ctl.default != null ? ctl.default : '';
    else v[key] = ctl.default != null ? ctl.default : (ctl.min != null ? ctl.min : 0);
  }
  return v;
}

// ---------- pruneUnchangedValues ----------
test('pruneUnchangedValues: default-equal values drop; changed, defaultless and seed values pass', () => {
  const controls = {
    cfg: { node: '1', input: 'cfg', type: 'float', default: 1 },
    sigmas: { node: '2', input: 'sigmas', type: 'text', default: '1.0, 0.5, 0.0' },
    prompt: { node: '3', input: 'text', type: 'textarea' },              // no default
    seed: { node: '4', input: 'seed', type: 'seed', default: 420 },      // realized later — never pruned
    on: { node: '5', input: 'value', type: 'checkbox', default: true }
  };
  const out = core.pruneUnchangedValues({
    cfg: 1,                          // = default -> dropped
    sigmas: '1.0, 0.5, 0.0',         // = default -> dropped
    prompt: 'a cat',                 // no default -> kept
    seed: 420,                       // seed type -> kept even though = default
    on: false                        // differs -> kept
  }, controls);
  assert.deepEqual(out, { prompt: 'a cat', seed: 420, on: false });
  // strictness: 0.30000001 !== 0.3, '1' !== 1 — near-misses are user changes
  assert.deepEqual(core.pruneUnchangedValues({ cfg: 1.0000001 }, controls), { cfg: 1.0000001 });
  assert.deepEqual(core.pruneUnchangedValues({ cfg: '1' }, controls), { cfg: '1' });
  // unknown keys (no control) pass through untouched
  assert.deepEqual(core.pruneUnchangedValues({ ghost: 5 }, controls), { ghost: 5 });
  assert.deepEqual(core.pruneUnchangedValues(null, controls), {});
});

// ---------- diffApiGraphs ----------
test('diffApiGraphs: value changes, added inputs and node presence all surface', () => {
  const a = { 1: { class_type: 'KSampler', inputs: { cfg: 1, seed: 5, model: ['2', 0] } } };
  const b = { 1: { class_type: 'KSampler', inputs: { cfg: 3, seed: 5, model: ['2', 0], steps: 8 } } };
  const d = core.diffApiGraphs(a, b);
  assert.deepEqual(d, [
    { node: '1', class_type: 'KSampler', input: 'cfg', from: 1, to: 3 },
    { node: '1', class_type: 'KSampler', input: 'steps', from: undefined, to: 8 }
  ]);
  assert.deepEqual(core.diffApiGraphs(a, a), []);
  const missing = core.diffApiGraphs(a, {});
  assert.deepEqual(missing, [{ node: '1', input: null, from: 'node present', to: 'node missing' }]);
});

// ---------- LTX2LoraLoaderAdvanced (comfyui-kjnodes) ----------
// The node that replaced the rgthree Power Lora Loader in DR34ML3Y Vid.
// Its /object_info order interleaves a connection between widgets
// (lora_name, model, strength_model, video, ...) — every strength must land
// on its named input, in BOTH export styles.
const LTX2_WIDGETS = [
  ['lora_name', 'COMBO'], ['strength_model', 'FLOAT'], ['video', 'FLOAT'],
  ['video_to_audio', 'FLOAT'], ['audio', 'FLOAT'], ['audio_to_video', 'FLOAT'], ['other', 'FLOAT']
];
const LTX2_WV = ['DR34ML4Y_LT3X_V3.safetensors', 0.9, 1, 0.25, 0, 0.5, 0.75];   // all distinct on purpose
const LTX2_EXPECT = {
  lora_name: 'DR34ML4Y_LT3X_V3.safetensors', strength_model: 0.9, video: 1,
  video_to_audio: 0.25, audio: 0, audio_to_video: 0.5, other: 0.75
};

test('LTX2LoraLoaderAdvanced: real /object_info spec still matches the mapping this test assumes', () => {
  const spec = objectInfo.LTX2LoraLoaderAdvanced;
  assert.ok(spec, 'fixture must carry the real LTX2LoraLoaderAdvanced spec');
  // widget-bearing required inputs, in spec order, skipping connections
  const widgets = Object.entries(spec.input.required)
    .filter(([, s]) => Array.isArray(s) && (Array.isArray(s[0]) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(s[0])))
    .map(([k]) => k);
  assert.deepEqual(widgets, LTX2_WIDGETS.map(([k]) => k),
    'kjnodes changed the widget order — update the conversion expectations');
});

test('LTX2LoraLoaderAdvanced: widget-marked export lands every strength on its named input', () => {
  const graph = {
    nodes: [{
      id: 301, type: 'LTX2LoraLoaderAdvanced', mode: 0, title: 'YOUR LORA',
      inputs: [
        { name: 'model', type: 'MODEL', link: null },
        { name: 'opt_lora_path', type: 'STRING', link: null },
        { name: 'blocks', type: 'SELECTEDDITBLOCKS', link: null },
        ...LTX2_WIDGETS.map(([name, type]) => ({ name, type, link: null, widget: { name } }))
      ],
      outputs: [], widgets_values: LTX2_WV
    }],
    links: []
  };
  const api = core.uiGraphToApi(graph, objectInfo);
  assert.deepEqual(api['301'].inputs, LTX2_EXPECT);
  assert.equal(api['301'].class_type, 'LTX2LoraLoaderAdvanced');
});

test('LTX2LoraLoaderAdvanced: classic positional export (no widget markers) maps identically', () => {
  const graph = {
    nodes: [{
      id: 301, type: 'LTX2LoraLoaderAdvanced', mode: 0,
      inputs: [{ name: 'model', type: 'MODEL', link: null }],
      outputs: [], widgets_values: LTX2_WV
    }],
    links: []
  };
  const api = core.uiGraphToApi(graph, objectInfo);
  assert.deepEqual(api['301'].inputs, LTX2_EXPECT);
});

test('LTX2LoraLoaderAdvanced: manifest patching never clobbers untouched strengths', () => {
  const text = fixture('DR34ML3Y Vid.json');
  const manifest = core.buildManifest(text, 'DR34ML3Y Vid', objectInfo);
  const graph = JSON.parse(text);
  const api = core.uiGraphToApi(graph, objectInfo);
  // the six strengths as stored in the file
  assert.deepEqual(api['301'].inputs, {
    model: ['134', 0], lora_name: 'DR34ML4Y_LT3X_V3.safetensors',
    strength_model: 1, video: 1, video_to_audio: 0, audio: 0, audio_to_video: 0, other: 1
  });
  // untouched panel -> pruned to nothing that targets node 301 -> byte-identical
  const sent = core.pruneUnchangedValues(rendererDefaults(manifest.controls), manifest.controls);
  const patched = core.patchWorkflow(api, manifest, sent);
  assert.deepEqual(patched['301'].inputs, api['301'].inputs);
  // one strength deliberately changed patches ONLY that input
  const [audioKey] = Object.entries(manifest.controls)
    .find(([, c]) => c.node === '301' && c.input === 'audio');
  const patched2 = core.patchWorkflow(api, manifest, { ...sent, [audioKey]: 0.7 });
  assert.deepEqual(patched2['301'].inputs, { ...api['301'].inputs, audio: 0.7 });
});

// ---------- VHS_VideoCombine dynamic widgets ----------
test('uiGraphToApi: named-object exports keep dynamic per-format widgets (crf, trim_to_audio), drop UI-only objects', () => {
  const graph = {
    nodes: [{
      id: 140, type: 'VHS_VideoCombine', mode: 0,
      inputs: [{ name: 'images', type: 'IMAGE', link: null }, { name: 'audio', type: 'AUDIO', link: null }],
      outputs: [],
      widgets_values: {
        frame_rate: 24, loop_count: 0, filename_prefix: 'LTX', format: 'video/h264-mp4',
        pix_fmt: 'yuv420p', crf: 19, save_metadata: true, trim_to_audio: true,
        pingpong: false, save_output: true,
        videopreview: { hidden: false, paused: false, params: {} }   // UI-only, object-valued
      }
    }],
    links: []
  };
  const api = core.uiGraphToApi(graph, objectInfo);
  const inputs = api['140'].inputs;
  // the dynamic h264-mp4 extras the static spec does not list
  assert.equal(inputs.crf, 19);
  assert.equal(inputs.trim_to_audio, true);
  assert.equal(inputs.save_metadata, true);
  assert.equal(inputs.pix_fmt, 'yuv420p');
  // UI-only object widget never reaches the server
  assert.equal(inputs.videopreview, undefined);
  // spec-known widgets still present
  assert.equal(inputs.frame_rate, 24);
  assert.equal(inputs.format, 'video/h264-mp4');
});

// ---------- dry run over the real workflow library ----------
test('dryRunGraph: untouched panel produces ZERO diffs and annotates deliberate changes, all four workflows', () => {
  for (const f of ['DR34ML3Y Vid.json', 'DR34ML4Y Img2Vid 2.0.json', 'Lustify Final.json', 'Lustify.json', 'Lustify_Final_img2img.json']) {
    const text = fixture(f);
    const name = f.replace(/\.json$/, '');
    const manifest = core.buildManifest(text, name, objectInfo);
    const graph = JSON.parse(text);
    const sent = rendererDefaults(manifest.controls);
    for (const [k, c] of Object.entries(manifest.controls)) if (c.type === 'seed') delete sent[k];   // realized separately
    const pruned = core.pruneUnchangedValues(sent, manifest.controls);
    const r = core.dryRunGraph(graph, manifest, pruned, objectInfo);
    assert.deepEqual(r.diff, [], `${f}: untouched controls must not change the POSTed graph`);
    // a deliberate width change shows up as exactly one annotated diff
    if (manifest.controls.width) {
      const r2 = core.dryRunGraph(graph, manifest, { ...pruned, width: 640 }, objectInfo);
      assert.equal(r2.diff.length, 1, f);
      assert.equal(r2.diff[0].control, 'width', f);
      assert.equal(r2.diff[0].to, 640, f);
    }
  }
});

test('dryRunGraph: dropped wires are reported, and the known Lustify img2img one is the bypassed GGUF branch', () => {
  const okNames = ['DR34ML3Y Vid.json', 'DR34ML4Y Img2Vid 2.0.json', 'Lustify Final.json', 'Lustify.json'];
  for (const f of okNames) {
    const graph = JSON.parse(fixture(f));
    assert.deepEqual(core.listDroppedWires(graph), [], `${f}: no wire should silently drop`);
  }
  const dropped = core.listDroppedWires(JSON.parse(fixture('Lustify_Final_img2img.json')));
  // the switch's on_true comes from a BYPASSED UnetLoaderGGUF with nothing to
  // forward — the browser's own export drops it the same way (switch is false)
  assert.deepEqual(dropped, [{ node: '128', class_type: 'ComfySwitchNode', input: 'on_true', type: 'MODEL' }]);
});

// ---------- seed extraction: identical values still move together ----------
test('seed split: identical stored seeds stay ONE multi-target control; differing seeds split per pass', () => {
  const mk = (s1, s2) => JSON.stringify({
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], outputs: [{ links: [1] }], widgets_values: ['a cat'] },
      { id: 2, type: 'KSampler', mode: 0, title: 'first',
        inputs: [{ name: 'positive', type: 'CONDITIONING', link: 1 }],
        outputs: [{ links: [2] }], widgets_values: [s1, 'fixed', 8, 1, 'euler', 'simple', 1] },
      { id: 3, type: 'KSampler', mode: 0, title: 'second',
        inputs: [{ name: 'latent_image', type: 'LATENT', link: 2 }],
        outputs: [], widgets_values: [s2, 'fixed', 8, 1, 'euler', 'simple', 1] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [], outputs: [], widgets_values: ['x'] }
    ],
    links: [[1, 1, 0, 2, 0, 'CONDITIONING'], [2, 2, 0, 3, 0, 'LATENT']]
  });
  const same = core.buildManifest(mk(42, 42), 'same').controls;
  assert.deepEqual(same.seed.targets, [{ node: '2', input: 'seed' }, { node: '3', input: 'seed' }]);
  assert.equal(same.seed_2, undefined);
  const diff = core.buildManifest(mk(42, 43), 'diff').controls;
  assert.deepEqual([diff.seed.node, diff.seed.default, diff.seed.type], ['2', 42, 'seed']);
  assert.deepEqual([diff.seed_2.node, diff.seed_2.default, diff.seed_2.type], ['3', 43, 'seed']);
});
