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

function registerTerminalIpc(app, getParentWindow) {
  ipcMain.handle('term:create', async (_e, opts) => {
    try {
      const c = getClient();
      await c.ensure();
      const created = await c.create(opts || {});
      return { ok: true, ...created };
    }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('term:reattach', async (_e, id) => {
    try {
      const c = getClient(); await c.ensure();
      const r = await c.reattach(id);
      return { ok: true, ring: r.ring, alive: r.alive };
    }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.on('term:write', async (_e, { id, data }) => {
    try {
      const c = getClient();
      await c.ensure();
      c.write(id, data);
    } catch (_) {}
  });
  ipcMain.on('term:resize', async (_e, { id, cols, rows }) => {
    try {
      const c = getClient();
      await c.ensure();
      c.resize(id, cols, rows);
    } catch (_) {}
  });
  ipcMain.on('term:detach', (_e, id) => {
    try {
      const c = getClient();
      c.detach(id);
    } catch (_) {}
  });
  ipcMain.handle('term:kill', async (_e, id) => { try { if (client) await client.kill(id); return { ok: true }; } catch (_) { return { ok: true }; } });
  ipcMain.handle('term:list', async () => { try { const c = getClient(); await c.ensure(); return { ok: true, sessions: await c.list() }; } catch (err) { return { ok: false, error: err.message, sessions: [] }; } });
  ipcMain.handle('term:setPinned', async (_e, { id, pinned }) => { try { if (client) await client.setPinned(id, pinned); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('term:quitAll', async () => { try { if (client) await client.quitAll(); return { ok: true }; } catch (_) { return { ok: true }; } });

  // Folder chooser for the per-instance working-directory bar.
  ipcMain.handle('term:pickFolder', async () => {
    try {
      const parent = (typeof getParentWindow === 'function' && getParentWindow())
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      const res = await dialog.showOpenDialog(parent, {
        title: 'Choose a folder for this terminal',
        properties: ['openDirectory']
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('term:pathExists', (_e, p) => {
    try {
      const raw = typeof p === 'string' ? p.trim() : '';
      let path = raw;
      if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
        path = path.slice(1, -1).trim();
      }
      return { ok: true, exists: !!path && fs.existsSync(path) && fs.statSync(path).isDirectory() };
    }
    catch (_) { return { ok: true, exists: false }; }
  });

  // On quit: keep pinned sessions alive in the daemon, kill the rest, disconnect.
  // We defer the quit once to let killUnpinned round-trip before the socket
  // closes — but race it against a short timeout so a dead/wedged daemon (whose
  // killUnpinned would re-run the spawn/poll loop or never reply) can't hang the
  // quit indefinitely.
  app.on('before-quit', (e) => {
    if (quitHandled || !client) return;
    quitHandled = true;
    e.preventDefault();
    const withTimeout = Promise.race([
      Promise.resolve().then(() => client.killUnpinned()).catch(() => {}),
      new Promise(r => setTimeout(r, 2000))
    ]);
    withTimeout.then(() => { try { client.disconnect(); } catch (_) {} app.quit(); });
  });
}

module.exports = { registerTerminalIpc };
