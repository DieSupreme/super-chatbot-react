# Persistent Terminal Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pin a terminal tab so its process survives app close and auto-reconnects on next launch, backed by a detached PTY daemon.

**Architecture:** PTYs move out of the Electron main process into a detached daemon (`daemon.js`) that outlives the app. Main talks to it as a client (`daemon-client.js`) over a named pipe using newline-delimited JSON. The renderer reattaches to surviving sessions on launch and replays a ring buffer.

**Tech Stack:** Node `net` (named pipe / unix socket), `node-pty` (already a dependency, rebuilt for Electron), Electron IPC, React, xterm.js. Tests use Node's built-in `node:test` + `node:assert` with an injected fake PTY (no new dependencies).

## Global Constraints

- Platform target: Windows (primary), must not break on POSIX. Use `process.platform` guards; named pipe on Windows (`\\.\pipe\...`), unix socket in `os.tmpdir()` elsewhere.
- No new runtime dependencies. Tests use `node:test`/`node:assert` only.
- `node-pty` native binary is built for Electron's ABI (see `scripts/rebuild-node-pty.js`). Therefore **automated tests must never `require('node-pty')` under plain `node`** — they inject a fake PTY. Real `node-pty` is exercised only by the manual smoke test running under Electron.
- Wire protocol: newline-delimited JSON; PTY bytes carried as base64 of the UTF-8 string.
- Ring buffer per session: `256 * 1024` chars max.
- Session IDs are daemon-assigned integers, opaque and durable across app restarts.
- Keep the existing `term:*` IPC surface working; add to it, don't gratuitously rename.
- Match existing code style: CommonJS in main/`src/terminal/*` and `preload.js`; ES modules + React in `src/components/*`; terse top-of-file comment blocks explaining intent.

---

## File Structure

**New (daemon side, pure Node, unit-tested):**
- `src/terminal/protocol.js` — pipe path, lockfile path, token, JSON framing. Pure, no I/O.
- `src/terminal/session-manager.js` — owns node-pty sessions, ring buffers, pin flags, list/kill. PTY module injectable.
- `src/terminal/daemon.js` — standalone process: `net` server wiring protocol ↔ session-manager, lockfile, self-exit.

**New (main-process client):**
- `src/terminal/daemon-client.js` — connect-or-spawn, request/response, event fan-out.

**New (tests):**
- `test/terminal/fake-pty.js` — node-pty stand-in.
- `test/terminal/protocol.test.js`
- `test/terminal/session-manager.test.js`
- `test/terminal/daemon.test.js`
- `test/terminal/daemon-client.test.js`

**Modified:**
- `src/terminal/pty.js` — becomes the IPC bridge over `daemon-client` (no direct node-pty).
- `main.js:5,58` — unchanged require, unchanged register call; quit handling now lives in reworked `pty.js`.
- `preload.js` — add `term.reattach/list/setPinned/quitAll`.
- `src/components/TerminalPanel.jsx` — add reattach mode + report session id.
- `src/components/TerminalDock.jsx` — pin UI, restore-on-launch, metadata persistence, quit-all.
- `package.json` — add `test:term` script.

---

## Task 1: Protocol module (pure framing/paths)

**Files:**
- Create: `src/terminal/protocol.js`
- Test: `test/terminal/protocol.test.js`
- Modify: `package.json` (add script)

**Interfaces:**
- Produces:
  - `pipePath(): string` — honors `process.env.TERM_PIPE_NAME` override for the pipe tag.
  - `lockfilePath(userDataDir: string): string`
  - `makeToken(): string`
  - `encodeMessage(obj: object): string` — JSON + trailing `\n`.
  - `createDecoder(onMessage: (obj) => void): (chunk: string) => void` — stateful NDJSON splitter.

- [ ] **Step 1: Initialize git if needed (first task only)**

Run:
```bash
git rev-parse --is-inside-work-tree 2>/dev/null || (git init && git add -A && git commit -m "chore: baseline before persistent-terminal work")
```
Expected: either already a repo, or a fresh repo with one baseline commit.

- [ ] **Step 2: Write the failing test**

Create `test/terminal/protocol.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { pipePath, lockfilePath, makeToken, encodeMessage, createDecoder } = require('../../src/terminal/protocol');

test('encodeMessage round-trips through a decoder', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  feed(encodeMessage({ t: 'hello', token: 'abc' }));
  feed(encodeMessage({ t: 'data', id: 3, data: 'eA==' }));
  assert.deepStrictEqual(got, [{ t: 'hello', token: 'abc' }, { t: 'data', id: 3, data: 'eA==' }]);
});

test('decoder reassembles messages split across chunks', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  const wire = encodeMessage({ t: 'x', n: 1 });
  feed(wire.slice(0, 4));
  feed(wire.slice(4));
  assert.deepStrictEqual(got, [{ t: 'x', n: 1 }]);
});

test('decoder skips blank lines and bad JSON without throwing', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  feed('\n');
  feed('not json\n');
  feed(encodeMessage({ t: 'ok' }));
  assert.deepStrictEqual(got, [{ t: 'ok' }]);
});

test('pipePath honors TERM_PIPE_NAME and is platform-shaped', () => {
  process.env.TERM_PIPE_NAME = 'unit-test-tag';
  const p = pipePath();
  delete process.env.TERM_PIPE_NAME;
  if (process.platform === 'win32') assert.ok(p.startsWith('\\\\.\\pipe\\'));
  assert.ok(p.includes('unit-test-tag'));
});

test('makeToken returns a long hex string, unique per call', () => {
  const a = makeToken(), b = makeToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(a, b);
});

test('lockfilePath joins under the given userData dir', () => {
  const p = lockfilePath('/tmp/ud');
  assert.ok(p.includes('ud'));
  assert.ok(p.endsWith('terminal-daemon.json'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/terminal/protocol.test.js`
Expected: FAIL — `Cannot find module '../../src/terminal/protocol'`.

