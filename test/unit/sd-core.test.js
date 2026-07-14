// node --test coverage for the electron-free SD core: layout detection,
// model scanning, filename collision handling, reconcile, PNG encoding.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const core = require('../../src/main/sd-core.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sdcore-')); }

test('detectLayout: one-click package vs git clone', () => {
  const oneClick = tmpdir();
  fs.mkdirSync(path.join(oneClick, 'webui'), { recursive: true });
  fs.writeFileSync(path.join(oneClick, 'webui', 'webui-user.bat'), '@echo off');
  const a = core.detectLayout(oneClick);
  assert.equal(a.oneClick, true);
  assert.equal(a.base, path.join(oneClick, 'webui'));

  const clone = tmpdir();
  fs.writeFileSync(path.join(clone, 'webui-user.bat'), '@echo off');
  const b = core.detectLayout(clone);
  assert.equal(b.oneClick, false);
  assert.equal(b.base, clone);
});

test('scanCheckpoints: recursive, extension-filtered, sorted; missing dir is empty', () => {
  const base = tmpdir();
  const sd = path.join(base, 'models', 'Stable-diffusion');
  fs.mkdirSync(path.join(sd, 'xl'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'b.safetensors'), '');
  fs.writeFileSync(path.join(sd, 'a.ckpt'), '');
  fs.writeFileSync(path.join(sd, 'notes.txt'), '');
  fs.writeFileSync(path.join(sd, 'xl', 'c.safetensors'), '');
  const list = core.scanCheckpoints(base);
  assert.deepEqual(list.map(x => x.rel), ['a.ckpt', 'b.safetensors', 'xl/c.safetensors']);
  assert.equal(list[0].name, 'a');
  assert.deepEqual(core.scanLoras(base), []);   // Lora dir absent -> empty, no throw
});

test('reconcileCheckpoints: API titles win, disk-only entries appended', () => {
  const disk = [
    { file: 'D:\\m\\jugg.safetensors', rel: 'jugg.safetensors', name: 'jugg' },
    { file: 'D:\\m\\extra.safetensors', rel: 'extra.safetensors', name: 'extra' }
  ];
  const api = [{ title: 'jugg.safetensors [abc]', model_name: 'jugg', filename: 'D:\\m\\jugg.safetensors' }];
  const out = core.reconcileCheckpoints(disk, api);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'jugg.safetensors [abc]');   // switchable
  assert.equal(out[1].title, null);                        // disk-only
  assert.equal(out[1].value, 'extra');
});

test('imageFileName: stamped name, collision suffix', () => {
  const dir = tmpdir();
  const now = new Date(2026, 6, 13, 9, 5, 7);
  const n1 = core.imageFileName(dir, 1234, now);
  assert.equal(n1, 'sd-20260713-090507-1234.png');
  fs.writeFileSync(path.join(dir, n1), '');
  const n2 = core.imageFileName(dir, 1234, now);
  assert.equal(n2, 'sd-20260713-090507-1234-2.png');
});

test('encodeMaskPng: valid grayscale PNG, thresholded pixels', () => {
  const b64 = core.encodeMaskPng(3, 2, Uint8Array.from([0, 200, 0, 127, 128, 255]));
  const buf = Buffer.from(b64, 'base64');
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.readUInt32BE(16), 3);   // IHDR width
  assert.equal(buf.readUInt32BE(20), 2);   // IHDR height
  // IDAT starts right after IHDR (length 13 + 12 overhead)
  const idatLen = buf.readUInt32BE(33);
  assert.equal(buf.toString('ascii', 37, 41), 'IDAT');
  const raw = zlib.inflateSync(buf.subarray(41, 41 + idatLen));
  assert.deepEqual([...raw], [0, 0, 255, 0, 0, 0, 255, 255]);   // filter0,row / filter0,row
  assert.throws(() => core.encodeMaskPng(4, 4, Uint8Array.from([1, 2])));
});

test('FORGE_ARGS carries the API flag', () => {
  assert.match(core.FORGE_ARGS, /--api/);
});

