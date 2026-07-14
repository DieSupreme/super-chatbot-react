import { test } from 'node:test';
import assert from 'node:assert';
import {
  createMask, stampCircle, stampLine, maskHasInk, maskToOverlayRgba,
  reconcileCheckpoints, loraTag, snapDim, clampParam, parseInfotext
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

test('parseInfotext: full Forge parameter line round-trips to schema fields', () => {
  const info = [
    'a red fox, detailed fur',
    'second prompt line',
    'Negative prompt: blurry, low quality',
    'Steps: 25, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 7.5, Seed: 42, ' +
    'Size: 1024x768, Model hash: 0da7a319, Model: juggernautXL_ragnarok, VAE: kl-f8.safetensors, ' +
    'Denoising strength: 0.7, Clip skip: 2, Hires upscale: 2.5, Hires steps: 10, Hires upscaler: Lanczos, ' +
    'Variation seed: 99, Variation seed strength: 0.3, Refiner: sdxl_refiner [1f2e3d4c], ' +
    'Refiner switch at: 0.8, Distilled CFG Scale: 3.5, Version: f2.0.1'
  ].join('\n');
  const r = parseInfotext(info);
  assert.equal(r.prompt, 'a red fox, detailed fur\nsecond prompt line');
  assert.equal(r.negative, 'blurry, low quality');
  assert.equal(r.model, 'juggernautXL_ragnarok');
  assert.equal(r.params.steps, 25);
  assert.equal(r.params.sampler_name, 'DPM++ 2M');
  assert.equal(r.params.scheduler, 'Karras');
  assert.equal(r.params.cfg_scale, 7.5);
  assert.equal(r.params.seed, 42);
  assert.equal(r.params.width, 1024);
  assert.equal(r.params.height, 768);
  assert.equal(r.params.sd_vae, 'kl-f8.safetensors');
  assert.equal(r.params.CLIP_stop_at_last_layers, 2);
  assert.equal(r.params.denoising_strength, 0.7);
  assert.equal(r.params.enable_hr, true);
  assert.equal(r.params.hr_scale, 2.5);
  assert.equal(r.params.hr_second_pass_steps, 10);
  assert.equal(r.params.hr_upscaler, 'Lanczos');
  assert.equal(r.params.subseed, 99);
  assert.equal(r.params.subseed_strength, 0.3);
  assert.equal(r.params.refiner_checkpoint, 'sdxl_refiner');
  assert.equal(r.params.refiner_switch_at, 0.8);
  assert.equal(r.params.distilled_cfg_scale, 3.5);
  assert.equal(r.raw['Version'], 'f2.0.1');
});

test('parseInfotext: no negative, no hires, quoted value with commas', () => {
  const r = parseInfotext('a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x512, Lora hashes: "a: b, c: d"');
  assert.equal(r.prompt, 'a cat');
  assert.equal(r.negative, '');
  assert.equal(r.params.enable_hr, undefined);
  assert.equal(r.params.sampler_name, 'Euler a');
  assert.equal(r.raw['Lora hashes'], 'a: b, c: d');
});

test('parseInfotext: garbage and empty input', () => {
  assert.equal(parseInfotext(''), null);
  assert.equal(parseInfotext(null), null);
  const r = parseInfotext('just a prompt with no params');
  assert.equal(r.prompt, 'just a prompt with no params');
  assert.deepEqual(r.params, {});
});

test('clampParam: enforces schema min/max/step', () => {
  assert.equal(clampParam(500, { def: 50, min: 1, max: 150, step: 1 }), 150);
  assert.equal(clampParam(-5, { def: 50, min: 1, max: 150, step: 1 }), 1);
  assert.equal(clampParam(7.4, { def: 50, min: 1, max: 150, step: 1 }), 7);
  assert.equal(clampParam(0.37, { def: 0, min: 0, max: 1, step: 0.01 }), 0.37);
  assert.equal(clampParam('abc', { def: 50, min: 1, max: 150, step: 1 }), 50);
});

test('parseInfotext: ADetailer unit params, including a 2nd unit', () => {
  const r = parseInfotext(
    'portrait\nSteps: 25, Sampler: DPM++ 2M, CFG scale: 7, Seed: 5, Size: 512x512, ' +
    'ADetailer model: face_yolov8n.pt, ADetailer confidence: 0.35, ADetailer denoising strength: 0.45, ' +
    'ADetailer prompt: "detailed face", ADetailer model 2nd: hand_yolov8n.pt, ' +
    'ADetailer confidence 2nd: 0.5, ADetailer version: 26.2.0');
  assert.equal(r.adetailer.enabled, true);
  assert.equal(r.adetailer.units.length, 2);
  assert.deepEqual(r.adetailer.units[0], {
    ad_model: 'face_yolov8n.pt', ad_confidence: 0.35, ad_denoising_strength: 0.45, ad_prompt: 'detailed face'
  });
  assert.deepEqual(r.adetailer.units[1], { ad_model: 'hand_yolov8n.pt', ad_confidence: 0.5 });
});

test('parseInfotext: no ADetailer keys -> adetailer undefined', () => {
  const r = parseInfotext('x\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x512');
  assert.equal(r.adetailer, undefined);
});
