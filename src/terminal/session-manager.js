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
  function exists(id) { return sessions.has(id); }
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

  return { create, write, resize, replay, exists, setPinned, list, kill, killUnpinned, killAll, size, on };
}

module.exports = { createSessionManager, resolveShell };
