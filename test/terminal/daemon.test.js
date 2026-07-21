const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipePath, encodeMessage, createDecoder } = require('../../src/terminal/protocol');

const DAEMON = path.join(__dirname, '..', '..', 'src', 'terminal', 'daemon.js');
const FAKE = path.join(__dirname, 'fake-pty.js');

// Boot a daemon with a unique pipe + fake PTY; return { child, pipe, udir }.
function bootDaemon(extraEnv) {
  const tag = 'sc-daemon-test-' + process.pid + '-' + (bootDaemon._n = (bootDaemon._n || 0) + 1);
  const udir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-udir-'));
  const env = { ...process.env, TERM_PIPE_NAME: tag, TERM_FAKE_PTY: FAKE, ...(extraEnv || {}) };
  const child = spawn(process.execPath, [DAEMON, udir], { env, stdio: 'ignore' });
  return { child, tag, udir, pipe: (() => { const old = process.env.TERM_PIPE_NAME; process.env.TERM_PIPE_NAME = tag; const p = pipePath(); process.env.TERM_PIPE_NAME = old; return p; })() };
}
function connect(pipe) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const s = net.connect(pipe);
      s.once('connect', () => resolve(s));
      s.once('error', () => { if (n <= 0) reject(new Error('no daemon')); else setTimeout(() => tryOnce(n - 1), 100); });
    };
    tryOnce(30);
  });
}
// Minimal client: send messages, await replies by reqId, collect data/exit.
function client(sock) {
  let reqId = 0; const pending = new Map(); const data = []; const exits = [];
  sock.on('data', createDecoder(m => {
    if (m.t === 'reply') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p(m.result); } }
    else if (m.t === 'error') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p({ error: m.error }); } }
    else if (m.t === 'data') data.push(m);
    else if (m.t === 'exit') exits.push(m);
  }));
  const send = (o) => sock.write(encodeMessage(o));
  const req = (o) => new Promise(res => { const id = ++reqId; pending.set(id, res); send({ ...o, reqId: id }); });
  return { send, req, data, exits, hello: (token) => send({ t: 'hello', token }) };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('daemon: create, reattach replay, data delivery, kill', async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    const created = await c.req({ t: 'create', opts: { label: 'A' } });
    assert.strictEqual(typeof created.id, 'number');
    const re = await c.req({ t: 'reattach', id: created.id });
    assert.strictEqual(re.alive, true);
    assert.ok(Buffer.from(re.ring, 'base64').toString('utf8').includes('BANNER'));
    c.send({ t: 'write', id: created.id, data: Buffer.from('hi', 'utf8').toString('base64') });
    await wait(150);
    assert.ok(c.data.some(d => d.id === created.id && Buffer.from(d.data, 'base64').toString('utf8').includes('ECHO:hi')));
    sock.end();
  } finally { child.kill(); }
});

test('daemon: a failed create replies with an error and keeps the daemon (and other sessions) alive', { timeout: 15000 }, async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    // a healthy session first
    const good = await c.req({ t: 'create', opts: { label: 'good' } });
    assert.strictEqual(typeof good.id, 'number');
    // a create that makes the fake pty throw — must not crash the daemon
    const bad = await c.req({ t: 'create', opts: { shell: '<<FAIL>>' } });
    assert.ok(bad && bad.error, 'failed create returns an error result, not a crash');
    // the daemon is still serving and the good session survives
    const rows = await c.req({ t: 'list' });
    assert.ok(rows.some(r => r.id === good.id));
    sock.end();
  } finally { child.kill(); }
});

test('daemon: kills unpinned sessions after the last client disconnects (pinned survive)', { timeout: 15000 }, async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    const keep = await c.req({ t: 'create', opts: { label: 'keep' } });
    await c.req({ t: 'create', opts: { label: 'drop' } });
    await c.req({ t: 'setPinned', id: keep.id, pinned: true });
    sock.end();   // last client gone — grace timer (5s) should reap unpinned
    // reconnect after the grace period and confirm only the pinned one remains
    await wait(6000);
    const sock2 = await connect(pipe);
    const c2 = client(sock2);
    c2.hello(lock.token);
    const rows = await c2.req({ t: 'list' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, keep.id);
    sock2.end();
  } finally { child.kill(); }
});

test('daemon: reattach to a dead session reports alive=false', async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    const created = await c.req({ t: 'create', opts: {} });
    await c.req({ t: 'kill', id: created.id });
    const re = await c.req({ t: 'reattach', id: created.id });
    assert.strictEqual(re.alive, false);
    assert.strictEqual(Buffer.from(re.ring, 'base64').toString('utf8'), '');
    sock.end();
  } finally { child.kill(); }
});

test('daemon: killUnpinned keeps pinned, then quitAll exits the process', { timeout: 15000 }, async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const exited = new Promise(res => child.on('exit', () => res(true)));
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    const keep = await c.req({ t: 'create', opts: { label: 'keep' } });
    await c.req({ t: 'create', opts: { label: 'drop' } });
    await c.req({ t: 'setPinned', id: keep.id, pinned: true });
    await c.req({ t: 'killUnpinned' });
    const rows = await c.req({ t: 'list' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, keep.id);
    await c.req({ t: 'quitAll' });
    sock.end();
    assert.strictEqual(await exited, true);
  } finally { child.kill(); }
});

test('daemon: self-exits when last session dies and client disconnects', { timeout: 15000 }, async () => {
  const { child, pipe, udir } = bootDaemon();
  try {
    const exited = new Promise(res => child.on('exit', () => res(true)));
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    const s = await c.req({ t: 'create', opts: {} });
    await c.req({ t: 'kill', id: s.id });
    sock.end();
    assert.strictEqual(await exited, true);
  } finally { child.kill(); }
});

test('daemon: self-exits when the last session dies on its own after the client disconnects', { timeout: 5000 }, async () => {
  const { child, pipe, udir } = bootDaemon({ TERM_FAKE_AUTOEXIT: '120' });
  try {
    const exited = new Promise(res => child.on('exit', () => res(true)));
    const sock = await connect(pipe);
    const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
    const c = client(sock);
    c.hello(lock.token);
    // Unpinned session, still alive when we disconnect: the close-handler's
    // self-exit check must see sm.size() >= 1 and NOT exit yet.
    await c.req({ t: 'create', opts: {} });
    sock.end();
    // Give the close handler a moment to run (and confirm it did NOT exit while
    // the session was still alive).
    await wait(50);
    assert.strictEqual(child.exitCode, null, 'daemon must not exit while its session is still alive');
    // The fake PTY autonomously exits ~120ms after spawn, with zero clients
    // connected. The daemon must notice via the deferred maybeSelfExit() in the
    // sm.on('exit', ...) handler and shut itself down.
    assert.strictEqual(await exited, true);
  } finally { child.kill(); }
});
