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

// clamp a numeric control to its sd-schema.json range
export function clampParam(v, meta) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = meta.def != null ? meta.def : 0;
  if (meta.min != null) n = Math.max(meta.min, n);
  if (meta.max != null) n = Math.min(meta.max, n);
  if (meta.step != null && meta.step >= 1) n = Math.round(n / meta.step) * meta.step;
  return n;
}

// ---------- PNG-info (A1111 infotext) parser ----------
// /sdapi/v1/png-info returns the `parameters` text embedded in a generated
// PNG:  <prompt>\n[Negative prompt: <neg>]\nSteps: 25, Sampler: DPM++ 2M, ...
// This maps that back onto our schema field names so every control can be
// repopulated. Unrecognised keys are preserved in `raw` (never sent to Forge).
const INFOTEXT_KEYS = {
  'Steps': ['steps', 'int'],
  'Sampler': ['sampler_name', 'str'],
  'Schedule type': ['scheduler', 'str'],
  'CFG scale': ['cfg_scale', 'num'],
  'Distilled CFG Scale': ['distilled_cfg_scale', 'num'],
  'Image CFG scale': ['image_cfg_scale', 'num'],
  'Seed': ['seed', 'int'],
  'Size': ['__size', 'wxh'],
  'VAE': ['sd_vae', 'str'],
  'Clip skip': ['CLIP_stop_at_last_layers', 'int'],
  'Denoising strength': ['denoising_strength', 'num'],
  'Variation seed': ['subseed', 'int'],
  'Variation seed strength': ['subseed_strength', 'num'],
  'Seed resize from': ['__seed_resize', 'wxh'],
  'Hires upscale': ['hr_scale', 'num'],
  'Hires steps': ['hr_second_pass_steps', 'int'],
  'Hires upscaler': ['hr_upscaler', 'str'],
  'Hires resize': ['__hr_resize', 'wxh'],
  'Hires CFG Scale': ['hr_cfg', 'num'],
  'Refiner': ['refiner_checkpoint', 'model'],
  'Refiner switch at': ['refiner_switch_at', 'num'],
  'Eta': ['eta', 'num'],
  'Mask blur': ['mask_blur', 'int'],
  'Masked area padding': ['inpaint_full_res_padding', 'int'],
  'Noise multiplier': ['initial_noise_multiplier', 'num'],
  'Batch size': ['batch_size', 'int'],
  'Tiling': ['tiling', 'bool'],
  'Face restoration': ['restore_faces', 'bool']
};

export function parseInfotext(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return null;
  const lines = t.split('\n');
  let paramLine = '';
  if (lines.length > 0 && /(^|, )Steps: \d/.test(lines[lines.length - 1])) paramLine = lines.pop();
  let negStart = lines.findIndex(l => l.startsWith('Negative prompt: '));
  const prompt = (negStart === -1 ? lines : lines.slice(0, negStart)).join('\n').trim();
  const negative = negStart === -1 ? ''
    : [lines[negStart].slice('Negative prompt: '.length), ...lines.slice(negStart + 1)].join('\n').trim();
  if (!paramLine && !prompt) return null;

  const params = {}, raw = {};
  let model = '';
  const re = /\s*([^:,]+):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)/g;
  let m;
  while ((m = re.exec(paramLine)) !== null) {
    const key = m[1].trim();
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    raw[key] = val;
    if (key === 'Model') { model = val; continue; }
    const spec = INFOTEXT_KEYS[key];
    if (!spec) continue;
    const [field, kind] = spec;
    if (kind === 'wxh') {
      const mm = val.match(/^(\d+)\s*x\s*(\d+)$/i);
      if (!mm) continue;
      if (field === '__size') { params.width = Number(mm[1]); params.height = Number(mm[2]); }
      else if (field === '__hr_resize') { params.hr_resize_x = Number(mm[1]); params.hr_resize_y = Number(mm[2]); }
      else { params.seed_resize_from_w = Number(mm[1]); params.seed_resize_from_h = Number(mm[2]); }
    } else if (kind === 'int') { const n = parseInt(val, 10); if (Number.isFinite(n)) params[field] = n; }
    else if (kind === 'num') { const n = parseFloat(val); if (Number.isFinite(n)) params[field] = n; }
    else if (kind === 'bool') { params[field] = val !== 'None' && val !== 'false'; }
    else if (kind === 'model') { params[field] = val.replace(/\s*\[[0-9a-f]+\]$/i, ''); }
    else if (val) params[field] = val;
  }
  if (params.hr_scale != null || params.hr_upscaler || params.hr_resize_x != null) params.enable_hr = true;

  // ADetailer stamps per-unit params as "ADetailer model: x, ADetailer
  // confidence: 0.3, ..." with " 2nd"/" 3rd" suffixes for later units.
  const AD_KEYS = {
    'model': ['ad_model', 'str'],
    'prompt': ['ad_prompt', 'str'],
    'negative prompt': ['ad_negative_prompt', 'str'],
    'confidence': ['ad_confidence', 'num'],
    'denoising strength': ['ad_denoising_strength', 'num']
  };
  const adUnits = [];
  for (const [k, v] of Object.entries(raw)) {
    const mm = k.match(/^ADetailer (.+?)( 2nd| 3rd| 4th)?$/);
    if (!mm || !(mm[1] in AD_KEYS)) continue;
    const idx = mm[2] ? { ' 2nd': 1, ' 3rd': 2, ' 4th': 3 }[mm[2]] : 0;
    const [field, kind] = AD_KEYS[mm[1]];
    const val = kind === 'num' ? parseFloat(v) : v;
    if (kind === 'num' && !Number.isFinite(val)) continue;
    (adUnits[idx] = adUnits[idx] || {})[field] = val;
  }
  const adetailer = adUnits.length ? { enabled: true, units: adUnits.filter(Boolean) } : undefined;

  return { prompt, negative, params, model, raw, adetailer };
}
