import { test } from 'node:test';
import assert from 'node:assert';
import {
  createMask, stampCircle, stampLine, maskHasInk, maskToOverlayRgba,
  reconcileCheckpoints, loraTag, snapDim
} from '../../src/sd-utils.js';

test('mask: stamp / ink / overlay', () => {
  const m = createMask(10, 10);
  assert.equal(maskHasInk(m), false);
  stampCircle(m, 5, 5, 2);
  assert.equal(m.data[5 * 10 + 5], 255);
  assert.equal(m.data[0], 0);
  assert.equal(maskHasInk(m), true);

  const rgba = maskToOverlayRgba(m);
  assert.equal(rgba[(5 * 10 + 5) * 4 + 3], 150);   // painted -> visible
  assert.equal(rgba[3], 0);                         // untouched -> transparent
});

test('mask: stampLine covers the whole segment', () => {
  const m = createMask(50, 10);
  stampLine(m, 5, 5, 45, 5, 3);
  for (const x of [5, 15, 25, 35, 45]) assert.equal(m.data[5 * 50 + x], 255, `x=${x}`);
  assert.equal(m.data[0], 0);
});

test('reconcileCheckpoints matches API to disk by filename', () => {
  const out = reconcileCheckpoints(
    [{ file: 'D:\\m\\A.safetensors', rel: 'A.safetensors', name: 'A' },
     { file: 'D:\\m\\B.safetensors', rel: 'B.safetensors', name: 'B' }],
    [{ title: 'a.safetensors [123]', model_name: 'a', filename: '/models/a.safetensors' }]
  );
  assert.equal(out.length, 2);                       // A matched case-insensitively, B appended
  assert.equal(out[0].title, 'a.safetensors [123]');
  assert.equal(out[1].value, 'B');
  assert.equal(out[1].title, null);
});

test('loraTag formats weight', () => {
  assert.equal(loraTag('styleXL', 0.8), '<lora:styleXL:0.8>');
  assert.equal(loraTag('x', 0.333333), '<lora:x:0.33>');
});

test('snapDim clamps and rounds to multiples of 8', () => {
  assert.equal(snapDim(1023), 1016);
  assert.equal(snapDim(1024), 1024);
  assert.equal(snapDim(10), 64);
  assert.equal(snapDim(99999), 2048);
});