test('spawn env never lets Forge open a browser', () => {
  const env = core.forgeSpawnEnv();
  assert.equal(env.COMMANDLINE_ARGS, core.FORGE_ARGS);
  assert.equal(env.SD_WEBUI_RESTARTING, '1');   // webui.py skips auto-launch when set
  assert.doesNotMatch(core.FORGE_ARGS, /--autolaunch/);
  assert.doesNotMatch(core.FORGE_ARGS, /--nowebui/);
});

test('scaleMask: nearest-neighbour up and down, identity when equal', () => {
  const src = Uint8Array.from([255, 0, 0, 255]);   // 2x2 checker
  assert.equal(core.scaleMask(src, 2, 2, 2, 2), src);   // identity: same buffer
  const up = core.scaleMask(src, 2, 2, 4, 4);
  assert.equal(up.length, 16);
  assert.equal(up[0], 255); assert.equal(up[1], 255);     // top-left quadrant
  assert.equal(up[2], 0); assert.equal(up[3], 0);         // top-right quadrant
  assert.equal(up[15], 255);                              // bottom-right quadrant
  const down = core.scaleMask(up, 4, 4, 2, 2);
  assert.deepEqual([...down], [255, 0, 0, 255]);
});

test('buildImg2ImgBody: mask scaled to srcW/srcH, user inpaint fields sent', () => {
  const zlib = require('zlib');
  const body = core.buildImg2ImgBody({
    prompt: 'p', steps: 6, cfg: 7, width: 512, height: 512,
    sampler: 'Euler a', seed: 1, denoise: 0.6,
    inpainting_fill: 1, inpaint_full_res_padding: 32,
    maskData: { width: 2, height: 2, data: Uint8Array.from([255, 0, 0, 0]) },
    srcW: 8, srcH: 8
  }, 'INITB64');
  assert.deepEqual(body.init_images, ['INITB64']);
  assert.equal(body.denoising_strength, 0.6);
  assert.equal(body.inpainting_fill, 1);
  assert.equal(body.inpaint_full_res, undefined);   // schema default (true) -> omitted
  assert.equal(body.inpaint_full_res_padding, 32);
  const png = Buffer.from(body.mask, 'base64');
  assert.equal(png.readUInt32BE(16), 8);   // mask width == srcW
  assert.equal(png.readUInt32BE(20), 8);   // mask height == srcH
  const raw = zlib.inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  assert.equal(raw[1], 255);        // (0,0) white — from the painted quadrant
  assert.equal(raw[9 + 7], 0);      // (7,1) black
});

test('buildImg2ImgBody: no mask -> plain img2img body, schema fallbacks', () => {
  const body = core.buildImg2ImgBody({ prompt: 'p', denoise: 0.5 }, 'X');
  assert.equal(body.mask, undefined);
  assert.equal(body.inpaint_full_res, undefined);
  assert.equal(body.denoising_strength, 0.5);
  assert.equal(body.steps, 50);            // schema default (openapi.json f2.0.1)
  assert.equal(body.sampler_name, undefined);   // not chosen -> omitted
});

test('buildTxt2ImgBody: untouched fields are omitted, changed ones sent', () => {
  const body = core.buildTxt2ImgBody({
    prompt: 'p', steps: 25, cfg: 7, width: 1024, height: 1024, sampler: 'DPM++ 2M',
    scheduler: 'karras', batch_size: 1, n_iter: 1,          // batch/n_iter = defaults
    subseed: -1, subseed_strength: 0,                        // defaults
    eta: 0.2, s_churn: 0.5, tiling: true                     // user-touched
  });
  assert.equal(body.scheduler, 'karras');
  assert.equal(body.batch_size, undefined);
  assert.equal(body.n_iter, undefined);
  assert.equal(body.subseed, undefined);
  assert.equal(body.subseed_strength, undefined);
  assert.equal(body.eta, 0.2);
  assert.equal(body.s_churn, 0.5);
  assert.equal(body.tiling, true);
  assert.equal(body.enable_hr, undefined);
  assert.equal(body.override_settings, undefined);
});

