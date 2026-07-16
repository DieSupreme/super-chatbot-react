// Live-job plumbing: binary preview frames over the /ws socket, reconnect
// with backoff when the server restarts mid-job, queue cancel (pending clear
// + running interrupt), and the /upload/image path that puts a local file
// into ComfyUI's input folder. Mock-server pattern as in comfy-core.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const core = require('../../src/main/comfy-core.js');

// ---------- spawn args ----------
// preview frames only exist if the SERVER renders them — the spawn line must
// carry --preview-method auto (taesd when its models exist, latent2rgb
// otherwise, so it can never break startup)
test('comfyArgs: spawn line enables previews and keeps the standalone flags', () => {
  const portable = core.comfyArgs({ root: 'C:\\ai\\comfy', portable: true, base: 'C:\\ai\\comfy\\ComfyUI', python: 'C:\\ai\\comfy\\python_embeded\\python.exe' }, 8188);
  assert.deepEqual(portable, ['-s', 'ComfyUI\\main.py', '--windows-standalone-build',
    '--disable-auto-launch', '--preview-method', 'auto']);
  // non-default port appended; git-clone layout drops the embedded-python flags
  const clone = core.comfyArgs({ root: 'C:\\src\\comfy', portable: false, base: 'C:\\src\\comfy', python: 'python' }, 8288);
  assert.deepEqual(clone, ['C:\\src\\comfy\\main.py', '--windows-standalone-build',
    '--disable-auto-launch', '--preview-method', 'auto', '--port', '8288']);
});

// ---------- binary preview frame parsing ----------
// ComfyUI binary WS frame: [4B event BE][payload]; event 1 = preview image,
// payload = [4B format BE (1=jpeg, 2=png)][image bytes]
test('parseBinaryPreview: jpeg and png frames decode; other events and runts return null', () => {
  const jpeg = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('JPEGDATA')]);
  const p1 = core.parseBinaryPreview(jpeg);
  assert.equal(p1.mime, 'image/jpeg');
  assert.equal(p1.bytes.toString(), 'JPEGDATA');

  const png = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), Buffer.from('PNGDATA')]);
  assert.equal(core.parseBinaryPreview(png).mime, 'image/png');

  const other = Buffer.concat([Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.from('X')]);
  assert.equal(core.parseBinaryPreview(other), null);      // not a preview event
  assert.equal(core.parseBinaryPreview(Buffer.from([0, 0, 0, 1])), null);   // runt
  assert.equal(core.parseBinaryPreview(null), null);
});

// ---------- WS binary delivery ----------
const wsAccept = (key) => crypto.createHash('sha1')
  .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

test('openManualWs: binary frames reach onBinary; text keeps flowing to onMessage', async () => {
  const sockets = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    const text = JSON.stringify({ type: 'hello' });
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), Buffer.from(text)]));
    const bin = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('FRAME')]);
    socket.write(Buffer.concat([Buffer.from([0x82, bin.length]), bin]));
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const msgs = [], bins = [];
  const ws = core.openManualWs(`http://127.0.0.1:${server.address().port}/ws`, {
    onMessage: (m) => msgs.push(m.type),
    onBinary: (b) => bins.push(b)
  });
  await new Promise(r => setTimeout(r, 300));
  ws.close();
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
  server.close();
  assert.deepEqual(msgs, ['hello']);
  assert.equal(bins.length, 1);
  const p = core.parseBinaryPreview(bins[0]);
  assert.equal(p.bytes.toString(), 'FRAME');
});

// ---------- reconnect with backoff ----------
test('openWsWithRetry: reconnects with growing backoff while active, stops after close()', async () => {
  const sockets = [];
  let conns = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    conns++;
    sockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    socket.on('error', () => {});
    setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 20);   // server "restarts"
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  // injected timer: record the requested delay, reconnect immediately —
  // three drops, then the test closes the client
  const delays = [];
  const reconnects = [];
  let client;
  const setTimer = (fn, d) => { delays.push(d); if (delays.length <= 3) fn(); };
  client = core.openWsWithRetry(`http://127.0.0.1:${server.address().port}/ws`, {
    onReconnect: (d, attempt) => reconnects.push(attempt)
  }, { active: () => true, setTimer });

  await new Promise(r => setTimeout(r, 500));
  client.close();
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
  server.close();

  assert.ok(conns >= 4, `connected ${conns} times (initial + >=3 reconnects)`);
  assert.deepEqual(delays.slice(0, 3), [1000, 2000, 5000]);   // backoff grows
  assert.deepEqual(reconnects.slice(0, 3), [1, 2, 3]);
});

