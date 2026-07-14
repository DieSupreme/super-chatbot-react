// Pure helpers for the Stable Diffusion panel. The inpaint mask is kept as a
// Uint8Array (0 = keep, 255 = repaint) rather than canvas pixels so the paint
// logic is plain JS — testable in jsdom, which has no canvas rasterizer. The
// canvas is only a preview surface; main encodes the buffer to PNG.

export function createMask(width, height) {
  return { width, height, data: new Uint8Array(width * height) };
}

// stamp a filled circle of radius r at (cx, cy)
export function stampCircle(mask, cx, cy, r, value = 255) {
  const { width, height, data } = mask;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) data[y * width + x] = value;
    }
  }
}

// stamp a stroke segment: circles interpolated between two pointer positions
export function stampLine(mask, x0, y0, x1, y1, r, value = 255) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 2)));
  for (let i = 0; i <= steps; i++) {
    stampCircle(mask, x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps), r, value);
  }
}

export function maskHasInk(mask) {
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i] >= 128) return true;
  return false;
}

// fill an RGBA buffer (for canvas putImageData preview): translucent white where masked
export function maskToOverlayRgba(mask, rgba) {
  const { data } = mask;
  const out = rgba || new Uint8ClampedArray(data.length * 4);
  for (let i = 0; i < data.length; i++) {
    const on = data[i] >= 128;
    const o = i * 4;
    out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = on ? 150 : 0;
  }
  return out;
}

// ---------- checkpoint dropdown reconcile ----------
// Same rule as main's sd-core: API entries (exact `title` usable with
// /sdapi/v1/options) win; disk-scan entries fill in while Forge is stopped.
export function reconcileCheckpoints(diskList, apiList) {
  const out = [];
  const seen = new Set();
  const base = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
  for (const m of apiList || []) {
    seen.add(base(m.filename || m.title));
    out.push({ value: m.title, label: m.model_name || m.title, title: m.title });
  }
  for (const d of diskList || []) {
    if (seen.has(base(d.file || d.rel))) continue;
    out.push({ value: d.name, label: d.name, title: null });
  }
  return out;
}

export function loraTag(name, weight) {
  const w = Math.round((Number(weight) || 0) * 100) / 100;
  return `<lora:${name}:${w}>`;
}

// clamp generation dimensions to something Forge accepts (multiples of 8)
export function snapDim(n, min = 64, max = 2048) {
  const v = Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
  return v - (v % 8);
}
