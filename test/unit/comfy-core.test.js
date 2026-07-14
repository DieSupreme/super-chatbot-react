const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const core = require('../../src/main/comfy-core.js');

const GRAPH = {
  '1': { class_type: 'EmptyImage', inputs: { width: 320, height: 240, batch_size: 24 } },
  '2': { class_type: 'CreateVideo', inputs: { images: ['1', 0], fps: 12 } }
};
const MANIFEST = {
  label: 'test',
  controls: {
    width: { node: '1', input: 'width', type: 'int', min: 64, max: 2048 },
    frames: { node: '1', input: 'batch_size', type: 'int', min: 1, max: 480 },
    fps: { targets: [{ node: '2', input: 'fps' }], type: 'float', min: 1, max: 60 }
  }
};

test('patchWorkflow: patches only mapped inputs, clamps, leaves graph untouched', () => {
  const out = core.patchWorkflow(GRAPH, MANIFEST, { width: 4096, frames: 30.7, fps: 24 });
  assert.equal(out['1'].inputs.width, 2048);        // clamped to max
  assert.equal(out['1'].inputs.batch_size, 31);     // int-rounded
  assert.equal(out['2'].inputs.fps, 24);            // multi-target form
  assert.equal(out['1'].inputs.height, 240);        // unmapped input untouched
  assert.equal(GRAPH['1'].inputs.width, 320);       // original not mutated
});

test('patchWorkflow: null/empty values leave the template default in place', () => {
  const out = core.patchWorkflow(GRAPH, MANIFEST, { width: null, frames: '', fps: undefined });
  assert.equal(out['1'].inputs.width, 320);
  assert.equal(out['1'].inputs.batch_size, 24);
  assert.equal(out['2'].inputs.fps, 12);
});

test('patchWorkflow: manifest pointing at a missing node throws clearly', () => {
  assert.throws(
    () => core.patchWorkflow(GRAPH, { controls: { x: { node: '99', input: 'y' } } }, { x: 1 }),
    /missing node 99/
  );
});

test('listWorkflows: pairs only, sorted by label, malformed manifests skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.manifest.json'), JSON.stringify({ label: 'Beta', controls: {} }));
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.manifest.json'), JSON.stringify({ label: 'Alpha', controls: {} }));
  fs.writeFileSync(path.join(dir, 'orphan.manifest.json'), JSON.stringify({ label: 'NoGraph' }));  // no .json pair
  fs.writeFileSync(path.join(dir, 'bad.json'), '{}');
  fs.writeFileSync(path.join(dir, 'bad.manifest.json'), 'not json');
  const list = core.listWorkflows(dir);
  assert.deepEqual(list.map(w => w.label), ['Alpha', 'Beta']);
  assert.deepEqual(core.listWorkflows(path.join(dir, 'nope')), []);
});

test('videoFileName: stamped, seed-suffixed, collision-suffixed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const now = new Date(2026, 6, 14, 3, 4, 5);
  const a = core.videoFileName(dir, 42, 'mp4', now);
  assert.equal(a, 'vid-20260714-030405-42.mp4');
  fs.writeFileSync(path.join(dir, a), '');
  assert.equal(core.videoFileName(dir, 42, 'mp4', now), 'vid-20260714-030405-42-2.mp4');
});

test('detectComfyLayout: portable vs clone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-'));
  fs.mkdirSync(path.join(dir, 'python_embeded'));
  fs.writeFileSync(path.join(dir, 'python_embeded', 'python.exe'), '');
  fs.mkdirSync(path.join(dir, 'ComfyUI'));
  fs.writeFileSync(path.join(dir, 'ComfyUI', 'main.py'), '');
  const l = core.detectComfyLayout(dir);
  assert.equal(l.portable, true);
  assert.equal(l.base, path.join(dir, 'ComfyUI'));
  const c = core.detectComfyLayout(path.join(dir, 'ComfyUI'));
  assert.equal(c.portable, false);
  assert.equal(c.python, 'python');
});

test('openWs: RFC6455 handshake, text frames, fragmentation, ping->pong', async () => {
  const got = [];
  let pongSeen = null;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = (s) => Buffer.concat([Buffer.from([0x81, s.length]), Buffer.from(s)]);
    socket.write(text(JSON.stringify({ type: 'hello' })));
    // fragmented message: "{"type":"frag"}" split across two frames
    const whole = JSON.stringify({ type: 'frag' });
    const p1 = whole.slice(0, 5), p2 = whole.slice(5);
    socket.write(Buffer.concat([Buffer.from([0x01, p1.length]), Buffer.from(p1)]));
    socket.write(Buffer.concat([Buffer.from([0x80, p2.length]), Buffer.from(p2)]));
    socket.write(Buffer.from([0x89, 0x00]));   // ping, empty
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 0x0a) pongSeen = true; });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = core.openWs(`http://127.0.0.1:${port}/ws?clientId=t`, { onMessage: (m) => got.push(m.type) });
  await new Promise(r => setTimeout(r, 300));
  ws.close();
  server.close();
  assert.deepEqual(got, ['hello', 'frag']);
  assert.equal(pongSeen, true);
});