- [ ] **Step 4: Implement `src/terminal/protocol.js`**

```javascript
// Wire protocol + path helpers shared by the terminal daemon and its client.
// Pure functions only (no sockets, no fs writes) so they unit-test without I/O.
// Framing is newline-delimited JSON; PTY bytes ride inside messages as base64.
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// A stable per-user tag so the app and a previously-spawned daemon agree on the
// pipe without a rendezvous file. TERM_PIPE_NAME overrides it (tests use a unique
// tag so they never collide with a real running daemon).
function userTag() {
  if (process.env.TERM_PIPE_NAME) return process.env.TERM_PIPE_NAME;
  const h = crypto.createHash('sha1').update(os.userInfo().username + '|' + os.homedir()).digest('hex').slice(0, 12);
  return 'superchat-term-' + h;
}

// Named pipe on Windows; unix-domain socket path elsewhere.
function pipePath() {
  const tag = userTag();
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + tag;
  return path.join(os.tmpdir(), tag + '.sock');
}

function lockfilePath(userDataDir) {
  return path.join(userDataDir, 'terminal-daemon.json');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function encodeMessage(obj) {
  return JSON.stringify(obj) + '\n';
}

// Returns a feed(chunk) function; invokes onMessage for each complete line.
// Tolerates partial chunks, blank lines, and malformed JSON (skips the latter).
function createDecoder(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      onMessage(msg);
    }
  };
}

module.exports = { pipePath, lockfilePath, makeToken, encodeMessage, createDecoder };
```

- [ ] **Step 5: Add the test script to `package.json`**

In the `"scripts"` block (`package.json:6-13`), add after `"watch"`:
```json
    "test:term": "node --test test/terminal",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/terminal/protocol.test.js`
Expected: PASS — all 6 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/terminal/protocol.js test/terminal/protocol.test.js package.json
git commit -m "feat(terminal): add daemon wire protocol + path helpers"
```

---

## Task 2: Session manager (owns PTYs, ring buffer, pin/list/kill)

**Files:**
- Create: `src/terminal/session-manager.js`
- Create: `test/terminal/fake-pty.js`
- Test: `test/terminal/session-manager.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createSessionManager(deps?: { pty?: object }): SessionManager` where `SessionManager` has:
  - `create(opts: { shell?, cols?, rows?, cwd?, label?, command? }): { id: number, cwd: string, cwdFallback: boolean }`
  - `write(id: number, data: string): void`
  - `resize(id: number, cols: number, rows: number): void`
  - `replay(id: number): string`
  - `setPinned(id: number, pinned: boolean): void`
  - `list(): Array<{ id, label, command, cwd, pinned }>`
  - `kill(id: number): void`
  - `killUnpinned(): void`
  - `killAll(): void`
  - `size(): number`
  - `on(type: 'data' | 'exit', cb: (payload) => void): () => void` — `data` payload `{ id, data }`, `exit` payload `{ id, exitCode, signal }`.

- [ ] **Step 1: Write the fake PTY helper**

Create `test/terminal/fake-pty.js`:
```javascript
// Minimal node-pty stand-in for tests: no native binary, deterministic.
// spawn() returns a proc that echoes writes as data, emits a banner on next tick,
// and fires exit when killed.
function spawn(shell, args, opts) {
  const dataCbs = [];
  const exitCbs = [];
  let killed = false;
  const emit = (d) => { if (!killed) for (const cb of dataCbs.slice()) cb(d); };
  setImmediate(() => emit('BANNER(' + shell + ')@' + ((opts && opts.cwd) || '') + '\n'));
  return {
    onData(cb) { dataCbs.push(cb); return { dispose() {} }; },
    onExit(cb) { exitCbs.push(cb); return { dispose() {} }; },
    write(d) { emit('ECHO:' + d); },
    resize() {},
    kill() { if (killed) return; killed = true; for (const cb of exitCbs.slice()) cb({ exitCode: 0, signal: 0 }); }
  };
}
module.exports = { spawn };
```

- [ ] **Step 2: Write the failing test**

Create `test/terminal/session-manager.test.js`:
```javascript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/terminal/session-manager.test.js`
Expected: FAIL — `Cannot find module '../../src/terminal/session-manager'`.

- [ ] **Step 4: Implement `src/terminal/session-manager.js`**

```javascript
// Owns every live PTY session for the daemon: spawns them, buffers a bounded
// ring of recent output for reconnect replay, tracks a per-session pinned flag,
// and fans data/exit out to subscribers. The node-pty module is injectable so
// tests run under plain node with a fake (real node-pty is built for Electron's
// ABI and must not load under `node --test`).
const os = require('os');
const fs = require('fs');
const path = require('path');

const RING_MAX = 256 * 1024;

