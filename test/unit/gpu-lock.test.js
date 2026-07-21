// gpu-lock: the one-GPU mutual exclusion. A claim must refuse while another
// backend is mid-generation, stop a running other backend before proceeding,
// FAIL if that stop couldn't take the backend down or left its port occupied,
// and serialize concurrent claims so two Start clicks can't both spawn.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Fresh module instance per test (module-level `backends`/`chain` state).
function freshLock() {
  delete require.cache[require.resolve('../../src/main/gpu-lock.js')];
  return require('../../src/main/gpu-lock.js');
}

test('claim refuses while another backend is mid-generation', async () => {
  const lock = freshLock();
  let stopped = false;
  lock.register('Forge', { stop: async () => { stopped = true; return { ok: true }; }, isBusy: () => true, isRunning: () => true });
  lock.register('ComfyUI', { stop: async () => ({ ok: true }), isBusy: () => false, isRunning: () => false });
  await assert.rejects(() => lock.claim('ComfyUI'), /mid-generation/);
  assert.strictEqual(stopped, false, 'a busy backend is never force-stopped');
});

test('claim stops a running other backend and resolves', async () => {
  const lock = freshLock();
  let stopped = 0;
  lock.register('Forge', { stop: async () => { stopped++; return { ok: true, portFree: true }; }, isBusy: () => false, isRunning: () => true });
  lock.register('ComfyUI', { stop: async () => ({ ok: true }), isBusy: () => false, isRunning: () => false });
  await lock.claim('ComfyUI');
  assert.strictEqual(stopped, 1);
});

test('claim fails when the other backend could not be stopped (e.g. unmanaged)', async () => {
  const lock = freshLock();
  lock.register('Forge', { stop: async () => ({ ok: true }), isBusy: () => false, isRunning: () => false });
  lock.register('ComfyUI', { stop: async () => ({ ok: false, unmanaged: true, error: 'started outside this app' }), isBusy: () => false, isRunning: () => true });
  await assert.rejects(() => lock.claim('Forge'), /started outside this app/);
});

test('claim fails when the stopped backend left its port occupied', async () => {
  const lock = freshLock();
  lock.register('Forge', { stop: async () => ({ ok: true }), isBusy: () => false, isRunning: () => false });
  lock.register('ComfyUI', { stop: async () => ({ ok: true, portFree: false }), isBusy: () => false, isRunning: () => true });
  await assert.rejects(() => lock.claim('Forge'), /port is still in use/);
});

test('claims serialize: two near-simultaneous claims do not interleave across stop()', async () => {
  const lock = freshLock();
  const order = [];
  let comfyRunning = false;
  // ComfyUI's stop is slow; if claims interleave, the second would see it not
  // running yet and skip the stop. Serialized, the second waits for the first.
  lock.register('ComfyUI', {
    stop: async () => { order.push('stop:start'); await new Promise(r => setTimeout(r, 30)); comfyRunning = false; order.push('stop:end'); return { ok: true, portFree: true }; },
    isBusy: () => false,
    isRunning: () => comfyRunning
  });
  lock.register('Forge', { stop: async () => ({ ok: true, portFree: true }), isBusy: () => false, isRunning: () => false });
  comfyRunning = true;
  const a = lock.claim('Forge');
  const b = lock.claim('Forge');
  await Promise.all([a, b]);
  // the first claim's stop must fully complete before the second claim runs
  assert.deepStrictEqual(order, ['stop:start', 'stop:end']);
});
