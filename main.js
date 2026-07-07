const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { registerTerminalIpc } = require('./src/terminal/pty.js');
const { createSseState, drainSseBuffer } = require('./src/main/sse.js');

const KEY_FILE = path.join(app.getPath('userData'), 'or-key.bin');
const ALLOW_FILE = path.join(app.getPath('userData'), 'allowed-files.json');
const CONVO_FILE = path.join(app.getPath('userData'), 'conversations.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let win;

// In-memory set of absolute paths the bot is permitted to edit.
// Persisted to disk so the allow-list survives restarts.
let allowed = new Set();
function loadAllowed() {
  try {
    if (fs.existsSync(ALLOW_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'));
      allowed = new Set(arr.filter(p => fs.existsSync(p)));
    }
  } catch (_) { allowed = new Set(); }
}
function saveAllowed() {
  try { fs.writeFileSync(ALLOW_FILE, JSON.stringify([...allowed], null, 2)); } catch (_) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 760, minWidth: 600, minHeight: 500,
    backgroundColor: '#000000',
    title: 'Super Chatbot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));

  // Citation/source links open in the user's default browser, never in-app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block the window itself from navigating away from the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => { loadAllowed(); registerTerminalIpc(app, () => win); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- Secure key storage ----------
ipcMain.handle('key:save', (_e, key) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(KEY_FILE, Buffer.from('PLAIN:' + key, 'utf8'));
      return { ok: true, encrypted: false };
    }
    fs.writeFileSync(KEY_FILE, safeStorage.encryptString(key));
    return { ok: true, encrypted: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('key:load', () => {
  try {
    if (!fs.existsSync(KEY_FILE)) return { ok: true, key: '' };
    const buf = fs.readFileSync(KEY_FILE);
    if (buf.slice(0, 6).toString() === 'PLAIN:') return { ok: true, key: buf.slice(6).toString('utf8') };
    return { ok: true, key: safeStorage.decryptString(buf) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('key:clear', () => {
  try { if (fs.existsSync(KEY_FILE)) fs.unlinkSync(KEY_FILE); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Upload: pick files to attach to a message ----------
const TEXT_EXT = new Set(['.txt','.md','.js','.jsx','.ts','.tsx','.json','.html','.css','.py','.java','.c','.cpp','.h','.cs','.go','.rs','.rb','.php','.sh','.bat','.ps1','.yml','.yaml','.xml','.csv','.log','.ini','.toml','.vue','.svelte']);
const IMG_EXT = new Set(['.png','.jpg','.jpeg','.gif','.webp']);

// Read a single file by absolute path into an attachment object.
// Returns either one attachment, or for a .zip an array of attachments (its text contents).
function readOne(p) {
  const ext = path.extname(p).toLowerCase();
  const name = path.basename(p);
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return { name, path: p, error: 'folders not supported' };
    if (ext === '.zip') return readZip(p, name);   // expands into multiple attachments
    if (stat.size > 5 * 1024 * 1024) return { name, path: p, error: 'too large (>5MB)' };
    if (IMG_EXT.has(ext)) {
      const b64 = fs.readFileSync(p).toString('base64');
      let mime;
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.png') mime = 'image/png';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.webp') mime = 'image/webp';
      else mime = 'image/png';
      if (!b64) return { name, path: p, error: 'image read empty' };
      return { name, path: p, kind: 'image', mime, data: b64 };
    } else if (TEXT_EXT.has(ext) || stat.size < 256 * 1024) {
      return { name, path: p, kind: 'text', content: fs.readFileSync(p, 'utf8') };
    } else {
      return { name, path: p, error: 'unsupported binary type' };
    }
  } catch (err) { return { name, path: p, error: err.message }; }
}

// Minimal ZIP reader: parse the End-Of-Central-Directory, walk central directory
// records, and inflate each stored/deflated entry. Returns an array of text attachments.
function readZip(zipPath, zipName) {
  try {
    const buf = fs.readFileSync(zipPath);
    // find EOCD (signature 0x06054b50) scanning from the end
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [{ name: zipName, error: 'not a valid zip' }];
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);   // start of central directory
    const out = [];
    const textExtsInZip = TEXT_EXT;
    const MAX_FILES = 200;                    // caps protect against zip bombs
    const MAX_TOTAL = 4 * 1024 * 1024;
    let totalBytes = 0;
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;   // central dir header sig
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const fname = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
      off += 46 + nameLen + extraLen + commentLen;

      // skip directories and non-text files
      const fext = path.extname(fname).toLowerCase();
      if (fname.endsWith('/')) continue;
      if (!textExtsInZip.has(fext)) continue;

      // read the local header to find the actual data start
      if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);

      let content;
      try {
        if (method === 0) content = raw.toString('utf8');           // stored
        else if (method === 8) content = zlib.inflateRawSync(raw).toString('utf8');  // deflate
        else continue;
      } catch (_) { continue; }

      if (content.length > 256 * 1024) content = content.slice(0, 256 * 1024) + '\n…(truncated)';
      totalBytes += content.length;
      out.push({ name: fname, path: `${zipName}:${fname}`, kind: 'text', content });
      if (out.length >= MAX_FILES || totalBytes > MAX_TOTAL) {
        out.push({ name: zipName, error: `zip truncated — first ${out.length} text files included` });
        break;
      }
    }
    if (!out.length) return [{ name: zipName, error: 'no readable text files in zip' }];
    return out;
  } catch (err) { return [{ name: zipName, error: err.message }]; }
}

ipcMain.handle('files:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return { ok: true, files: [] };
  return { ok: true, files: res.filePaths.flatMap(p => { const r = readOne(p); return Array.isArray(r) ? r : [r]; }) };
});

// Read dropped files by the paths the renderer hands us.
ipcMain.handle('files:read', (_e, paths) => {
  if (!Array.isArray(paths)) return { ok: true, files: [] };
  return { ok: true, files: paths.flatMap(p => { const r = readOne(p); return Array.isArray(r) ? r : [r]; }) };
});

// ---------- Allow-list management for editable files ----------
ipcMain.handle('allow:list', () => ({ ok: true, paths: [...allowed] }));

ipcMain.handle('allow:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose files the bot may edit',
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return { ok: true, paths: [...allowed] };
  for (const p of res.filePaths) allowed.add(p);
  saveAllowed();
  return { ok: true, paths: [...allowed] };
});

ipcMain.handle('allow:remove', (_e, p) => {
  allowed.delete(p);
  saveAllowed();
  return { ok: true, paths: [...allowed] };
});

ipcMain.handle('allow:read', (_e, p) => {
  if (!allowed.has(p)) return { ok: false, error: 'not in allow-list' };
  try { return { ok: true, content: fs.readFileSync(p, 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Conversation persistence ----------
// All conversations live in one JSON file: { [id]: {id, title, model, messages, cost, updated} }
function readConvos() {
  try { return fs.existsSync(CONVO_FILE) ? JSON.parse(fs.readFileSync(CONVO_FILE, 'utf8')) : {}; }
  catch (_) { return {}; }
}
function writeConvos(obj) {
  try { fs.writeFileSync(CONVO_FILE, JSON.stringify(obj)); return true; } catch (_) { return false; }
}
ipcMain.handle('convo:list', () => {
  const all = readConvos();
  // return lightweight metadata, newest first
  const list = Object.values(all)
    .map(c => ({ id: c.id, title: c.title, model: c.model, cost: c.cost || 0, updated: c.updated || 0 }))
    .sort((a, b) => b.updated - a.updated);
  return { ok: true, list };
});
ipcMain.handle('convo:get', (_e, id) => {
  const all = readConvos();
  return all[id] ? { ok: true, convo: all[id] } : { ok: false, error: 'not found' };
});
ipcMain.handle('convo:save', (_e, convo) => {
  const all = readConvos();
  convo.updated = Date.now();
  all[convo.id] = convo;
  return { ok: writeConvos(all) };
});
ipcMain.handle('convo:delete', (_e, id) => {
  const all = readConvos();
  delete all[id];
  return { ok: writeConvos(all) };
});

// ---------- Permissioned write ----------
// Only writes paths on the allow-list, and only after the user confirms in a dialog.
ipcMain.handle('file:write', async (_e, { path: target, content }) => {
  if (!allowed.has(target)) return { ok: false, error: 'That file is not on the allow-list. Add it first.' };
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Save changes'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm file edit',
    message: 'Let Super Chatbot overwrite this file?',
    detail: target + '\n\nThe current contents will be replaced. A .bak backup is kept.'
  });
  if (choice.response !== 1) return { ok: false, error: 'cancelled by user' };
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Save a single file the bot generated ----------
ipcMain.handle('file:saveAs', async (_e, { name, content }) => {
  // zip-extracted names can contain folders/illegal chars; keep just a safe basename
  const safeName = path.basename(String(name || 'file.txt')).replace(/[<>:"|?*]/g, '_') || 'file.txt';
  const res = await dialog.showSaveDialog(win, {
    title: 'Save file',
    defaultPath: safeName
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
  try { fs.writeFileSync(res.filePath, content, 'utf8'); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Bundle multiple files into a .zip ----------
// Minimal ZIP writer (store + deflate) — no external dependency.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function buildZip(files) {
  // files: [{ name, content }]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    // local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(8, 8);             // method: deflate
    lh.writeUInt16LE(0, 10);            // time
    lh.writeUInt16LE(0, 12);            // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, compressed);
    // central directory record
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += lh.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}
ipcMain.handle('file:saveZip', async (_e, { files, suggestedName }) => {
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'no files' };
  const res = await dialog.showSaveDialog(win, {
    title: 'Save zip',
    defaultPath: suggestedName || 'files.zip',
    filters: [{ name: 'Zip', extensions: ['zip'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
  try {
    fs.writeFileSync(res.filePath, buildZip(files));
    return { ok: true, path: res.filePath, count: files.length };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Settings ----------
ipcMain.handle('settings:get', () => {
  try { return { ok: true, settings: fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {} }; }
  catch (_) { return { ok: true, settings: {} }; }
});
ipcMain.handle('settings:save', (_e, s) => {
  try {
    let existing = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try { existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (_) {}
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...existing, ...s }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Image generation ----------
ipcMain.handle('image:generate', async (_e, { key, model, prompt, aspect }) => {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt,
        ...(aspect && aspect !== 'auto' ? { aspect_ratio: aspect } : {})
      })
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    const data = await res.json();
    // images come back base64 under data[].b64_json (OpenAI-compatible shape)
    const img = data.data && data.data[0];
    const b64 = img && (img.b64_json || img.image || img.b64);
    const mime = (img && img.media_type) || 'image/png';
    if (!b64) return { ok: false, error: 'no image returned' };
    const cost = data.usage && typeof data.usage.cost === 'number' ? data.usage.cost : 0;
    return { ok: true, b64, mime, cost };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Save a base64 image to disk ----------
ipcMain.handle('image:save', async (_e, { b64, mime }) => {
  const ext = (mime && mime.split('/')[1]) || 'png';
  const res = await dialog.showSaveDialog(win, { title: 'Save image', defaultPath: 'image.' + ext });
  if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
  try { fs.writeFileSync(res.filePath, Buffer.from(b64, 'base64')); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Streaming chat completion ----------
const activeStreams = {};   // requestId -> AbortController

ipcMain.handle('chat:stop', (_e, requestId) => {
  const ctrl = activeStreams[requestId];
  if (ctrl) { ctrl.abort(); return { ok: true }; }
  return { ok: false };
});

ipcMain.handle('chat:send', async (_e, { key, model, messages, requestId, web, temp, maxTok }) => {
  const controller = new AbortController();
  activeStreams[requestId] = controller;
  try {
    // Sanitize every message: ensure image_url data URLs are well-formed.
    // Drops any image part missing a mime type or base64 body so the request
    // never fails the whole turn on one bad attachment.
    const clean = messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      const parts = msg.content.filter(part => {
        if (part.type !== 'image_url') return true;
        const url = part.image_url && part.image_url.url ? String(part.image_url.url) : '';
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!m || !m[1] || !m[2]) {
          console.warn('[chat] dropping malformed image_url:', url.slice(0, 40));
          return false;
        }
        return true;
      });
      return { ...msg, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts };
    });

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: clean, stream: true,
        max_tokens: (typeof maxTok === 'number' && maxTok > 0) ? maxTok : 4096,
        ...(typeof temp === 'number' ? { temperature: temp } : {}),
        reasoning: { enabled: true }, usage: { include: true },
        ...(web ? { plugins: [{ id: 'web', max_results: 5 }] } : {})
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sse = createSseState();
    const processLine = (line) => {
      sse.processLine(line);
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const d = json.choices?.[0]?.delta || {};
        if (d.reasoning) { win.webContents.send('chat:chunk', { requestId, reasoning: d.reasoning }); }
        if (d.content) { win.webContents.send('chat:chunk', { requestId, delta: d.content }); }
      } catch (_) {}
    };
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSseBuffer(buffer, false, processLine);
    }
    buffer += decoder.decode();
    drainSseBuffer(buffer, true, processLine);
    const full = sse.full;
    const usage = sse.usage;
    const citations = sse.citations;
    // OpenRouter returns actual cost in usage.cost (USD) when usage.include is set
    const cost = usage && typeof usage.cost === 'number' ? usage.cost : 0;
    const tokens = usage ? { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 } : null;
    delete activeStreams[requestId];
    return { ok: true, full, cost, tokens, citations };
  } catch (err) {
    delete activeStreams[requestId];
    if (err.name === 'AbortError') return { ok: true, full: '', stopped: true };
    return { ok: false, error: err.message };
  }
});
