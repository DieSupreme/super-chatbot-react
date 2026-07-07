// Main-process client for the PTY daemon. Connects to an already-running daemon
// or spawns one detached, then speaks the JSON protocol: request/response calls
// correlated by reqId, plus unsolicited data/exit events fanned to listeners.
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { pipePath, lockfilePath, encodeMessage, createDecoder } = require('./protocol');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function createDaemonClient(cfg) {
  const userDataDir = cfg.userDataDir;
  const execPath = cfg.execPath || process.execPath;
  const daemonPath = cfg.daemonPath || require.resolve('./daemon.js');
  const spawnEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(cfg.spawnEnv || {}) };

  let sock = null;
  let ready = null;                 // memoized ensure() promise
  let reqId = 0;
  const pending = new Map();
  const dataCbs = new Set();
  const exitCbs = new Set();

  function attach(s) {
    sock = s;
    const sd = new StringDecoder('utf8');
    const feed = createDecoder((m) => {
      if (m.t === 'reply') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.resolve(m.result); } }
      else if (m.t === 'error') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.reject(new Error(m.error)); } }
      else if (m.t === 'data') { const d = Buffer.from(m.data, 'base64').toString('utf8'); for (const cb of dataCbs) cb({ id: m.id, data: d }); }
      else if (m.t === 'exit') { for (const cb of exitCbs) cb({ id: m.id, exitCode: m.exitCode }); }
    });
    s.on('data', (buf) => feed(sd.write(buf)));
    s.on('close', () => { sock = null; ready = null; for (const p of pending.values()) p.reject(new Error('daemon disconnected')); pending.clear(); });
    s.on('error', () => {});
  }

  // pipePath() derives the pipe name from process.env.TERM_PIPE_NAME by default.
  // Tests pass a unique tag via cfg.spawnEnv so a spawned daemon listens on an
  // isolated pipe — but that env only reaches the spawned child, not this
  // process. Passing the same tag as an explicit override lets the client
  // compute the identical path without ever touching process.env. In
  // production spawnEnv.TERM_PIPE_NAME is undefined, so pipePath() falls back
  // to the same per-user default the daemon computes from its own env.
  const clientPipe = () => pipePath(spawnEnv.TERM_PIPE_NAME);

  function tryConnect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(clientPipe());
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  async function connectOrSpawn() {
    try { return await tryConnect(); } catch (_) { /* fall through to spawn */ }
    spawn(execPath, [daemonPath, userDataDir], { detached: true, stdio: 'ignore', env: spawnEnv }).unref();
    for (let i = 0; i < 50; i++) {         // poll up to ~5s for the pipe
      try { return await tryConnect(); } catch (_) { await wait(100); }
    }
    throw new Error('terminal daemon did not start');
  }

  function readToken() {
    try { return JSON.parse(fs.readFileSync(lockfilePath(userDataDir), 'utf8')).token; }
    catch (_) { return ''; }
  }

  function hello() {
    return new Promise((resolve) => {
      const s = sock;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (s) s.removeListener('data', onData);
        resolve();
      };
      const sd = new StringDecoder('utf8');
      const feed = createDecoder((m) => { if (m.t === 'hello-ok') finish(); });
      const onData = (buf) => feed(sd.write(buf));
      s.on('data', onData);
      s.write(encodeMessage({ t: 'hello', token: readToken() }));
      // hello-ok also flows to attach()'s persistent decoder; this listener is
      // just a fast-path so ensure() resolves promptly, with a safety timeout
      // in case hello-ok is somehow missed. Must clear the timer on early
      // resolution — otherwise it fires later against a socket that may
      // already be closed (e.g. after quitAll()).
      const timer = setTimeout(finish, 1000);
    });
  }

  function ensure() {
    if (ready) return ready;
    ready = (async () => {
      const s = await connectOrSpawn();
      attach(s);
      await hello();
    })();
    return ready;
  }

  function call(msg) {
    return ensure().then(() => new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      sock.write(encodeMessage({ ...msg, reqId: id }));
    }));
  }
  function fire(msg) { if (sock) sock.write(encodeMessage(msg)); }

  return {
    ensure,
    create: (opts) => call({ t: 'create', opts: opts || {} }),
    reattach: (id) => call({ t: 'reattach', id }).then(r => ({ ring: Buffer.from(r.ring, 'base64').toString('utf8') })),
    write: (id, data) => fire({ t: 'write', id, data: Buffer.from(String(data), 'utf8').toString('base64') }),
    resize: (id, cols, rows) => fire({ t: 'resize', id, cols, rows }),
    kill: (id) => call({ t: 'kill', id }),
    list: () => call({ t: 'list' }),
    setPinned: (id, pinned) => call({ t: 'setPinned', id, pinned }),
    killUnpinned: () => call({ t: 'killUnpinned' }),
    quitAll: () => call({ t: 'quitAll' }).catch(() => ({ ok: true })),
    onData: (cb) => dataCbs.add(cb),
    onExit: (cb) => exitCbs.add(cb),
    disconnect: () => { try { if (sock) sock.end(); } catch (_) {} sock = null; ready = null; }
  };
}

module.exports = { createDaemonClient };