test('openWsWithRetry: an inactive job never reconnects', async () => {
  const sockets = [];
  let conns = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    conns++;
    sockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    socket.on('error', () => {});
    setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 20);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const delays = [];
  const client = core.openWsWithRetry(`http://127.0.0.1:${server.address().port}/ws`, {},
    { active: () => false, setTimer: (fn, d) => delays.push(d) });
  await new Promise(r => setTimeout(r, 200));
  client.close();
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
  server.close();
  assert.equal(delays.length, 0, 'no reconnect scheduled for an inactive job');
});

// ---------- queue cancel ----------
const mkRes = (ok, json = {}, status) => ({ ok, status: status || (ok ? 200 : 500), json: async () => json });

test('cancelAll: pending queue is cleared first, then the running job is interrupted', async () => {
  const calls = [];
  const cf = async (route, opts = {}) => {
    calls.push([route, opts.method || 'GET', opts.body]);
    if (route === '/queue' && !opts.method) return mkRes(true, { queue_running: [['r']], queue_pending: [['a'], ['b']] });
    return mkRes(true, {});
  };
  const r = await core.cancelAll(cf);
  assert.deepEqual(r, { ok: true, interrupted: true, cleared: true });
  assert.deepEqual(calls.map(c => c[0] + ':' + c[1]), ['/queue:GET', '/queue:POST', '/interrupt:POST']);
  assert.deepEqual(calls[1][2], { clear: true });
});

test('cancelAll: empty queue skips the clear; a dead /queue endpoint still interrupts', async () => {
  const calls = [];
  const cf = async (route, opts = {}) => {
    calls.push(route + ':' + (opts.method || 'GET'));
    if (route === '/queue') return mkRes(true, { queue_pending: [] });
    return mkRes(true, {});
  };
  const r = await core.cancelAll(cf);
  assert.deepEqual(calls, ['/queue:GET', '/interrupt:POST']);
  assert.deepEqual(r, { ok: true, interrupted: true, cleared: false });

  const calls2 = [];
  const cf2 = async (route, opts = {}) => {
    calls2.push(route);
    if (route === '/queue') throw new Error('boom');
    return mkRes(true, {});
  };
  const r2 = await core.cancelAll(cf2);
  assert.deepEqual(calls2, ['/queue', '/interrupt']);
  assert.equal(r2.interrupted, true);
});

// ---------- /upload/image ----------
test('uploadImage: multipart POST carries the file; server name (and subfolder) come back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const file = path.join(dir, 'start frame.png');
  fs.writeFileSync(file, Buffer.from('PNGBYTES-0123456789'));

  let seen = null;
  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, type: req.headers['content-type'] || '', body: Buffer.concat(chunks).toString('latin1') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'start frame.png', subfolder: '', type: 'input' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await core.uploadImage(base, file);
  assert.equal(r.name, 'start frame.png');
  assert.equal(seen.url, '/upload/image');
  assert.match(seen.type, /^multipart\/form-data/);
  assert.ok(seen.body.includes('PNGBYTES-0123456789'), 'file bytes in the multipart body');
  assert.ok(seen.body.includes('filename="start frame.png"'), 'original filename preserved');
  assert.ok(seen.body.includes('name="overwrite"'), 'overwrite flag sent');
  server.close();
});

test('uploadImage: subfolder prefixes the returned name; HTTP errors throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const file = path.join(dir, 'x.png');
  fs.writeFileSync(file, 'x');
  let fail = false;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (fail) { res.statusCode = 500; res.end('nope'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'x.png', subfolder: 'clipspace' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await core.uploadImage(base, file)).name, 'clipspace/x.png');
  fail = true;
  await assert.rejects(() => core.uploadImage(base, file), /HTTP 500/);
  await assert.rejects(() => core.uploadImage(base, path.join(dir, 'missing.png')), /ENOENT/);
  server.close();
});
