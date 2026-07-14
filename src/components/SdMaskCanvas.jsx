import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react';
import { createMask, stampLine, maskHasInk, maskToOverlayRgba } from '../sd-utils.js';

// Dumb inpaint mask editor: the source image sits under a single overlay
// canvas; painting stamps circles into a Uint8Array mask (white = repaint).
// No layers, no zoom. getMask() hands the raw buffer to main, which encodes
// the black/white PNG for /sdapi/v1/img2img.
const UNDO_CAP = 10;

const SdMaskCanvas = forwardRef(function SdMaskCanvas({ src, width, height, brush }, ref) {
  const canvasRef = useRef(null);
  const maskRef = useRef(createMask(width, height));
  const undoRef = useRef([]);
  const paintingRef = useRef(false);
  const lastRef = useRef(null);
  const rafRef = useRef(0);
  const [, bump] = useState(0);   // re-render for undo/clear button state

  // reset when the source image changes size
  useEffect(() => {
    maskRef.current = createMask(width, height);
    undoRef.current = [];
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, width, height]);

  const repaint = useCallback(() => {
    rafRef.current = 0;
    const cv = canvasRef.current;
    const ctx = cv && cv.getContext && cv.getContext('2d');
    if (!ctx || typeof ImageData === 'undefined') return;   // jsdom: preview only
    const mask = maskRef.current;
    try {
      ctx.putImageData(new ImageData(maskToOverlayRgba(mask), mask.width, mask.height), 0, 0);
    } catch (_) {}
  }, []);
  const schedule = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(repaint); };

  useImperativeHandle(ref, () => ({
    getMask: () => {
      const m = maskRef.current;
      return maskHasInk(m) ? { width: m.width, height: m.height, data: m.data } : null;
    }
  }), []);

  // pointer position in mask pixels (canvas is CSS-scaled to fit the panel)
  const toMaskXY = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (width / r.width),
      y: (e.clientY - r.top) * (height / r.height)
    };
  };

  const down = (e) => {
    e.preventDefault();
    if (undoRef.current.length >= UNDO_CAP) undoRef.current.shift();
    undoRef.current.push(maskRef.current.data.slice());
    paintingRef.current = true;
    const p = toMaskXY(e);
    lastRef.current = p;
    stampLine(maskRef.current, p.x, p.y, p.x, p.y, brush);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    schedule(); bump(n => n + 1);
  };
  const move = (e) => {
    if (!paintingRef.current) return;
    const p = toMaskXY(e);
    stampLine(maskRef.current, lastRef.current.x, lastRef.current.y, p.x, p.y, brush);
    lastRef.current = p;
    schedule();
  };
  const up = () => { paintingRef.current = false; lastRef.current = null; };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (prev) { maskRef.current.data.set(prev); schedule(); bump(n => n + 1); }
  };
  const clear = () => {
    if (undoRef.current.length >= UNDO_CAP) undoRef.current.shift();
    undoRef.current.push(maskRef.current.data.slice());
    maskRef.current.data.fill(0);
    schedule(); bump(n => n + 1);
  };

  return (
    <div className="sd-mask">
      <div className="sd-mask-stage">
        <img src={src} alt="inpaint source" draggable={false} />
        <canvas ref={canvasRef} width={width} height={height}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      </div>
      <div className="sd-mask-tools">
        <button className="ghost" onClick={undo} disabled={!undoRef.current.length}>↶ Undo</button>
        <button className="ghost" onClick={clear}>Clear</button>
        <span className="sd-hint">paint the area to replace</span>
      </div>
    </div>
  );
});

export default SdMaskCanvas;
