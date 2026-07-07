// Main-process PTY manager. Owns node-pty and every live session; the renderer
// never touches node-pty or any raw Node API — it only speaks the `term:*` IPC
// surface wired up here (see preload.js `api.term`).
//
// A real PTY (ConPTY on Windows) is what gives interactive CLIs — claude,
// cursor-agent, grok, sgpt — proper colors, arrow keys, line editing and
// resize. child_process.spawn with piped stdio would lose all of that.
const { ipcMain, dialog, BrowserWindow } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

// id -> { proc, dataSub, exitSub } for every live session.
const sessions = new Map();
let idCounter = 0;

// Resolve which shell to spawn. Order: explicit override -> PowerShell 7
// (pwsh, best colors/UX) -> cmd.exe (always present on Windows). On non-Windows
// fall back to $SHELL or /bin/bash so the module stays portable.
function resolveShell(override) {
  if (override && typeof override === 'string' && override.trim()) return override.trim();
  if (process.platform === 'win32') {
    if (onPath('pwsh.exe')) return 'pwsh.exe';
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// Is an executable resolvable on PATH? Walks PATH + PATHEXT rather than spawning.
function onPath(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, exe))) return true;
    } catch (_) {}
  }
  return false;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// Spawn a new PTY. Output/exit are tagged with the session id. To avoid losing
// the shell's banner/first prompt in the window before the renderer attaches its
// listeners, output is BUFFERED until the renderer calls `term:start` (startSession);
// only then does it flush and switch to live streaming.
function createSession(sender, opts = {}) {
  const shell = resolveShell(opts.shell);
  const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80;
  const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24;
  // Resolve the working dir authoritatively here (renderer validation can race).
  // A requested folder that isn't an existing directory falls back to home, and
  // we flag it so the renderer can tell the user rather than silently misleading.
  const requested = opts.cwd ? String(opts.cwd).trim() : '';
  const cwdOk = requested ? isDir(requested) : false;
  const cwd = cwdOk ? requested : os.homedir();
  const cwdFallback = !!requested && !cwdOk;

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: process.env,
    // ConPTY is the modern Windows backend; node-pty picks it automatically on
    // Win10+. Leaving useConpty unset lets node-pty choose the best available.
  });

  const id = ++idCounter;
  const session = { proc, dataSub: null, exitSub: null, started: false, outBuf: [], pendingExit: null };

  session.dataSub = proc.onData((data) => {
    if (!session.started) { session.outBuf.push(data); return; }   // hold until renderer is ready
    if (!sender.isDestroyed()) sender.send('term:data', { id, data });
  });
  session.exitSub = proc.onExit(({ exitCode, signal }) => {
    if (!session.started) { session.pendingExit = { exitCode, signal }; return; }  // deliver after flush
    if (!sender.isDestroyed()) sender.send('term:exit', { id, exitCode, signal });
    disposeSession(id);
  });

  sessions.set(id, session);
  // return the resolved cwd (+ fallback flag) so the renderer shows where the
  // terminal actually is, not just what was requested.
  return { id, shell, cwd, cwdFallback };
}

// Renderer signals its data/exit listeners are attached: flush buffered output,
// then any buffered exit, and go live.
function startSession(id, sender) {
  const s = sessions.get(id);
  if (!s || s.started) return;
  s.started = true;
  for (const data of s.outBuf) { if (!sender.isDestroyed()) sender.send('term:data', { id, data }); }
  s.outBuf = [];
  if (s.pendingExit) {
    if (!sender.isDestroyed()) sender.send('term:exit', { id, exitCode: s.pendingExit.exitCode, signal: s.pendingExit.signal });
    disposeSession(id);
  }
}

function writeSession(id, data) {
  const s = sessions.get(id);
  if (s && typeof data === 'string') s.proc.write(data);
}

function resizeSession(id, cols, rows) {
  const s = sessions.get(id);
  if (!s) return;
  const c = Number.isInteger(cols) && cols > 0 ? cols : 80;
  const r = Number.isInteger(rows) && rows > 0 ? rows : 24;
  try { s.proc.resize(c, r); } catch (_) {}   // resize can throw if the pty just exited
}

// Tear a session down: drop node-pty listeners, kill the process, forget it.
// Safe to call twice (onExit + explicit kill can race).
function disposeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.dataSub.dispose(); } catch (_) {}
  try { s.exitSub.dispose(); } catch (_) {}
  try { s.proc.kill(); } catch (_) {}
}

// Kill everything — called on app quit so no PTY process is ever orphaned.
function disposeAll() {
  for (const id of [...sessions.keys()]) disposeSession(id);
}

// Wire the IPC surface. Called once from main.js with the electron `app`.
// create/kill use invoke (need an ack); write/resize are fire-and-forget send.
function registerTerminalIpc(app) {
  ipcMain.handle('term:create', (e, opts) => {
    try { return { ok: true, ...createSession(e.sender, opts || {}) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.on('term:write', (_e, { id, data }) => writeSession(id, data));
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => resizeSession(id, cols, rows));
  ipcMain.on('term:start', (e, id) => startSession(id, e.sender));
  ipcMain.handle('term:kill', (_e, id) => { disposeSession(id); return { ok: true }; });

  // Folder chooser for the per-instance working-directory bar.
  ipcMain.handle('term:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for this terminal',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // Validate a typed path before we (re)spawn a session there.
  ipcMain.handle('term:pathExists', (_e, p) => {
    try { return { ok: true, exists: !!p && fs.existsSync(p) && fs.statSync(p).isDirectory() }; }
    catch (_) { return { ok: true, exists: false }; }
  });

  app.on('before-quit', disposeAll);
  app.on('window-all-closed', disposeAll);
}

module.exports = { registerTerminalIpc, disposeAll };