// Same shell resolution the app used before (moved here from pty.js): explicit
// override -> pwsh -> cmd on Windows; $SHELL or bash elsewhere.
function onPath(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) { try { if (fs.existsSync(path.join(dir, exe))) return true; } catch (_) {} }
  return false;
}
function resolveShell(override) {
  if (override && typeof override === 'string' && override.trim()) return override.trim();
  if (process.platform === 'win32') return onPath('pwsh.exe') ? 'pwsh.exe' : (process.env.COMSPEC || 'cmd.exe');
  return process.env.SHELL || '/bin/bash';
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

function createSessionManager(deps = {}) {
  const pty = deps.pty || require('node-pty');
  const sessions = new Map();
  let idCounter = 0;
  const listeners = { data: new Set(), exit: new Set() };
  const emit = (type, payload) => { for (const cb of [...listeners[type]]) cb(payload); };

  function create(opts = {}) {
    const shell = resolveShell(opts.shell);
    const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80;
    const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24;
    const requested = opts.cwd ? String(opts.cwd).trim() : '';
    const cwdOk = requested ? isDir(requested) : false;
    const cwd = cwdOk ? requested : os.homedir();
    const proc = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: process.env });
    const id = ++idCounter;
    const session = {
      id, proc, ring: '', pinned: false,
      label: opts.label || '', command: opts.command || '',
      cwd, cwdFallback: !!requested && !cwdOk
    };
    session.dataSub = proc.onData((data) => {
      session.ring += data;
      if (session.ring.length > RING_MAX) session.ring = session.ring.slice(session.ring.length - RING_MAX);
      emit('data', { id, data });
    });
    session.exitSub = proc.onExit(({ exitCode, signal }) => {
      emit('exit', { id, exitCode, signal });
      kill(id);
    });
    sessions.set(id, session);
    return { id, cwd, cwdFallback: session.cwdFallback };
  }

  function write(id, data) { const s = sessions.get(id); if (s && typeof data === 'string') s.proc.write(data); }
  function resize(id, cols, rows) {
    const s = sessions.get(id); if (!s) return;
    const c = Number.isInteger(cols) && cols > 0 ? cols : 80;
    const r = Number.isInteger(rows) && rows > 0 ? rows : 24;
    try { s.proc.resize(c, r); } catch (_) {}
  }
  function replay(id) { const s = sessions.get(id); return s ? s.ring : ''; }
  function setPinned(id, pinned) { const s = sessions.get(id); if (s) s.pinned = !!pinned; }
  function list() {
    return [...sessions.values()].map(s => ({ id: s.id, label: s.label, command: s.command, cwd: s.cwd, pinned: s.pinned }));
  }
  function kill(id) {
    const s = sessions.get(id); if (!s) return;
    sessions.delete(id);
    try { s.dataSub.dispose(); } catch (_) {}
    try { s.exitSub.dispose(); } catch (_) {}
    try { s.proc.kill(); } catch (_) {}
  }
  function killUnpinned() { for (const s of [...sessions.values()]) if (!s.pinned) kill(s.id); }
  function killAll() { for (const id of [...sessions.keys()]) kill(id); }
  function size() { return sessions.size; }
  function on(type, cb) { listeners[type].add(cb); return () => listeners[type].delete(cb); }

  return { create, write, resize, replay, setPinned, list, kill, killUnpinned, killAll, size, on };
}

module.exports = { createSessionManager, resolveShell };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/terminal/session-manager.test.js`
Expected: PASS — all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/terminal/session-manager.js test/terminal/fake-pty.js test/terminal/session-manager.test.js
git commit -m "feat(terminal): add session manager with ring buffer and pin flags"
```

---

## Task 3: The daemon process (net server + lockfile + self-exit)

**Files:**
- Create: `src/terminal/daemon.js`
- Test: `test/terminal/daemon.test.js`

**Interfaces:**
- Consumes: `protocol.js` (all exports), `session-manager.js` `createSessionManager`.
- Produces: a runnable script. `argv[2]` = userDataDir. Env `TERM_FAKE_PTY` (module path) selects a fake PTY; env `TERM_PIPE_NAME` selects the pipe tag. On start it writes the lockfile `{ pipe, token, pid }` then listens. Protocol (see Global Constraints) messages:
  - client→daemon: `hello{token}`, `create{reqId,opts}`, `reattach{reqId,id}`, `write{id,data}`, `resize{id,cols,rows}`, `kill{reqId,id}`, `list{reqId}`, `setPinned{reqId,id,pinned}`, `killUnpinned{reqId}`, `quitAll{reqId}`.
  - daemon→client: `hello-ok`, `reply{reqId,result}`, `error{reqId,error}`, `data{id,data}`, `exit{id,exitCode}`.
  - `data` is delivered only to sockets subscribed to that `id` (subscription happens on `reattach`). `reattach` reply `result = { ring }` where `ring` is base64 of the ring string.

- [ ] **Step 1: Write the failing test**

Create `test/terminal/daemon.test.js`:
```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/terminal/daemon.test.js`
Expected: FAIL — daemon has no listener / module missing, connections error out.

- [ ] **Step 3: Implement `src/terminal/daemon.js`**

```javascript
// Standalone, detached PTY daemon. Run via the app's binary as plain node
// (ELECTRON_RUN_AS_NODE=1) so the Electron-built node-pty loads. Owns all PTY
// sessions (via session-manager) and serves the app over a named pipe using the
// newline-delimited JSON protocol. Outlives the app so pinned sessions survive.
//
// argv[2] = userData dir (for the lockfile). Env: TERM_PIPE_NAME (pipe tag),
// TERM_FAKE_PTY (test-only module path for a fake node-pty).
const net = require('net');
const fs = require('fs');
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
  const feed = createDecoder((m) => {
    if (!c.authed) {
      if (m.t === 'hello' && m.token === token) { c.authed = true; clients.add(c); c.send({ t: 'hello-ok' }); }
      else { try { sock.destroy(); } catch (_) {} }
      return;
    }
    switch (m.t) {
      case 'create': reply(m.reqId, sm.create(m.opts || {})); break;
      case 'reattach': {
        c.subs.add(m.id);
        reply(m.reqId, { ring: Buffer.from(sm.replay(m.id), 'utf8').toString('base64') });
        break;
      }
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
  sock.on('data', (buf) => feed(buf.toString('utf8')));
  sock.on('error', () => {});
  sock.on('close', () => { clients.delete(c); maybeSelfExit(); });
});

// Write the lockfile BEFORE listening so any client that can connect is
// guaranteed to find the token. Then serve.
fs.writeFileSync(lockfilePath(userDataDir), JSON.stringify({ pipe, token, pid: process.pid }));
server.on('error', () => shutdown(1));
server.listen(pipe);

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/terminal/daemon.test.js`
Expected: PASS — all 3 tests pass. (On Windows the pipe is auto-removed on close; on POSIX the socket file is unlinked by `shutdown`.)

- [ ] **Step 5: Commit**

```bash
git add src/terminal/daemon.js test/terminal/daemon.test.js
git commit -m "feat(terminal): add detached PTY daemon server"
```

---

## Task 4: Daemon client (connect-or-spawn, request/response, events)

