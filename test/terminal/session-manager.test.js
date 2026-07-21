const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { createSessionManager } = require('../../src/terminal/session-manager');
const fakePty = require('./fake-pty');

const tick = () => new Promise(r => setImmediate(r));

test('create assigns incrementing ids and resolves an existing cwd', () => {
  const sm = createSessionManager({ pty: fakePty });
  const a = sm.create({ cwd: os.tmpdir(), label: 'A' });
  const b = sm.create({ label: 'B' });
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  assert.strictEqual(a.cwd, os.tmpdir());
  assert.strictEqual(a.cwdFallback, false);
  sm.killAll();
});

test('emits banner data and buffers it into replay', async () => {
  const sm = createSessionManager({ pty: fakePty });
  const seen = [];
  sm.on('data', p => seen.push(p));
  const { id } = sm.create({ label: 'A' });
  await tick();
  assert.ok(seen.some(p => p.id === id && p.data.includes('BANNER')));
  assert.ok(sm.replay(id).includes('BANNER'));
  sm.killAll();
});

test('write echoes back as data and grows the ring', async () => {
  const sm = createSessionManager({ pty: fakePty });
  const { id } = sm.create({});
  await tick();
  sm.write(id, 'hi');
  assert.ok(sm.replay(id).includes('ECHO:hi'));
  sm.killAll();
});

test('ring buffer is capped at 256KB and keeps the tail', async () => {
  const sm = createSessionManager({ pty: fakePty });
  const { id } = sm.create({});
  await tick();
  sm.write(id, 'x'.repeat(300 * 1024));
  const r = sm.replay(id);
  assert.ok(r.length <= 256 * 1024);
  assert.ok(r.endsWith('x'));
  sm.killAll();
});

test('setPinned + list reflects the pin flag', () => {
  const sm = createSessionManager({ pty: fakePty });
  const { id } = sm.create({ label: 'Claude', command: 'claude' });
  sm.setPinned(id, true);
  const rows = sm.list();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], { id, label: 'Claude', command: 'claude', cwd: rows[0].cwd, pinned: true });
  sm.killAll();
});

test('killUnpinned keeps pinned sessions and drops the rest', () => {
  const sm = createSessionManager({ pty: fakePty });
  const keep = sm.create({ label: 'keep' });
  sm.create({ label: 'drop' });
  sm.setPinned(keep.id, true);
  sm.killUnpinned();
  assert.strictEqual(sm.size(), 1);
  assert.strictEqual(sm.list()[0].id, keep.id);
  sm.killAll();
});

test('a session that exits fires exit and is removed', async () => {
  const sm = createSessionManager({ pty: fakePty });
  const exits = [];
  sm.on('exit', p => exits.push(p));
  const { id } = sm.create({});
  sm.kill(id);
  assert.ok(exits.some(p => p.id === id));
  assert.strictEqual(sm.size(), 0);
});

test('spawns shells with ELECTRON_RUN_AS_NODE and the daemon pipe vars stripped', () => {
  let seenEnv = null;
  const recordingPty = { spawn: (shell, args, opts) => { seenEnv = opts.env; return fakePty.spawn(shell, args, opts); } };
  const prev = { ...process.env };
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.TERM_PIPE_NAME = 'sc-test-pipe';
  process.env.TERM_FAKE_PTY = '/some/path';
  process.env.KEEP_ME = 'yes';
  try {
    const sm = createSessionManager({ pty: recordingPty });
    sm.create({});
    assert.ok(seenEnv, 'pty.spawn received an env');
    assert.strictEqual(seenEnv.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE stripped');
    assert.strictEqual(seenEnv.TERM_PIPE_NAME, undefined, 'TERM_PIPE_NAME stripped');
    assert.strictEqual(seenEnv.TERM_FAKE_PTY, undefined, 'TERM_FAKE_PTY stripped');
    assert.strictEqual(seenEnv.KEEP_ME, 'yes', 'unrelated env preserved');
    sm.killAll();
  } finally {
    for (const k of ['ELECTRON_RUN_AS_NODE', 'TERM_PIPE_NAME', 'TERM_FAKE_PTY', 'KEEP_ME']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});
