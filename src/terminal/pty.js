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
    try {
      const c = getClient(); await c.ensure();
      const r = await c.reattach(id);
      return { ok: true, ring: r.ring, alive: r.alive };
    }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.on('term:write', (_e, { id, data }) => { if (client) client.write(id, data); });
  ipcMain.on('term:resize', (_e, { id, cols, rows }) => { if (client) client.resize(id, cols, rows); });
  ipcMain.on('term:detach', (_e, id) => { if (client) client.detach(id); });
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
