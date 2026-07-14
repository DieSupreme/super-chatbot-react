// Mask editor: painting is pure Uint8Array logic (jsdom has no canvas
// rasterizer), and the PNG comes from main's encoder — so the full
// paint → export → PNG pipeline is testable here, decoding the PNG bytes
// to prove white-where-painted / black-elsewhere.
import { describe, it, expect, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import zlib from 'node:zlib';
import SdMaskCanvas from '../../src/components/SdMaskCanvas.jsx';
import { createMask, stampLine, maskHasInk } from '../../src/sd-utils.js';
import { encodeMaskPng } from '../../src/main/sd-core.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function decodePng(b64) {
  const buf = Buffer.from(b64, 'base64');
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks = {};
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    expect(crc).toBe(zlib.crc32(buf.subarray(off + 4, off + 8 + len)));   // chunk integrity
    chunks[type] = data;
    off += 12 + len;
  }
  const ihdr = chunks.IHDR;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  expect(ihdr[8]).toBe(8);   // bit depth
  expect(ihdr[9]).toBe(0);   // grayscale
  const raw = zlib.inflateSync(chunks.IDAT);
  expect(raw.length).toBe(height * (width + 1));
  // strip the per-row filter byte (always 0 = none)
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    px.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, px };
}

describe('mask buffer + PNG export', () => {
  it('a painted stroke exports as a correct black/white PNG (white = inpaint)', () => {
    const mask = createMask(64, 32);
    expect(maskHasInk(mask)).toBe(false);
    stampLine(mask, 10, 16, 50, 16, 6);   // horizontal stroke through the middle
    expect(maskHasInk(mask)).toBe(true);

    const { width, height, px } = decodePng(encodeMaskPng(mask.width, mask.height, mask.data));
    expect(width).toBe(64);
    expect(height).toBe(32);
    expect(px[16 * 64 + 30]).toBe(255);   // on the stroke
    expect(px[16 * 64 + 10]).toBe(255);   // stroke start
    expect(px[0]).toBe(0);                // corner untouched
    expect(px[2 * 64 + 60]).toBe(0);      // off the stroke
    // strictly binary
    for (const v of px) expect(v === 0 || v === 255).toBe(true);
  });

  it('values below the threshold export as black', () => {
    const mask = createMask(4, 1);
    mask.data.set([0, 127, 128, 255]);
    const { px } = decodePng(encodeMaskPng(4, 1, mask.data));
    expect(Array.from(px)).toEqual([0, 0, 255, 255]);
  });
});

describe('SdMaskCanvas component', () => {
  afterEach(() => cleanup());

  function paintAt(canvas, from, to) {
    const opts = { bubbles: true, cancelable: true };
    // jsdom may lack PointerEvent — MouseEvent with the pointer type names
    // reaches React's onPointer* handlers just the same. act() flushes the
    // state bump that enables the Undo button.
    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { ...opts, clientX: from.x, clientY: from.y }));
      canvas.dispatchEvent(new MouseEvent('pointermove', { ...opts, clientX: to.x, clientY: to.y }));
      canvas.dispatchEvent(new MouseEvent('pointerup', opts));
    });
  }

  it('paint → getMask() returns the buffer; undo and clear work', () => {
    const ref = createRef();
    const { container } = render(
      <SdMaskCanvas ref={ref} src={TINY_PNG} width={100} height={100} brush={10} />
    );
    const canvas = container.querySelector('canvas');
    // jsdom lays out nothing — pin the CSS box so pointer→pixel mapping is 1:1
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });

    expect(ref.current.getMask()).toBeNull();   // empty mask -> null (caller demands a mask first)

    paintAt(canvas, { x: 20, y: 50 }, { x: 80, y: 50 });
    const m = ref.current.getMask();
    expect(m).not.toBeNull();
    expect(m.width).toBe(100);
    expect(m.data[50 * 100 + 50]).toBeGreaterThanOrEqual(128);   // painted
    expect(m.data[5 * 100 + 5]).toBe(0);                          // untouched

    // and the exported PNG of exactly this buffer is white along the stroke
    const { px } = decodePng(encodeMaskPng(m.width, m.height, m.data));
    expect(px[50 * 100 + 50]).toBe(255);
    expect(px[5 * 100 + 5]).toBe(0);

    // undo removes the stroke
    const undoBtn = [...container.querySelectorAll('button')].find(b => /Undo/.test(b.textContent));
    expect(undoBtn).not.toBeDisabled();
    fireEvent.click(undoBtn);
    expect(ref.current.getMask()).toBeNull();

    // paint again, clear wipes it
    paintAt(canvas, { x: 30, y: 30 }, { x: 40, y: 40 });
    expect(ref.current.getMask()).not.toBeNull();
    const clearBtn = [...container.querySelectorAll('button')].find(b => /Clear/.test(b.textContent));
    fireEvent.click(clearBtn);
    expect(ref.current.getMask()).toBeNull();
  });
});