test('buildTxt2ImgBody: hires block only when enable_hr', () => {
  const off = core.buildTxt2ImgBody({ prompt: 'p', hr_scale: 2.5 });
  assert.equal(off.enable_hr, undefined);
  assert.equal(off.hr_scale, undefined);
  const on = core.buildTxt2ImgBody({
    prompt: 'p', enable_hr: true, hr_scale: 2.5, hr_upscaler: 'Lanczos',
    hr_second_pass_steps: 0, hr_cfg: 1                       // defaults -> omitted
  });
  assert.equal(on.enable_hr, true);
  assert.equal(on.hr_scale, 2.5);
  assert.equal(on.hr_upscaler, 'Lanczos');
  assert.equal(on.hr_second_pass_steps, undefined);
  assert.equal(on.hr_cfg, undefined);
  // Forge f2.0.1 500s on the schema default (null) — UI default must be sent
  assert.deepEqual(on.hr_additional_modules, ['Use same choices']);
});

test('buildTxt2ImgBody: refiner + override_settings with restore flag', () => {
  const body = core.buildTxt2ImgBody({
    prompt: 'p', refiner_checkpoint: 'sdxl_refiner.safetensors', refiner_switch_at: 0.8,
    override_settings: { CLIP_stop_at_last_layers: 2, sd_vae: 'kl-f8.safetensors' }
  });
  assert.equal(body.refiner_checkpoint, 'sdxl_refiner.safetensors');
  assert.equal(body.refiner_switch_at, 0.8);
  assert.deepEqual(body.override_settings, { CLIP_stop_at_last_layers: 2, sd_vae: 'kl-f8.safetensors' });
  assert.equal(body.override_settings_restore_afterwards, true);
  const none = core.buildTxt2ImgBody({ prompt: 'p', override_settings: {} });
  assert.equal(none.override_settings, undefined);
});

test('buildTxt2ImgBody: ADetailer args built positionally, defaults omitted', () => {
  const body = core.buildTxt2ImgBody({
    prompt: 'p',
    adetailer: {
      enabled: true,
      units: [
        { ad_model: 'face_yolov8n.pt', ad_prompt: '', ad_negative_prompt: '', ad_confidence: 0.3, ad_denoising_strength: 0.5 },
        { ad_model: 'None', ad_prompt: 'x' }   // unit off -> dropped entirely
      ]
    }
  });
  const args = body.alwayson_scripts.ADetailer.args;
  assert.equal(args[0], true);       // enable
  assert.equal(args[1], false);      // skip img2img
  assert.equal(args.length, 3);      // one active unit
  assert.deepEqual(args[2], { ad_model: 'face_yolov8n.pt', ad_denoising_strength: 0.5 }); // defaults + empties omitted
});

test('buildTxt2ImgBody: ADetailer key absent when disabled or unitless', () => {
  assert.equal(core.buildTxt2ImgBody({ prompt: 'p' }).alwayson_scripts, undefined);
  assert.equal(core.buildTxt2ImgBody({
    prompt: 'p', adetailer: { enabled: false, units: [{ ad_model: 'face_yolov8n.pt' }] }
  }).alwayson_scripts, undefined);
  assert.equal(core.buildTxt2ImgBody({
    prompt: 'p', adetailer: { enabled: true, units: [{ ad_model: 'None' }] }
  }).alwayson_scripts, undefined);
});

test('buildImg2ImgBody: ADetailer flows through from the shared builder', () => {
  const body = core.buildImg2ImgBody({
    prompt: 'p', adetailer: { enabled: true, units: [{ ad_model: 'hand_yolov8n.pt', ad_confidence: 0.5 }] }
  }, 'B64');
  assert.deepEqual(body.alwayson_scripts.ADetailer.args, [true, false, { ad_model: 'hand_yolov8n.pt', ad_confidence: 0.5 }]);
});

test('buildTxt2ImgBody: styles array sent only when non-empty', () => {
  assert.deepEqual(core.buildTxt2ImgBody({ prompt: 'p', styles: ['cinematic'] }).styles, ['cinematic']);
  assert.equal(core.buildTxt2ImgBody({ prompt: 'p', styles: [] }).styles, undefined);
});
