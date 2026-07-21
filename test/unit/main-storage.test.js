// main.js storage + key handlers driven with a stubbed `electron`. Covers the
// Phase-1 hardening: atomic writes (a crash mid-write can't truncate a store),
// corrupt-file quarantine (a parse failure is set aside, never treated as empty
// and clobbered), and key containment (key:load returns presence only — never
// key material — while chat/image read the key from disk in main).
//
// Everything writes into a fresh mkdtemp userData dir; no real user files, no
// network (fetch is stubbed per test).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'main-storage-ud-'));

const handlers = new Map();     // channel -> handler (ipcMain.handle)
const onHandlers = new Map();   // channel -> handler (ipcMain.on)
const sentEvents = [];          // webContents.send: [channel, payload]
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (ch, p) => sentEvents.push([ch, p]), setWindowOpenHandler: () => {}, on: () => {} },
  setMenuBarVisibility: () => {}, loadFile: () => {}, on: () => {}
};
// safeStorage available so the encrypted branch is exercised; encrypt/decrypt
// are a reversible transform (a tag prefix) so we never touch a real keychain.
const fakeElectron = {
  // whenReady runs the ready callback synchronously so createWindow() sets the
  // module-level `win` (needed for the app:notice path).
  app: { getPath: () => userData, whenReady: () => ({ then: (cb) => { if (cb) cb(); return { catch: () => {} }; } }), on: () => {}, quit: () => {} },
  BrowserWindow: Object.assign(function () { return fakeWin; }, { getAllWindows: () => [fakeWin] }),
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => onHandlers.set(ch, fn) },
  dialog: {}, shell: {}, clipboard: { readText: () => '', writeText: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('ENC:' + s, 'utf8'),
    decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('bad ciphertext'); return s.slice(4); }
  }
};

// Stub electron and the side-effect-only IPC registrars so require('../../main.js')
// only wires the storage/key/chat/image handlers we test.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  if (request === './src/terminal/pty.js') return { registerTerminalIpc: () => {} };
  if (request === './src/main/sd.js') return { registerSdIpc: () => {} };
  if (request === './src/main/comfy.js') return { registerComfyIpc: () => {} };
  return origLoad.call(this, request, ...rest);
};
require('../../main.js');
Module._load = origLoad;

const invoke = (ch, arg) => handlers.get(ch)({}, arg);
const KEY_FILE = path.join(userData, 'or-key.bin');
const CONVO_FILE = path.join(userData, 'conversations.json');
const SETTINGS_FILE = path.join(userData, 'settings.json');

test('key:load returns presence only — never key material', async () => {
  await invoke('key:save', 'sk-or-v1-SECRET-DO-NOT-LEAK');
  const r = await invoke('key:load');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.present, true);
  // The response must carry no field that reproduces the key.
  assert.strictEqual('key' in r, false);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('SECRET'), 'key:load response must not contain key material');
  // The on-disk format is unchanged (encrypted branch => ENC: tag under safeStorage).
  assert.ok(fs.existsSync(KEY_FILE));
});

test('key:load reports absence after clear', async () => {
  await invoke('key:save', 'sk-or-v1-abc');
  await invoke('key:clear');
  const r = await invoke('key:load');
  assert.strictEqual(r.present, false);
});

test('chat:send reads the saved key from disk and rejects when none is saved', async () => {
  await invoke('key:clear');
  // No key saved: must fail fast without a network call, and never leak.
  const noKey = await invoke('chat:send', { model: 'm', messages: [], requestId: 1 });
  assert.strictEqual(noKey.ok, false);
  assert.match(noKey.error, /no api key/i);

  // Key saved: the handler pulls it from disk (renderer sends no key). Stub
  // fetch to capture the Authorization header proves main sourced the key.
  await invoke('key:save', 'sk-or-v1-LIVEKEY');
  let seenAuth = null;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    seenAuth = opts.headers.Authorization;
    return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
  };
  try {
    const r = await invoke('chat:send', { model: 'm', messages: [{ role: 'user', content: 'hi' }], requestId: 2 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seenAuth, 'Bearer sk-or-v1-LIVEKEY');
  } finally { global.fetch = origFetch; }
});

test('conversations: atomic write leaves no partial file, and a corrupt file is quarantined not clobbered', async () => {
  // Seed a valid conversation via the handler.
  await invoke('convo:save', { id: 'c1', title: 'first', model: 'm', messages: [{ role: 'user', content: 'a' }] });
  let list = await invoke('convo:list');
  assert.strictEqual(list.list.length, 1);
  // No leftover temp file from the atomic write.
  const leftovers = fs.readdirSync(userData).filter(f => f.startsWith('conversations.json.tmp'));
  assert.deepStrictEqual(leftovers, []);

  // Corrupt the store, then save a NEW conversation. The corrupt original must
  // be quarantined (renamed .corrupt-*) — not silently treated as {} and lost.
  fs.writeFileSync(CONVO_FILE, '{ this is not json');
  await invoke('convo:save', { id: 'c2', title: 'second', model: 'm', messages: [{ role: 'user', content: 'b' }] });
  const corruptBackups = fs.readdirSync(userData).filter(f => f.startsWith('conversations.json.corrupt-'));
  assert.strictEqual(corruptBackups.length, 1, 'corrupt file must be preserved as a .corrupt backup');
  assert.strictEqual(fs.readFileSync(path.join(userData, corruptBackups[0]), 'utf8'), '{ this is not json');
  // A user notice was surfaced (never carries key material).
  assert.ok(sentEvents.some(([ch, p]) => ch === 'app:notice' && /conversations\.json/.test(p.msg)));
  // The new save succeeded on a clean store.
  list = await invoke('convo:list');
  assert.ok(list.list.some(c => c.id === 'c2'));
});

test('settings: corrupt existing file is quarantined instead of merged into {}', async () => {
  await invoke('settings:save', { a: 1, keepMe: 'x' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), { a: 1, keepMe: 'x' });

  fs.writeFileSync(SETTINGS_FILE, 'not json at all');
  const r = await invoke('settings:save', { b: 2 });
  assert.strictEqual(r.ok, true);
  const backups = fs.readdirSync(userData).filter(f => f.startsWith('settings.json.corrupt-'));
  assert.strictEqual(backups.length, 1, 'unparseable settings must be set aside, not merged into {}');
  // The write is atomic (no temp leftover) and contains the new patch.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), { b: 2 });
  assert.deepStrictEqual(fs.readdirSync(userData).filter(f => f.startsWith('settings.json.tmp')), []);
});

test('settings: unknown keys from another version survive a save', async () => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ futureFlag: true, temp: 0.5 }));
  await invoke('settings:save', { temp: 0.9 });
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  assert.strictEqual(saved.futureFlag, true, 'unknown key must be preserved');
  assert.strictEqual(saved.temp, 0.9);
});