**Files:**
- Create: `src/terminal/daemon-client.js`
- Test: `test/terminal/daemon-client.test.js`

**Interfaces:**
- Consumes: `protocol.js`, and a running `daemon.js`.
- Produces: `createDaemonClient(cfg: { userDataDir, execPath?, daemonPath?, spawnEnv? }): DaemonClient` with:
  - `ensure(): Promise<void>` — idempotent connect-or-spawn + hello.
  - `create(opts): Promise<{ id, cwd, cwdFallback }>`
  - `reattach(id): Promise<{ ring: string }>` — ring decoded to a string.
  - `write(id, data): void`, `resize(id, cols, rows): void`
  - `kill(id): Promise<{ ok }>`, `list(): Promise<Array>`, `setPinned(id, pinned): Promise<{ ok }>`, `killUnpinned(): Promise<{ ok }>`, `quitAll(): Promise<{ ok }>`
  - `onData(cb: ({id,data}) => void): void`, `onExit(cb: ({id,exitCode}) => void): void`
  - `disconnect(): void` — closes the socket, leaves the daemon running.
  - Defaults: `execPath = process.execPath`, `daemonPath = require.resolve('./daemon.js')`, `spawnEnv = { ELECTRON_RUN_AS_NODE: '1' }` merged onto `process.env`.

- [ ] **Step 1: Write the failing test**

Create `test/terminal/daemon-client.test.js`:
```javascript
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

test('spawns a daemon, creates + reattaches a session, receives echo', async () => {
  const c = createDaemonClient(cfg());
  await c.ensure();
  const got = [];
  c.onData(d => got.push(d));
  const s = await c.create({ label: 'A' });
  const re = await c.reattach(s.id);
  assert.ok(re.ring.includes('BANNER'));
  c.write(s.id, 'yo');
  await wait(150);
  assert.ok(got.some(d => d.id === s.id && d.data.includes('ECHO:yo')));
  await c.quitAll();
});

test('a second client reuses the already-running daemon (list sees the session)', async () => {
  const shared = cfg();
  const c1 = createDaemonClient(shared);
  await c1.ensure();
  const keep = await c1.create({ label: 'keep' });
  await c1.setPinned(keep.id, true);
  c1.disconnect();                            // simulate app close (daemon stays up)

  const c2 = createDaemonClient(shared);      // fresh app launch
  await c2.ensure();
  const rows = await c2.list();
  assert.ok(rows.some(r => r.id === keep.id && r.pinned === true));
  await c2.quitAll();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/terminal/daemon-client.test.js`
Expected: FAIL — `Cannot find module '../../src/terminal/daemon-client'`.

- [ ] **Step 3: Implement `src/terminal/daemon-client.js`**

```javascript
// Main-process client for the PTY daemon. Connects to an already-running daemon
// or spawns one detached, then speaks the JSON protocol: request/response calls
// correlated by reqId, plus unsolicited data/exit events fanned to listeners.
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
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
    const feed = createDecoder((m) => {
      if (m.t === 'reply') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.resolve(m.result); } }
      else if (m.t === 'error') { const p = pending.get(m.reqId); if (p) { pending.delete(m.reqId); p.reject(new Error(m.error)); } }
      else if (m.t === 'data') { const d = Buffer.from(m.data, 'base64').toString('utf8'); for (const cb of dataCbs) cb({ id: m.id, data: d }); }
      else if (m.t === 'exit') { for (const cb of exitCbs) cb({ id: m.id, exitCode: m.exitCode }); }
    });
    s.on('data', (buf) => feed(buf.toString('utf8')));
    s.on('close', () => { sock = null; ready = null; for (const p of pending.values()) p.reject(new Error('daemon disconnected')); pending.clear(); });
    s.on('error', () => {});
  }

  function tryConnect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(pipePath());
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
    return new Promise((resolve, reject) => {
      const feed = createDecoder((m) => { if (m.t === 'hello-ok') resolve(); });
      const onData = (buf) => feed(buf.toString('utf8'));
      sock.on('data', onData);
      sock.write(encodeMessage({ t: 'hello', token: readToken() }));
      setTimeout(() => { sock.removeListener('data', onData); resolve(); }, 1000); // hello-ok also flows to attach() decoder
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
```

Note on `hello()`: the `hello-ok` is consumed by the persistent `attach()` decoder; the temporary listener here just resolves `ensure()` promptly (with a 1s safety timeout). This keeps `ensure()` simple without a dedicated handshake state machine.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/terminal/daemon-client.test.js`
Expected: PASS — both tests pass (second proves daemon reuse across "app restarts").

- [ ] **Step 5: Run the full terminal suite**

Run: `npm run test:term`
Expected: PASS — protocol, session-manager, daemon, daemon-client all green.

- [ ] **Step 6: Commit**

```bash
git add src/terminal/daemon-client.js test/terminal/daemon-client.test.js
git commit -m "feat(terminal): add main-process daemon client (connect-or-spawn)"
```

---

## Task 5: Rework `pty.js` into the IPC bridge + quit handling

**Files:**
- Modify: `src/terminal/pty.js` (full rewrite of the file body)
- Verify against: `main.js:5,58` (require + register call stay as-is)

**Interfaces:**
- Consumes: `daemon-client.js` `createDaemonClient`.
- Produces: `registerTerminalIpc(app)` handling IPC `term:create`, `term:write`, `term:resize`, `term:kill`, `term:reattach`, `term:list`, `term:setPinned`, `term:quitAll`, `term:pickFolder`, `term:pathExists`. Forwards daemon `data`/`exit` to every window via `term:data` `{id,data}` and `term:exit` `{id,exitCode}`. On `before-quit`, kills unpinned sessions and disconnects (daemon and pinned sessions live on).

This task crosses into Electron IPC, which the repo does not unit-test; it is verified by the daemon-client suite (already green) plus the manual smoke test in Task 9.

- [ ] **Step 1: Rewrite `src/terminal/pty.js`**

Replace the entire file with:
```javascript
// IPC bridge between the renderer's `term:*` channel and the detached PTY daemon.
// node-pty no longer lives in the app process at all — it runs inside daemon.js,
// which outlives the app so pinned sessions persist. This module lazily spawns /
// connects to that daemon and shuttles messages both ways.
const { ipcMain, dialog, BrowserWindow, app: electronApp } = require('electron');
const fs = require('fs');
const { createDaemonClient } = require('./daemon-client');

