// Standalone, detached PTY daemon. Run via the app's binary as plain node
// (ELECTRON_RUN_AS_NODE=1) so the Electron-built node-pty loads. Owns all PTY
// sessions (via session-manager) and serves the app over a named pipe using the
// newline-delimited JSON protocol. Outlives the app so pinned sessions survive.
//
// argv[2] = userData dir (for the lockfile). Env: TERM_PIPE_NAME (pipe tag),
// TERM_FAKE_PTY (test-only module path for a fake node-pty).
const net = require('net');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { pipePath, lockfilePath, makeToken, encodeMessage, createDecoder } = require('./protocol');
const { createSessionManager } = require('./session-manager');

const userDataDir = process.argv[2] || process.cwd();
const pipe = pipePath();
const token = makeToken();
const ptyModule = process.env.TERM_FAKE_PTY ? require(process.env.TERM_FAKE_PTY) : undefined;
const sm = createSessionManager(ptyModule ? { pty: ptyModule } : {});

const clients = new Set();   // each: { sock, send, subs:Set<id> }

// Broadcast a session's output only to sockets that reattached to it.
sm.on('data', ({ id, data }) => {
  const enc = Buffer.from(data, 'utf8').toString('base64');
  for (const c of clients) if (c.subs.has(id)) c.send({ t: 'data', id, data: enc });
});
sm.on('exit', ({ id, exitCode }) => {
  for (const c of clients) if (c.subs.has(id)) c.send({ t: 'exit', id, exitCode });
  // session-manager emits 'exit' BEFORE its internal kill(id) removes the
  // session from its map, so sm.size() still counts it here. Defer the
  // self-exit check to a microtask so it runs after that internal kill has
  // run, otherwise an idle daemon whose last session dies on its own would
  // never notice it's orphaned.
  queueMicrotask(maybeSelfExit);
});

function maybeSelfExit() {
  if (clients.size === 0 && sm.size() === 0) shutdown(0);
}

// When the last client disconnects, unpinned sessions are orphaned (a relaunch
// only restores pinned tabs), so kill them after a short grace period — long
// enough for a quick app restart to reconnect. Pinned sessions always survive.
const GRACE_MS = 5000;
let cleanupTimer = null;
function scheduleUnpinnedCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    if (clients.size === 0) { sm.killUnpinned(); maybeSelfExit(); }
  }, GRACE_MS);
}
function cancelUnpinnedCleanup() {
  if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Only remove the lockfile if it's still OURS — a daemon that lost the pipe
  // race must never unlink the live daemon's lockfile.
  try {
    const lf = lockfilePath(userDataDir);
    const cur = JSON.parse(fs.readFileSync(lf, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(lf);
  } catch (_) {}
  try { server.close(); } catch (_) {}
  sm.killAll();
  // node-pty's Windows ConPTY kill() is async (console-process-list walk); give
  // it a beat to run before the event loop dies, or shell trees leak.
  await new Promise(r => setTimeout(r, 150));
  process.exit(code || 0);
}

const server = net.createServer((sock) => {
  const c = { sock, subs: new Set(), authed: false, send: (o) => { try { sock.write(encodeMessage(o)); } catch (_) {} } };
  const reply = (reqId, result) => c.send({ t: 'reply', reqId, result });
  const sd = new StringDecoder('utf8');
  const feed = createDecoder((m) => {
    if (!c.authed) {
      if (m.t === 'hello' && m.token === token) { c.authed = true; clients.add(c); cancelUnpinnedCleanup(); c.send({ t: 'hello-ok' }); }
      else { try { sock.destroy(); } catch (_) {} }
      return;
    }
    // A single bad request (e.g. sm.create throwing on a bad shell path) must
    // not crash the whole daemon and kill every other session. Reply with an
    // error for request-shaped messages; swallow it for fire-and-forget ones.
    try {
      switch (m.t) {
        case 'create': reply(m.reqId, sm.create(m.opts || {})); break;
        case 'reattach': {
          const alive = sm.exists(m.id);
          if (alive) c.subs.add(m.id);
          reply(m.reqId, {
            alive,
            ring: alive ? Buffer.from(sm.replay(m.id), 'utf8').toString('base64') : ''
          });
          break;
        }
        case 'detach': c.subs.delete(m.id); break;
        case 'write': sm.write(m.id, Buffer.from(m.data || '', 'base64').toString('utf8')); break;
        case 'resize': sm.resize(m.id, m.cols, m.rows); break;
        case 'kill': sm.kill(m.id); reply(m.reqId, { ok: true }); maybeSelfExit(); break;
        case 'list': reply(m.reqId, sm.list()); break;
        case 'setPinned': sm.setPinned(m.id, m.pinned); reply(m.reqId, { ok: true }); break;
        case 'killUnpinned': sm.killUnpinned(); reply(m.reqId, { ok: true }); break;
        case 'quitAll': reply(m.reqId, { ok: true }); shutdown(0); break;
        default: break;
      }
    } catch (err) {
      if (m.reqId != null) c.send({ t: 'error', reqId: m.reqId, error: String(err && err.message || err) });
    }
  });
  sock.on('data', (buf) => feed(sd.write(buf)));
  sock.on('error', () => {});
  sock.on('close', () => {
    clients.delete(c);
    if (clients.size === 0) scheduleUnpinnedCleanup();   // orphaned unpinned die after a grace period
    maybeSelfExit();
  });
});

// Uncaught errors must not take the daemon (and every pinned session) down.
// The daemon has no user-facing log channel, so this just prevents a hard crash.
process.on('uncaughtException', () => {});

// Serve first, then write the lockfile from the 'listening' callback: a second
// daemon that loses the pipe race (EADDRINUSE) must not overwrite the live
// daemon's lockfile before its own error handler fires shutdown(1).
server.on('error', () => shutdown(1));
server.listen(pipe, () => {
  try { fs.writeFileSync(lockfilePath(userDataDir), JSON.stringify({ pipe, token, pid: process.pid }), { mode: 0o600 }); } catch (_) {}
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
