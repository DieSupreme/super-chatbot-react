// comfy.js (the IPC layer) driven end-to-end with a stubbed `electron` and a
// mock ComfyUI server: binary preview frames must cross to the renderer as
// comfy:preview events with logged evidence; a JSON-only session must behave
// exactly as before (progress only, no preview events) plus ONE logged hint
// per app session; and generate must prune untouched control values so the
// POSTed graph stays byte-identical to the workflow file.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');

// ---------- electron stub (must be in place BEFORE comfy.js loads) ----------
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-ipc-ud-'));
const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-ipc-app-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-ipc-out-'));
fs.mkdirSync(path.join(appRoot, 'workflows'), { recursive: true });

const handlers = new Map();          // channel -> handler
const events = [];                   // every webContents.send: [channel, payload]
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, p) => events.push([ch, p]) } };
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  app: { getPath: () => userData, getAppPath: () => appRoot, on: () => {} },
  BrowserWindow: { getAllWindows: () => [fakeWin] }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};
const { registerComfyIpc } = require('../../src/main/comfy.js');

const invoke = (ch, args) => handlers.get(ch)({}, args);
const logLines = () => events.filter(([c]) => c === 'comfy:log').map(([, p]) => p.line);
const previews = () => events.filter(([c]) => c === 'comfy:preview').map(([, p]) => p);

// ---------- workflow pair: API format (no conversion, no /object_info) ----------
const GRAPH = {
  1: { class_type: 'CLIPTextEncode', inputs: { text: 'stored prompt' } },
  2: { class_type: 'KSampler', inputs: { seed: 7, cfg: 4.5 } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } }
};
const MANIFEST = {
  label: 'mini', backend: 'comfy', media: 'image', output: '9',
  controls: {
    prompt: { node: '1', input: 'text', type: 'textarea' },
    seed: { node: '2', input: 'seed', type: 'seed' },
    cfg: { node: '2', input: 'cfg', type: 'float', default: 4.5 }
  }
};
fs.writeFileSync(path.join(appRoot, 'workflows', 'mini.json'), JSON.stringify(GRAPH));
fs.writeFileSync(path.join(appRoot, 'workflows', 'mini.manifest.json'), JSON.stringify(MANIFEST));

// ---------- mock ComfyUI ----------
const wsAccept = (key) => crypto.createHash('sha1')
  .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const wsText = (obj) => {
  const t = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from([0x81, t.length]), t]);
};
const wsBinary = (payload) => Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
const previewFrame = (tag) =>
  Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('JPEG-' + tag)]);

let server, base;
let sendPreviews = true;             // per-test: does the "server" produce frames?
let posted = [];                     // captured POST /prompt bodies
const sockets = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/prompt') {
        posted.push(JSON.parse(body));
        res.end(JSON.stringify({ prompt_id: 'p' + posted.length }));
      } else if (req.url.startsWith('/history/')) {
        const id = req.url.split('/').pop();
        res.end(JSON.stringify({
          [id]: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } }
        }));
      } else if (req.url.startsWith('/view')) {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.from('PNGBYTES'));
      } else if (req.url === '/system_stats') {
        res.end('{}');
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    // a sampling run: progress ticks, and (when enabled) a burst of preview
    // frames — more frames than the 250ms throttle can forward
    socket.write(wsText({ type: 'progress', data: { value: 1, max: 4 } }));
    if (sendPreviews) {
      for (let i = 1; i <= 5; i++) socket.write(wsBinary(previewFrame(String(i))));
    }
    socket.write(wsText({ type: 'progress', data: { value: 4, max: 4 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ comfyUrl: base, sdImageDir: outDir, comfyPath: appRoot }));
  registerComfyIpc(fakeElectron.app, () => fakeWin);
});

after(() => {
  Module._load = origLoad;
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
  server.close();
});

test('generate: binary preview frames become comfy:preview events, newest-frame throttled, with logged evidence', async () => {
  sendPreviews = true;
  events.length = 0; posted.length = 0;
  const r = await invoke('comfy:generate', { workflow: 'mini', values: { prompt: 'hello', seed: -1, cfg: 4.5 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const seen = previews();
  assert.ok(seen.length >= 1 && seen.length <= 3, `throttle forwards 1-3 of 5 frames, got ${seen.length}`);
  for (const p of seen) assert.equal(p.mime, 'image/jpeg');
  // the LAST forwarded frame is the NEWEST of the burst, never an early stale one
  assert.equal(Buffer.from(seen[seen.length - 1].b64, 'base64').toString(), 'JPEG-5');
  const evidence = logLines().find((l) => /preview frames: 5 received/.test(l));
  assert.ok(evidence, 'evidence line logged: ' + JSON.stringify(logLines()));
  assert.match(evidence, /\d+ forwarded/);
  // no hint when frames DID arrive
  assert.ok(!logLines().some((l) => /no live-preview frames/.test(l)));
});

test('generate: pruning — untouched cfg stays byte-identical, typed prompt and realized seed patch', async () => {
  const body = posted[posted.length - 1];
  assert.equal(body.prompt['2'].inputs.cfg, 4.5, 'untouched cfg passes through from the FILE');
  assert.equal(body.prompt['1'].inputs.text, 'hello', 'typed prompt patches');
  const seed = body.prompt['2'].inputs.seed;
  assert.ok(Number.isInteger(seed) && seed >= 0, 'seed realized: ' + seed);
  // a deliberately changed cfg patches
  events.length = 0;
  const r = await invoke('comfy:generate', { workflow: 'mini', values: { prompt: 'hello', seed: 5, cfg: 9 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.seeds, { seed: 5 });
  const body2 = posted[posted.length - 1];
  assert.equal(body2.prompt['2'].inputs.cfg, 9);
  assert.equal(body2.prompt['2'].inputs.seed, 5);
});

test('generate: JSON-only session unchanged — progress flows, zero preview events, hint logged ONCE per session', async () => {
  sendPreviews = false;
  events.length = 0;
  const r = await invoke('comfy:generate', { workflow: 'mini', values: { prompt: 'x', seed: -1 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(previews().length, 0, 'no binary frames -> no preview events');
  assert.ok(events.some(([c, p]) => c === 'comfy:progress' && p.max === 4), 'JSON progress still flows');
  const hints = logLines().filter((l) => /no live-preview frames/.test(l));
  assert.equal(hints.length, 1, 'hint logged exactly once');
  assert.match(hints[0], /--preview-method/);

  // second frameless job in the same session: NO second hint
  events.length = 0;
  const r2 = await invoke('comfy:generate', { workflow: 'mini', values: { prompt: 'x', seed: -1 } });
  assert.equal(r2.ok, true);
  assert.equal(logLines().filter((l) => /no live-preview frames/.test(l)).length, 0);
});

test('dryRun: IPC reports diff + dropped wires for the exact graph generate would POST', async () => {
  events.length = 0;
  const r = await invoke('comfy:dryRun', { workflow: 'mini', values: { prompt: 'hello', cfg: 4.5 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.droppedWires, []);
  // cfg pruned (equals default), prompt deliberate -> exactly one annotated diff
  assert.equal(r.diff.length, 1, JSON.stringify(r.diff));
  assert.deepEqual(r.diff[0], {
    node: '1', class_type: 'CLIPTextEncode', input: 'text',
    from: 'stored prompt', to: 'hello', control: 'prompt'
  });
  assert.equal(r.graph['2'].inputs.cfg, 4.5);
  assert.ok(logLines().some((l) => /dry run mini: 3 nodes, 1 patched input\(s\) \(0 unexplained\), 0 dropped wire\(s\)/.test(l)),
    JSON.stringify(logLines()));
});
