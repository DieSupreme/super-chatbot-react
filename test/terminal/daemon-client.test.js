const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createDaemonClient } = require('../../src/terminal/daemon-client');

const FAKE = path.join(__dirname, 'fake-pty.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function cfg() {
  const tag = 'sc-client-test-' + process.pid + '-' + (cfg._n = (cfg._n || 0) + 1);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-udir-'));
  return {
    userDataDir,
    execPath: process.execPath,               // plain node, not electron, for tests
    daemonPath: path.join(__dirname, '..', '..', 'src', 'terminal', 'daemon.js'),
    spawnEnv: { TERM_PIPE_NAME: tag, TERM_FAKE_PTY: FAKE }
  };
}

test('spawns a daemon, creates + reattaches a session, receives echo', { timeout: 15000 }, async () => {
  const c = createDaemonClient(cfg());
  try {
    await c.ensure();
    const got = [];
    c.onData(d => got.push(d));
    const s = await c.create({ label: 'A' });
    const re = await c.reattach(s.id);
    assert.ok(re.ring.includes('BANNER'));
    c.write(s.id, 'yo');
    await wait(150);
    assert.ok(got.some(d => d.id === s.id && d.data.includes('ECHO:yo')));
  } finally {
    try { await c.quitAll(); } catch (_) {}
    try { c.disconnect(); } catch (_) {}
  }
});

test('a second client reuses the already-running daemon (list sees the session)', { timeout: 15000 }, async () => {
  const shared = cfg();
  const c1 = createDaemonClient(shared);
  const c2 = createDaemonClient(shared);      // fresh app launch
  try {
    await c1.ensure();
    const keep = await c1.create({ label: 'keep' });
    await c1.setPinned(keep.id, true);
    c1.disconnect();                          // simulate app close (daemon stays up)

    await c2.ensure();
    const rows = await c2.list();
    assert.ok(rows.some(r => r.id === keep.id && r.pinned === true));
  } finally {
    try { await c2.quitAll(); } catch (_) {}
    try { c1.disconnect(); } catch (_) {}
    try { c2.disconnect(); } catch (_) {}
  }
});