let client = null;
let quitHandled = false;

function getClient() {
  if (client) return client;
  client = createDaemonClient({
    userDataDir: electronApp.getPath('userData'),
    execPath: process.execPath,
    // ELECTRON_RUN_AS_NODE makes our own binary run daemon.js as plain node, so
    // the Electron-built node-pty native module loads with a matching ABI.
    spawnEnv: { ELECTRON_RUN_AS_NODE: '1' }
  });
  // Fan daemon output out to every renderer; preload dispatches by session id.
  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send(channel, payload); }
  };
  client.onData(({ id, data }) => broadcast('term:data', { id, data }));
  client.onExit(({ id, exitCode }) => broadcast('term:exit', { id, exitCode }));
  return client;
}

function registerTerminalIpc(app) {
  ipcMain.handle('term:create', async (_e, opts) => {
    try { const c = getClient(); await c.ensure(); return { ok: true, ...(await c.create(opts || {})) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('term:reattach', async (_e, id) => {
    try { const c = getClient(); await c.ensure(); return { ok: true, ...(await c.reattach(id)) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.on('term:write', (_e, { id, data }) => { if (client) client.write(id, data); });
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => { if (client) client.resize(id, cols, rows); });
  ipcMain.handle('term:kill', async (_e, id) => { try { if (client) await client.kill(id); return { ok: true }; } catch (_) { return { ok: true }; } });
  ipcMain.handle('term:list', async () => { try { const c = getClient(); await c.ensure(); return { ok: true, sessions: await c.list() }; } catch (err) { return { ok: false, error: err.message, sessions: [] }; } });
  ipcMain.handle('term:setPinned', async (_e, { id, pinned }) => { try { if (client) await client.setPinned(id, pinned); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('term:quitAll', async () => { try { if (client) await client.quitAll(); return { ok: true }; } catch (_) { return { ok: true }; } });

  // Folder chooser for the per-instance working-directory bar (unchanged behavior).
  ipcMain.handle('term:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, { title: 'Choose a folder for this terminal', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });
  ipcMain.handle('term:pathExists', (_e, p) => {
    try { return { ok: true, exists: !!p && fs.existsSync(p) && fs.statSync(p).isDirectory() }; }
    catch (_) { return { ok: true, exists: false }; }
  });

  // On quit: keep pinned sessions alive in the daemon, kill the rest, disconnect.
  // We defer the quit once to let killUnpinned round-trip before the socket closes.
  app.on('before-quit', (e) => {
    if (quitHandled || !client) return;
    quitHandled = true;
    e.preventDefault();
    Promise.resolve()
      .then(() => client.killUnpinned())
      .catch(() => {})
      .then(() => { try { client.disconnect(); } catch (_) {} app.quit(); });
  });
}

module.exports = { registerTerminalIpc };
```

- [ ] **Step 2: Verify `main.js` wiring is intact (no change expected)**

Confirm `main.js:5` still `const { registerTerminalIpc } = require('./src/terminal/pty.js');` and `main.js:58` still calls `registerTerminalIpc(app)`. The old `disposeAll` export is gone; confirm nothing else imports it:

Run: `grep -rn "disposeAll" main.js src`
Expected: no matches (the only user was inside the old `pty.js`).

- [ ] **Step 3: Build to confirm no load/syntax errors**

Run: `npm run build`
Expected: `✓ built` with no errors (renderer bundle unaffected; this validates the module parses under Vite's dependency scan — `pty.js` itself is main-process, exercised in Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/terminal/pty.js
git commit -m "refactor(terminal): route term IPC through the daemon client"
```

---

## Task 6: Preload — expose the new term calls

**Files:**
- Modify: `preload.js:47-59` (the `term:` block)

**Interfaces:**
- Consumes: IPC channels added in Task 5.
- Produces on `window.api.term`: existing `create/write/resize/kill/pickFolder/pathExists/onData/onExit` plus `reattach(id)`, `list()`, `setPinned(id, pinned)`, `quitAll()`. Drops the now-unused `start`.

- [ ] **Step 1: Update the `term` bridge in `preload.js`**

Replace the `term:` object (`preload.js:47-59`) with:
```javascript
  term: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    reattach: (id) => ipcRenderer.invoke('term:reattach', id),
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    list: () => ipcRenderer.invoke('term:list'),
    setPinned: (id, pinned) => ipcRenderer.invoke('term:setPinned', { id, pinned }),
    quitAll: () => ipcRenderer.invoke('term:quitAll'),
    pickFolder: () => ipcRenderer.invoke('term:pickFolder'),
    pathExists: (p) => ipcRenderer.invoke('term:pathExists', p),
    // per-session data/exit registration; each returns a disposer.
    onData: (id, cb) => { termDataCbs.set(id, cb); return () => termDataCbs.delete(id); },
    onExit: (id, cb) => { termExitCbs.set(id, cb); return () => termExitCbs.delete(id); }
  }
```

- [ ] **Step 2: Build to confirm the preload parses**

Run: `npm run build`
Expected: `✓ built` (preload isn't bundled but this catches nothing here; the real check is Task 9). Confirm no accidental syntax error by eye: the block ends the `exposeInMainWorld` object.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(terminal): expose reattach/list/setPinned/quitAll in preload"
```

---

## Task 7: `TerminalPanel.jsx` — reattach mode + report session id

**Files:**
- Modify: `src/components/TerminalPanel.jsx` (rework the creation `useEffect` and props)

**Interfaces:**
- Consumes: `api.term.create/reattach/write/resize/kill/onData/onExit`.
- Produces: component props `{ active, initialCommand, initialCwd, onResolvedCwd, sessionId, onSession }`.
  - When `sessionId` is a number → **reattach** to it (replay ring, no `initialCommand`).
  - When `sessionId` is null/undefined → **create** a new session, then call `onSession(id)`.

- [ ] **Step 1: Replace the creation `useEffect` body**

In `src/components/TerminalPanel.jsx`, change the component signature (line ~23) to include the new props:
```javascript
export default function TerminalPanel({ active, initialCommand, initialCwd, onResolvedCwd, sessionId, onSession }) {
```

Then replace the block from `// Attach the keystroke handler up front...` through the end of the `(async () => { ... })();` IIFE (currently `TerminalPanel.jsx:78-110`, i.e. the `term.onData(...)` wiring and the create IIFE) with:
```javascript
    // Attach the keystroke handler up front and buffer input until the session id
    // is known, so keys typed before the session resolves are not lost.
    term.onData((data) => {
      if (sessionRef.current != null) api.term.write(sessionRef.current, data);
      else inputBuf.push(data);
    });

    // Bind this panel to a daemon session: either reattach to an existing one
    // (restored pinned tab) or create a fresh one. Both then replay the ring so
    // the banner / prior scrollback shows, wire live output, flush buffered keys,
    // and nudge a resize so full-screen TUIs (claude, vim) repaint.
    const bind = async () => {
      let id = sessionId;
      let resolvedCwd = initialCwd || '';
      let fallback = false;
      const reattaching = id != null;

      if (!reattaching) {
        const r = await api.term.create({ cols: term.cols, rows: term.rows, cwd: initialCwd || undefined, command: initialCommand || '' });
        if (disposed) { if (r && r.ok) api.term.kill(r.id); return; }
        if (!r || !r.ok) { term.writeln('\r\n\x1b[31mFailed to start terminal: ' + (r && r.error || 'unknown') + '\x1b[0m'); return; }
        id = r.id; resolvedCwd = r.cwd; fallback = !!r.cwdFallback;
      }

      sessionRef.current = id;
      if (onSession) onSession(id);

      offData = api.term.onData(id, (data) => term.write(data));
      offExit = api.term.onExit(id, ({ exitCode }) => {
        sessionRef.current = null;
        term.writeln(`\r\n\x1b[90m[process exited${typeof exitCode === 'number' ? ' with code ' + exitCode : ''}]\x1b[0m`);
      });

      // Replay recent output for this session (banner or prior scrollback).
      const re = await api.term.reattach(id);
      if (disposed) return;
      if (re && re.ok && re.ring) term.write(re.ring);

      // Flush keys typed while binding.
      for (const d of inputBuf) api.term.write(id, d);
      inputBuf = [];

      // Fresh sessions run their launch command once; reattached ones must not.
      if (!reattaching && initialCommand) api.term.write(id, initialCommand + '\r');

      if (onResolvedCwd) onResolvedCwd({ cwd: resolvedCwd, fallback });
      // Nudge a repaint for TUIs by resizing to current fit.
      try { refit(); } catch (_) {}
      term.focus();
    };
    bind();
```

- [ ] **Step 2: Ensure reattached panels are not killed on unmount, but created ones are**

The current cleanup (`TerminalPanel.jsx:119-128`) kills the session on unmount. For persistence we must NOT kill on unmount — closing a tab is an explicit ✕ (handled in the dock via `api.term.kill`), and app-quit is handled by the main process. Replace the kill line in the cleanup:

Find:
```javascript
      if (sessionRef.current != null) { api.term.kill(sessionRef.current); sessionRef.current = null; }
```
Replace with:
```javascript
      // Do NOT kill the session on unmount — persistence and tab-close (✕) own the
      // session lifecycle now. Just detach this panel's listeners.
      sessionRef.current = null;
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/TerminalPanel.jsx
git commit -m "feat(terminal): TerminalPanel reattach mode; stop killing on unmount"
```

---

## Task 8: `TerminalDock.jsx` — pin UI, restore-on-launch, quit-all

**Files:**
- Modify: `src/components/TerminalDock.jsx`

**Interfaces:**
- Consumes: `api.term.list/setPinned/kill/quitAll`, `api.getSettings/saveSettings`, `TerminalPanel` props `sessionId`/`onSession`.
- Produces: no exported interface changes; adds a 📍 pin toggle per tab, restores pinned tabs on mount, persists pinned metadata, and a "Quit all" control.

- [ ] **Step 1: Add restore-on-launch and pin/persist logic**

Rework `src/components/TerminalDock.jsx`. Replace the component body (from `export default function TerminalDock` through the end of the file) with:
```javascript
export default function TerminalDock({ active, onToast }) {
  const [instances, setInstances] = useState([makeShell()]);
  const [activeKey, setActiveKey] = useState('shell');

  const activeInst = instances.find(i => i.key === activeKey) || instances[0];
  const isOpen = useCallback((key) => instances.some(i => i.key === key), [instances]);
  const patch = useCallback((key, p) => setInstances(prev => prev.map(i => i.key === key ? { ...i, ...p } : i)), []);

  // Persist the pinned tabs' metadata so a pinned tab whose process later died
  // (force-kill / reboot) can be respawned fresh on a future launch.
  const persistPinned = useCallback((list) => {
    const pinned = list.filter(i => i.pinned).map(i => ({ sessionId: i.sessionId, key: i.key, label: i.label, command: i.command, cwd: i.cwd }));
    api.getSettings().then(r => {
      const s = (r && r.settings) || {};
      s.pinnedTerminals = pinned;
      api.saveSettings(s);
    });
  }, []);

  // On mount, reconcile saved pinned tabs against sessions still alive in the daemon.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [listRes, setRes] = await Promise.all([api.term.list(), api.getSettings()]);
      if (cancelled) return;
      const live = (listRes && listRes.sessions) || [];
      const saved = ((setRes && setRes.settings && setRes.settings.pinnedTerminals) || []);
      const restored = [];
      for (const meta of saved) {
        const liveMatch = live.find(s => s.id === meta.sessionId);
        if (liveMatch) {
          restored.push({ key: meta.key, label: meta.label, command: meta.command, cwd: liveMatch.cwd, cwdDraft: liveMatch.cwd, gen: 0, sessionId: liveMatch.id, pinned: true });
        } else {
          // Process gone — respawn fresh (create path) and tell the user.
          restored.push({ key: meta.key, label: meta.label, command: meta.command, cwd: meta.cwd || '', cwdDraft: meta.cwd || '', gen: 0, sessionId: null, pinned: true });
          if (onToast) onToast(`${meta.label}: reconnected as a fresh session`, 'warn');
        }
      }
      if (restored.length) setInstances(prev => {
        const have = new Set(prev.map(i => i.key));
        return [...prev, ...restored.filter(r => !have.has(r.key))];
      });
    })();
    return () => { cancelled = true; };
  }, [onToast]);

  const openTool = useCallback((l) => {
    setInstances(prev => prev.some(i => i.key === l.label)
      ? prev
      : [...prev, { key: l.label, label: l.label, command: l.command, cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false }]);
    setActiveKey(l.label);
  }, []);

  const closeInstance = useCallback((key) => {
    setInstances(prev => {
      const inst = prev.find(i => i.key === key);
      if (inst && inst.sessionId != null) api.term.kill(inst.sessionId);
      const next = prev.filter(i => i.key !== key);
      persistPinned(next);
      return next;
    });
    setActiveKey(prev => (prev === key ? 'shell' : prev));
  }, [persistPinned]);

  const togglePin = useCallback((key) => {
    setInstances(prev => {
      const next = prev.map(i => {
        if (i.key !== key) return i;
        const pinned = !i.pinned;
        if (i.sessionId != null) api.term.setPinned(i.sessionId, pinned);
        return { ...i, pinned };
      });
      persistPinned(next);
      return next;
    });
  }, [persistPinned]);

  const setSession = useCallback((key, id) => {
    setInstances(prev => {
      const next = prev.map(i => i.key === key ? { ...i, sessionId: id } : i);
      const inst = next.find(i => i.key === key);
      if (inst && inst.pinned) api.term.setPinned(id, true);
      persistPinned(next);
      return next;
    });
  }, [persistPinned]);

  const quitAll = useCallback(async () => {
    await api.term.quitAll();
    setInstances([makeShell()]);
    setActiveKey('shell');
    const r = await api.getSettings();
    const s = (r && r.settings) || {};
    s.pinnedTerminals = [];
    api.saveSettings(s);
    if (onToast) onToast('All terminals stopped', 'ok');
  }, [onToast]);

  const applyCwd = useCallback(async (key, rawPath) => {
    const p = (rawPath ?? '').trim();
    if (p) {
      const r = await api.term.pathExists(p);
      if (r && r.ok && !r.exists) { onToast && onToast('Folder not found: ' + p, 'warn'); return; }
    }
    // Changing the folder respawns: forget the old session id so the panel creates
    // a new one, and bump gen to remount.
    setInstances(prev => prev.map(i => i.key === key ? { ...i, cwd: p, cwdDraft: p, sessionId: null, gen: i.gen + 1 } : i));
  }, [onToast]);

  const browse = useCallback(async (key) => {
    const r = await api.term.pickFolder();
    if (r && r.ok && r.path) applyCwd(key, r.path);
  }, [applyCwd]);

  const handleResolvedCwd = useCallback((key, { cwd, fallback }) => {
    setInstances(prev => prev.map(i => i.key === key
      ? { ...i, cwd, cwdDraft: i.cwdDraft === i.cwd ? cwd : i.cwdDraft }
      : i));
    if (fallback && onToast) onToast('Folder unavailable — opened your home folder instead', 'warn');
  }, [onToast]);

  const renderPin = (inst) => (
    <span className={'pin' + (inst.pinned ? ' on' : '')}
      title={inst.pinned ? 'Pinned — survives app close. Click to unpin.' : 'Pin — keep running after the app closes.'}
      onClick={(e) => { e.stopPropagation(); togglePin(inst.key); }}>📍</span>
  );

  return (
    <>
      <div className="term-tabs">
        <div className={'term-tab' + (activeKey === 'shell' ? ' active' : '')} onClick={() => setActiveKey('shell')}>
          <span className="lbl">Shell</span>
          {renderPin(instances.find(i => i.key === 'shell') || makeShell())}
        </div>
        {instances.filter(i => i.key !== 'shell' && !LAUNCHERS.some(l => l.label === i.key)).map(inst => (
          <div key={inst.key} className={'term-tab open' + (activeKey === inst.key ? ' active' : '')} onClick={() => setActiveKey(inst.key)}>
            <span className="lbl">{inst.label}</span>
            {renderPin(inst)}
            <span className="x" title={'Close ' + inst.label} onClick={(e) => { e.stopPropagation(); closeInstance(inst.key); }}>✕</span>
          </div>
        ))}
        {LAUNCHERS.map(l => {
          const open = isOpen(l.label);
          const inst = instances.find(i => i.key === l.label);
          return (
            <div key={l.label}
              className={'term-tab' + (activeKey === l.label ? ' active' : '') + (open ? ' open' : '')}
              title={open ? 'Switch to ' + l.label : 'Launch: ' + l.command}
              onClick={() => openTool(l)}>
              <span className="lbl">{l.label}</span>
              {open && inst && renderPin(inst)}
              {open && (<span className="x" title={'Close ' + l.label} onClick={(e) => { e.stopPropagation(); closeInstance(l.label); }}>✕</span>)}
            </div>
          );
        })}
        <button className="ghost term-quit-all" title="Stop and kill every terminal (including pinned)" onClick={quitAll}>Quit all</button>
      </div>

      <div className="term-cwd">
        <span className="term-cwd-ico" title="Working folder for this terminal">📁</span>
        <input className="term-cwd-input" type="text" spellCheck={false}
          placeholder="Working folder for this instance — blank = home. Enter to (re)open here."
          value={activeInst.cwdDraft}
          onChange={(e) => patch(activeKey, { cwdDraft: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCwd(activeKey, activeInst.cwdDraft); }} />
        <button className="ghost" onClick={() => browse(activeKey)}>Browse…</button>
        <button className="ghost" onClick={() => applyCwd(activeKey, activeInst.cwdDraft)}>Open</button>
      </div>

      <div className="term-stack">
        {instances.map(inst => {
          const show = active && activeKey === inst.key;
          return (
            <div key={inst.key} className="term-slot" style={{ display: show ? 'flex' : 'none' }}>
              <TerminalPanel key={inst.key + ':' + inst.gen}
                active={show} initialCommand={inst.command} initialCwd={inst.cwd}
                sessionId={inst.sessionId}
                onSession={(id) => setSession(inst.key, id)}
                onResolvedCwd={(info) => handleResolvedCwd(inst.key, info)} />
            </div>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Update `makeShell` to include the new fields**

Change `makeShell` (`TerminalDock.jsx:27`) to:
```javascript
const makeShell = () => ({ key: 'shell', label: 'Shell', command: null, cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false });
```

- [ ] **Step 3: Add minimal styling for the pin + quit-all**

Append to the app stylesheet (find it via `grep -rl "term-tab" src`, it is the CSS file that styles `.term-tab`). Add:
```css
.term-tab .pin { opacity: 0.35; margin-left: 6px; cursor: pointer; font-size: 11px; }
.term-tab .pin.on { opacity: 1; }
.term-tab .pin:hover { opacity: 0.8; }
.term-quit-all { margin-left: auto; }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `✓ built` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalDock.jsx src/*.css src/**/*.css
git commit -m "feat(terminal): pin toggle, restore-on-launch, and quit-all in the dock"
```

---

## Task 9: Manual smoke verification (real daemon under Electron)

**Files:** none (verification only)

This is the only place real `node-pty` and the real daemon are exercised end-to-end. Do it deliberately.

- [ ] **Step 1: Full build + launch**

Run: `npm run dev`
Expected: app window opens; the terminal tab shows a working shell.

- [ ] **Step 2: Baseline terminal + clipboard still work**

In the Shell tab: type `echo hello`, confirm output. Test `Ctrl+V` paste and right-click paste (from Task pair earlier). Expected: all work.

- [ ] **Step 3: Pin a tool session**

Click the **Claude** launcher tab (starts `claude`). Click its 📍 to pin (icon becomes solid). Let it reach an interactive prompt.

- [ ] **Step 4: Verify the daemon is detached**

Run (separate shell): `Get-Process | Where-Object { $_.ProcessName -match 'electron|node' }` (PowerShell).
Expected: an extra detached process (the daemon) exists.

- [ ] **Step 5: Fully quit the app, confirm pinned process survives**

Close the app window entirely. Re-run the process check from Step 4.
Expected: the daemon process is **still running** (it holds the pinned Claude session); unpinned Shell's process is gone.

- [ ] **Step 6: Relaunch and confirm reattach**

Run: `npm start`
Expected: the Claude tab reappears automatically, its prior scrollback is replayed, and the TUI repaints to a usable prompt — the **same** session, not a fresh `claude`.

- [ ] **Step 7: Reboot-fallback path (simulated)**

Fully quit the app. Manually kill the daemon process (`Stop-Process`). Relaunch with `npm start`.
Expected: the pinned Claude tab reappears but as a **fresh** session (runs `claude` anew), with a toast "Claude: reconnected as a fresh session".

- [ ] **Step 8: Quit-all tears everything down**

With pinned tabs open, click **Quit all**. Re-run the process check.
Expected: the daemon process exits; on next launch no tabs are restored.

- [ ] **Step 9: Run the automated suite once more and commit a checkpoint**

Run: `npm run test:term`
Expected: PASS.
```bash
git add -A
git commit -m "test(terminal): manual smoke verified; persistent daemon complete"
```

---

## Self-Review

**Spec coverage:**
- Detached daemon owning PTYs → Tasks 2–3. ✓
- Named pipe + `ELECTRON_RUN_AS_NODE`, no firewall, reuse node-pty → `protocol.js` (Task 1), `daemon-client` spawnEnv (Tasks 4–5). ✓
- Ring buffer ~256 KB replay → session-manager (Task 2), reattach (Tasks 3,7). ✓
- Token handshake + OS-ACL pipe → hello in daemon (Task 3) / client (Task 4). ✓
- Self-exit when empty → daemon `maybeSelfExit` (Task 3). ✓
- Bridge rework + before-quit kill-unpinned/keep-pinned → Task 5. ✓
- preload additions incl. `quitAll` → Task 6. ✓
- Reattach mode + repaint nudge; no re-run of command on reattach → Task 7. ✓
- Pin UI, restore-on-launch via `list()`, metadata persistence, respawn-fresh fallback + toast, quit-all → Task 8. ✓
- Session-id stability + folder-change respawn adopts new id → Task 8 `applyCwd`/`setSession`. ✓
- Accepted limitations (background processes, best-effort TUI, no reboot survival) → surfaced in Task 9 steps 5–7. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; test steps contain real assertions. ✓

**Type consistency:** `create → {id,cwd,cwdFallback}`, `reattach → {ring}` (string in client, base64 on wire), `list → [{id,label,command,cwd,pinned}]`, `on('data') → {id,data}`, `on('exit') → {id,exitCode,signal}` (daemon forwards `{id,exitCode}`). `setPinned(id,pinned)`, `killUnpinned()`, `killAll()`/`kill(id)` consistent across session-manager, daemon, client, preload, dock. IPC channels `term:create/reattach/write/resize/kill/list/setPinned/quitAll/pickFolder/pathExists` consistent between Task 5 and Task 6. ✓
