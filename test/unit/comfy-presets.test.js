// Prompt presets: named per-workflow snapshots of the prompt controls, all in
// ONE file next to the workflow pairs (<workflows>/prompt-presets.json) — never
// inside the manifests, which are regenerated from the graph and must stay
// disposable. Missing/corrupt file reads as empty (with an error note for the
// log, never a throw); the next save recreates it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../../src/main/comfy-core.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
const file = (dir) => path.join(dir, 'prompt-presets.json');

test('save creates the file; presets are keyed per workflow', () => {
  const dir = tmp();
  const { list } = core.savePromptPreset(dir, 'DR34ML4Y Img2Vid 2.0', 'city night',
    { prompt: 'neon city, slow pan', negative: 'blurry, watermark' });
  assert.deepEqual(list, [{ name: 'city night', values: { prompt: 'neon city, slow pan', negative: 'blurry, watermark' } }]);
  assert.ok(fs.existsSync(file(dir)));

  core.savePromptPreset(dir, 'Lustify', 'portrait', { prompt: 'studio portrait' });
  const { presets, error } = core.readPromptPresets(dir);
  assert.equal(error, undefined);
  assert.deepEqual(presets['DR34ML4Y Img2Vid 2.0'].map(p => p.name), ['city night']);
  assert.deepEqual(presets['Lustify'].map(p => p.name), ['portrait']);
});

test('saving an existing name overwrites its values; a fixed seed rides along verbatim', () => {
  const dir = tmp();
  core.savePromptPreset(dir, 'wf', 'good one', { prompt: 'v1' });
  const { list } = core.savePromptPreset(dir, 'wf', 'good one', { prompt: 'v2', seed: 424242 });
  assert.deepEqual(list, [{ name: 'good one', values: { prompt: 'v2', seed: 424242 } }]);
});

test('rename keeps values; renaming onto an existing name or to blank throws', () => {
  const dir = tmp();
  core.savePromptPreset(dir, 'wf', 'a', { prompt: 'pa' });
  core.savePromptPreset(dir, 'wf', 'b', { prompt: 'pb' });
  const { list } = core.renamePromptPreset(dir, 'wf', 'a', 'a2');
  assert.deepEqual(list.map(p => p.name), ['a2', 'b']);
  assert.equal(list[0].values.prompt, 'pa');
  assert.throws(() => core.renamePromptPreset(dir, 'wf', 'a2', 'b'), /already exists/);
  assert.throws(() => core.renamePromptPreset(dir, 'wf', 'a2', '  '), /name/);
  assert.throws(() => core.renamePromptPreset(dir, 'wf', 'nope', 'x'), /no preset/);
});

test('delete removes one preset and leaves the rest (other workflows untouched)', () => {
  const dir = tmp();
  core.savePromptPreset(dir, 'wf', 'a', { prompt: 'pa' });
  core.savePromptPreset(dir, 'wf', 'b', { prompt: 'pb' });
  core.savePromptPreset(dir, 'other', 'keep', { prompt: 'k' });
  const { list } = core.deletePromptPreset(dir, 'wf', 'a');
  assert.deepEqual(list.map(p => p.name), ['b']);
  assert.deepEqual(core.readPromptPresets(dir).presets.other.map(p => p.name), ['keep']);
});

test('missing file reads as empty; corrupt file reads as empty with an error note; save recreates it', () => {
  const dir = tmp();
  assert.deepEqual(core.readPromptPresets(dir), { presets: {} });

  fs.writeFileSync(file(dir), '{ this is not json');
  const r = core.readPromptPresets(dir);
  assert.deepEqual(r.presets, {});
  assert.match(r.error, /prompt-presets/);

  // a save after corruption starts clean and recreates the file
  const { list } = core.savePromptPreset(dir, 'wf', 'p1', { prompt: 'x' });
  assert.deepEqual(list, [{ name: 'p1', values: { prompt: 'x' } }]);
  assert.deepEqual(core.readPromptPresets(dir), { presets: { wf: [{ name: 'p1', values: { prompt: 'x' } }] } });
});

test('malformed entries are dropped on read, never a crash', () => {
  const dir = tmp();
  fs.writeFileSync(file(dir), JSON.stringify({
    wf: [null, 42, { name: 7, values: {} }, { name: 'ok', values: { prompt: 'p' } }, { name: 'no-values' }],
    notAList: 'nope',
    empty: []
  }));
  const { presets, error } = core.readPromptPresets(dir);
  assert.equal(error, undefined);
  assert.deepEqual(presets.wf, [{ name: 'ok', values: { prompt: 'p' } }]);
  assert.equal(presets.notAList, undefined);
  assert.deepEqual(presets.empty, []);
});

test('ensureManifests ignores prompt-presets.json — presets never become a workflow', async () => {
  const dir = tmp();
  core.savePromptPreset(dir, 'wf', 'p', { prompt: 'x' });
  const res = await core.ensureManifests(dir);
  assert.ok(!res.some(r => r.name === 'prompt-presets'), 'preset file must not be scanned as a workflow');
  assert.ok(!fs.existsSync(path.join(dir, 'prompt-presets.manifest.json')), 'no junk manifest sidecar');
});

test('blank preset names are rejected on save', () => {
  const dir = tmp();
  assert.throws(() => core.savePromptPreset(dir, 'wf', '', { prompt: 'x' }), /name/);
  assert.throws(() => core.savePromptPreset(dir, 'wf', '   ', { prompt: 'x' }), /name/);
  assert.ok(!fs.existsSync(file(dir)), 'a rejected save must not create the file');
});
