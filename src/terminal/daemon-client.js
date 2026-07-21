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

  // Track which session ids this client has reattached to, so if the daemon
  // dies we can synthesize exit events for them (otherwise open terminals just
  // freeze silently — no "[process exited]", keystrokes swallowed).
  const attachedIds = new Set();

  function attach(s) {
    sock = s;
    const sd = new StringDecoder('utf8');
    const feed = createDecoder((m) => {
      if (m.t === 'reply') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.resolve(m.result); } }
      else if (m.t === 'error') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.reject(new Error(m.error)); } }
      else if (m.t === 'data') { const d = Buffer.from(m.data, 'base64').toString('utf8'); for (const cb of dataCbs) cb({ id: m.id, data: d }); }
      else if (m.t === 'exit') { attachedIds.delete(m.id); for (const cb of exitCbs) cb({ id: m.id, exitCode: m.exitCode }); }
    });
    s.on('data', (buf) => feed(sd.write(buf)));
    s.on('close', () => {
      // Ignore a stale socket's late close so it can't clobber a healthy
      // replacement connection's state.
      if (sock !== s) return;
      sock = null; ready = null;
      for (const p of pending.values()) p.reject(new Error('daemon disconnected'));
      pending.clear();
      // Tell the renderer every attached session is gone, so its terminal shows
      // "[process exited]" instead of hanging.
      const ids = [...attachedIds]; attachedIds.clear();
      for (const id of ids) for (const cb of exitCbs) cb({ id, exitCode: null });
    });
    s.on('error', () => {});
  }

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
    for (let i = 0; i < 50; i++) {
      try { return await tryConnect(); } catch (_) { await wait(100); }
    }
    throw new Error('terminal daemon did not start');
  }

  function readLockfile() {
    try { return JSON.parse(fs.readFileSync(lockfilePath(userDataDir), 'utf8')); }
    catch (_) { return null; }
  }

  function readToken() {
    const lock = readLockfile();
    return lock && lock.token ? lock.token : '';
  }

  function killStaleDaemon() {
    const lock = readLockfile();
    if (lock && lock.pid) {
      try { process.kill(lock.pid); } catch (_) {}
    }
    try { fs.unlinkSync(lockfilePath(userDataDir)); } catch (_) {}
  }

  // Cheap server-identity check before handing over the token: confirm the
  // lockfile's daemon pid is a process THIS user owns. process.kill(pid, 0)
  // succeeds only for a live process we can signal — a foreign process
  // (another local user impersonating the pipe to steal the token) yields EPERM,
  // a dead pid yields ESRCH; both refuse. The lockfile itself lives in our
  // ACL-protected userData, so a foreign process can't forge it. NOTE: this is
  // not full server-identity proof — GetNamedPipeServerProcessId + SID matching
  // (native) would be; see docs/agent/known-lows.md.
  function serverLooksOurs() {
    const lock = readLockfile();
    if (!lock || !lock.pid) return false;
    try { process.kill(lock.pid, 0); return true; } catch (_) { return false; }
  }

  function hello() {
    return new Promise((resolve, reject) => {
      const s = sock;
      if (!s) { reject(new Error('daemon not connected')); return; }
      if (!serverLooksOurs()) { reject(new Error('daemon identity unverified — refusing to send token')); return; }
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (s) s.removeListener('data', onData);
        if (s) s.removeListener('close', onClose);
      };
      const finishOk = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const finishErr = (err) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };
      const onClose = () => finishErr(new Error('daemon disconnected during hello'));
      const sd = new StringDecoder('utf8');
      const feed = createDecoder((m) => { if (m.t === 'hello-ok') finishOk(); });
      const onData = (buf) => feed(sd.write(buf));
      s.on('data', onData);
      s.once('close', onClose);
      s.write(encodeMessage({ t: 'hello', token: readToken() }));
      const timer = setTimeout(() => finishErr(new Error('daemon hello timeout')), 5000);
    });
  }

  // Tear down the current socket without touching `ready`: during the retry
  // loop the memoized ensure() promise is still in flight and must stay shared,
  // or a concurrent ensure()/call() would open a second, duplicate connection.
  function resetConnection() {
    try { if (sock) sock.destroy(); } catch (_) {}
    sock = null;
    for (const p of pending.values()) p.reject(new Error('daemon disconnected'));
    pending.clear();
  }

  function ensure() {
    if (ready) return ready;
    ready = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const s = await connectOrSpawn();
          attach(s);
          await hello();
          return;               // success — keep `ready` memoized
        } catch (err) {
          resetConnection();
          if (attempt === 0) {
            if (/daemon disconnected during hello/.test(err.message)) {
              killStaleDaemon();
              await wait(200);
            }
            continue;
          }
          ready = null;          // gave up — allow a later ensure() to retry
          throw err;
        }
      }
    })();
    return ready;
  }

  function call(msg) {
    return ensure().then(() => new Promise((resolve, reject) => {
      if (!sock) { reject(new Error('daemon disconnected')); return; }
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      try { sock.write(encodeMessage({ ...msg, reqId: id })); }
      catch (err) { pending.delete(id); reject(err); }
    }));
  }
  function fire(msg) { if (sock) sock.write(encodeMessage(msg)); }

  return {
    ensure,
    create: (opts) => call({ t: 'create', opts: opts || {} }),
    reattach: (id) => call({ t: 'reattach', id }).then(r => {
      if (r.alive !== false) attachedIds.add(id);
      return { ring: Buffer.from(r.ring || '', 'base64').toString('utf8'), alive: r.alive !== false };
    }),
    detach: (id) => { attachedIds.delete(id); fire({ t: 'detach', id }); },
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
