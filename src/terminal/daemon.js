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
function shutdown(code) {
  try { fs.unlinkSync(lockfilePath(userDataDir)); } catch (_) {}
  try { server.close(); } catch (_) {}
  sm.killAll();
  process.exit(code || 0);
}

const server = net.createServer((sock) => {
  const c = { sock, subs: new Set(), authed: false, send: (o) => { try { sock.write(encodeMessage(o)); } catch (_) {} } };
  const reply = (reqId, result) => c.send({ t: 'reply', reqId, result });
  const sd = new StringDecoder('utf8');
  const feed = createDecoder((m) => {
    if (!c.authed) {
      if (m.t === 'hello' && m.token === token) { c.authed = true; clients.add(c); c.send({ t: 'hello-ok' }); }
      else { try { sock.destroy(); } catch (_) {} }
      return;
    }
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
  });
  sock.on('data', (buf) => feed(sd.write(buf)));
  sock.on('error', () => {});
  sock.on('close', () => { clients.delete(c); maybeSelfExit(); });
});

// Write the lockfile BEFORE listening so any client that can connect is
// guaranteed to find the token. Then serve.
fs.writeFileSync(lockfilePath(userDataDir), JSON.stringify({ pipe, token, pid: process.pid }), { mode: 0o600 });
server.on('error', () => shutdown(1));
server.listen(pipe);

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
