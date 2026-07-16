// Working control values — the implicit per-workflow DRAFT (distinct from
// prompt presets, which are named snapshots): every edit the user makes in
// the panel lands in <workflows>/control-values.json so tab switches,
// workflow switches and app restarts never lose typed state. Same sidecar
// contract as presets/overrides: corrupt file reads empty with an error note,
// a save recreates it, and the file is never scanned as a workflow.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../../src/main/comfy-core.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vals-'));
const file = (dir) => path.join(dir, 'control-values.json');

test('save/read roundtrip, keyed per workflow; a save replaces that workflow draft wholesale', () => {
  const dir = tmp();
  core.saveControlValues(dir, 'wf-a', { prompt: 'neon city', width: 640, t2v: true });
  core.saveControlValues(dir, 'wf-b', { prompt: 'other' });
  let { values, error } = core.readControlValues(dir);
  assert.equal(error, undefined);
  assert.deepEqual(values['wf-a'], { prompt: 'neon city', width: 640, t2v: true });
  assert.deepEqual(values['wf-b'], { prompt: 'other' });

  // saving again replaces (a control reset to default simply vanishes)
  core.saveControlValues(dir, 'wf-a', { prompt: 'revised' });
  values = core.readControlValues(dir).values;
  assert.deepEqual(values['wf-a'], { prompt: 'revised' });
  assert.deepEqual(values['wf-b'], { prompt: 'other' });   // other workflows untouched
});

test('non-primitive and undefined values never land on disk', () => {
  const dir = tmp();
  core.saveControlValues(dir, 'wf', { ok: 1, bad: { nested: true }, worse: [1], gone: undefined, nul: null });
  assert.deepEqual(core.readControlValues(dir).values.wf, { ok: 1 });
});

test('clearControlValues drops one workflow draft and leaves the rest', () => {
  const dir = tmp();
  core.saveControlValues(dir, 'wf-a', { prompt: 'x' });
  core.saveControlValues(dir, 'wf-b', { prompt: 'y' });
  core.clearControlValues(dir, 'wf-a');
  const { values } = core.readControlValues(dir);
  assert.equal(values['wf-a'], undefined);
  assert.deepEqual(values['wf-b'], { prompt: 'y' });
});

test('pruneControlValues drops stale keys that no longer exist in the manifest controls', () => {
  const controls = { prompt: { node: '1', input: 'text' }, width: { node: '2', input: 'width' } };
  const pruned = core.pruneControlValues({ prompt: 'keep', width: 640, ghost: 42, old_cfg: 3 }, controls);
  assert.deepEqual(pruned, { prompt: 'keep', width: 640 });
  assert.deepEqual(core.pruneControlValues({ a: 1 }, {}), {});
  assert.deepEqual(core.pruneControlValues(null, controls), {});
});

test('missing file reads empty; corrupt file reads empty with an error note; save recreates it', () => {
  const dir = tmp();
  assert.deepEqual(core.readControlValues(dir), { values: {} });
  fs.writeFileSync(file(dir), '{ nope');
  const r = core.readControlValues(dir);
  assert.deepEqual(r.values, {});
  assert.match(r.error, /control-values/);
  core.saveControlValues(dir, 'wf', { prompt: 'fresh' });
  assert.deepEqual(core.readControlValues(dir), { values: { wf: { prompt: 'fresh' } } });
});

test('malformed workflow entries are dropped on read, never a crash', () => {
  const dir = tmp();
  fs.writeFileSync(file(dir), JSON.stringify({
    good: { prompt: 'p', n: 1, b: false },
    notObject: 'nope',
    arr: [1, 2],
    withJunk: { fine: 'x', obj: { no: true } }
  }));
  const { values, error } = core.readControlValues(dir);
  assert.equal(error, undefined);
  assert.deepEqual(values.good, { prompt: 'p', n: 1, b: false });
  assert.equal(values.notObject, undefined);
  assert.equal(values.arr, undefined);
  assert.deepEqual(values.withJunk, { fine: 'x' });
});

test('ensureManifests never scans control-values.json as a workflow', async () => {
  const dir = tmp();
  core.saveControlValues(dir, 'wf', { prompt: 'x' });
  const res = await core.ensureManifests(dir);
  assert.ok(!res.some(r => r.name === 'control-values'));
  assert.ok(!fs.existsSync(path.join(dir, 'control-values.manifest.json')));
});
