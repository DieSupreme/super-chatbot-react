// Control overrides: the user's shown/hidden choices and custom labels for
// generated manifests, in a sidecar next to the workflow pairs
// (<workflows>/control-overrides.json, { [wf]: { "<node>:<input>": { hidden, label } } }).
// Applied at READ time (listWorkflows) so manifest regeneration can never wipe
// them — the same survival rule as prompt presets. Hand-authored manifests are
// exempt from the whole mechanism.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../../src/main/comfy-core.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
const file = (dir) => path.join(dir, 'control-overrides.json');
const byTarget = (controls, node, input) => Object.entries(controls).find(([, c]) =>
  (c.targets || [{ node: c.node, input: c.input }]).some(t => t.node === node && t.input === input)) || [];

// widget-marked mini workflow: prompt + cfg/sampler are default-visible;
// steps/scheduler/denoise land as hidden potentials
const WF = JSON.stringify({
  nodes: [
    { id: 1, type: 'CLIPTextEncode', mode: 0, outputs: [],
      inputs: [{ name: 'text', widget: true, link: null }], widgets_values: ['a cat'] },
    { id: 2, type: 'KSampler', mode: 0, outputs: [],
      inputs: [
        { name: 'seed', widget: true, link: null },
        { name: 'steps', widget: true, link: null },
        { name: 'cfg', widget: true, link: null },
        { name: 'sampler_name', widget: true, link: null },
        { name: 'scheduler', widget: true, link: null },
        { name: 'denoise', widget: true, link: null }
      ],
      widgets_values: [42, 'fixed', 8, 1, 'euler', 'simple', 1] },
    { id: 3, type: 'SaveImage', mode: 0, inputs: [], outputs: [], widgets_values: ['x'] }
  ],
  links: []
});

test('setControlOverride: unhide + relabel apply at read time and survive forced regeneration', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'mini.json'), WF);
  await core.ensureManifests(dir);

  let wf = core.listWorkflows(dir)[0];
  assert.equal(wf.generated, true);
  const [stepsKey, steps] = byTarget(wf.controls, '2', 'steps');
  assert.ok(stepsKey, 'steps extracted as a potential control');
  assert.equal(steps.hidden, true);

  core.setControlOverride(dir, 'mini', '2:steps', { hidden: false, label: 'Steps!' });
  wf = core.listWorkflows(dir)[0];
  let [, s2] = byTarget(wf.controls, '2', 'steps');
  assert.ok(!s2.hidden, 'unhidden by override');
  assert.equal(s2.label, 'Steps!');

  // default-visible controls can be hidden the same way
  core.setControlOverride(dir, 'mini', '1:text', { hidden: true });
  wf = core.listWorkflows(dir)[0];
  assert.equal(wf.controls.prompt.hidden, true);

  // rescan (forced regeneration) must never wipe the choices — they live in
  // the sidecar and re-apply on read
  await core.ensureManifests(dir, { force: true });
  wf = core.listWorkflows(dir)[0];
  [, s2] = byTarget(wf.controls, '2', 'steps');
  assert.ok(!s2.hidden);
  assert.equal(s2.label, 'Steps!');
  assert.equal(wf.controls.prompt.hidden, true);
});

test('setControlOverride: label null clears the custom label; empty entries drop from the file', () => {
  const dir = tmp();
  core.setControlOverride(dir, 'mini', '2:steps', { hidden: false, label: 'X' });
  core.setControlOverride(dir, 'mini', '2:steps', { label: null });
  let saved = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  assert.deepEqual(saved, { mini: { '2:steps': { hidden: false } } });
  core.setControlOverride(dir, 'mini', '2:steps', { hidden: true });   // back to the extraction default? still an explicit choice
  saved = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  assert.deepEqual(saved, { mini: { '2:steps': { hidden: true } } });
});

test('overrides: missing file is empty; corrupt file reads empty with an error note; never scanned as a workflow', async () => {
  const dir = tmp();
  assert.deepEqual(core.readControlOverrides(dir), { overrides: {} });
  fs.writeFileSync(file(dir), '{ nope');
  const r = core.readControlOverrides(dir);
  assert.deepEqual(r.overrides, {});
  assert.match(r.error, /control-overrides/);
  // a save after corruption starts clean
  core.setControlOverride(dir, 'mini', '2:steps', { hidden: false });
  assert.deepEqual(core.readControlOverrides(dir).overrides, { mini: { '2:steps': { hidden: false } } });
  // the sidecar never becomes a "workflow"
  const res = await core.ensureManifests(dir);
  assert.ok(!res.some(x => x.name === 'control-overrides'));
  assert.ok(!fs.existsSync(path.join(dir, 'control-overrides.manifest.json')));
});

test('overrides: hand-authored manifests are exempt', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'hand.json'), WF);
  fs.writeFileSync(path.join(dir, 'hand.manifest.json'), JSON.stringify({
    label: 'Hand', media: 'image', controls: { prompt: { node: '1', input: 'text', type: 'text' } }
  }));
  core.setControlOverride(dir, 'hand', '1:text', { hidden: true, label: 'Nope' });
  const wf = core.listWorkflows(dir)[0];
  assert.equal(wf.generated, false);
  assert.equal(wf.controls.prompt.hidden, undefined);   // override NOT applied
  assert.equal(wf.controls.prompt.label, undefined);
});

test('ensureManifests: an offline-built manifest upgrades once specs become available, then stays fresh', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'mini.json'), WF);
  await core.ensureManifests(dir);                       // no getInfo -> built without specs
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'mini.manifest.json'), 'utf8'));
  assert.equal(read().generated.withInfo, false);
  let [, steps] = byTarget(read().controls, '2', 'steps');
  assert.equal(steps.min, undefined);                    // no spec, no invented range

  const getInfo = async (types) => {
    assert.ok(types.includes('KSampler'));
    return { KSampler: { input: { required: { steps: ['INT', { default: 20, min: 1, max: 10000 }] } } } };
  };
  // same hash, but specs are now reachable -> regenerate richer
  let res = await core.ensureManifests(dir, { getInfo });
  assert.deepEqual(res, [{ name: 'mini', action: 'updated' }]);
  assert.equal(read().generated.withInfo, true);
  [, steps] = byTarget(read().controls, '2', 'steps');
  assert.deepEqual([steps.type, steps.min, steps.max], ['int', 1, 10000]);
  // now fresh on every following scan — with specs, and offline again too
  assert.deepEqual(await core.ensureManifests(dir, { getInfo }), [{ name: 'mini', action: 'fresh' }]);
  assert.deepEqual(await core.ensureManifests(dir), [{ name: 'mini', action: 'fresh' }]);
  // a getInfo that reports offline (null) never downgrades or loops regeneration
  assert.deepEqual(await core.ensureManifests(dir, { getInfo: async () => null }), [{ name: 'mini', action: 'fresh' }]);
});
