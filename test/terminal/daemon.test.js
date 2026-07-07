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
function bootDaemon() {
  const tag = 'sc-daemon-test-' + process.pid + '-' + (bootDaemon._n = (bootDaemon._n || 0) + 1);
  const udir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-udir-'));
  const env = { ...process.env, TERM_PIPE_NAME: tag, TERM_FAKE_PTY: FAKE };
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
    assert.ok(Buffer.from(re.ring, 'base64').toString('utf8').includes('BANNER'));
    c.send({ t: 'write', id: created.id, data: Buffer.from('hi', 'utf8').toString('base64') });
    await wait(150);
    assert.ok(c.data.some(d => d.id === created.id && Buffer.from(d.data, 'base64').toString('utf8').includes('ECHO:hi')));
    sock.end();
  } finally { child.kill(); }
});

test('daemon: killUnpinned keeps pinned, then quitAll exits the process', async () => {
  const { child, pipe, udir } = bootDaemon();
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
});

test('daemon: self-exits when last session dies and client disconnects', async () => {
  const { child, pipe, udir } = bootDaemon();
  const exited = new Promise(res => child.on('exit', () => res(true)));
  const sock = await connect(pipe);
  const lock = JSON.parse(fs.readFileSync(path.join(udir, 'terminal-daemon.json'), 'utf8'));
  const c = client(sock);
  c.hello(lock.token);
  const s = await c.req({ t: 'create', opts: {} });
  await c.req({ t: 'kill', id: s.id });
  sock.end();
  assert.strictEqual(await exited, true);
});
