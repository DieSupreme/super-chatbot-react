import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../api.js';
import { reconcileCheckpoints, loraTag, snapDim, clampParam, parseInfotext } from '../sd-utils.js';
import SdMaskCanvas from './SdMaskCanvas.jsx';
import ComfyBody from './VideoPanel.jsx';
import SCHEMA from '../sd-schema.json';
import SD_DEFAULTS from '../sd-defaults.json';

const MODES = [
  { id: 'txt2img', label: 'Text' },
  { id: 'img2img', label: 'Image' },
  { id: 'inpaint', label: 'Inpaint' }
];
// keep huge photos from turning the mask buffer into tens of MB
const MASK_MAX = 1536;

const T = SCHEMA.txt2img, I2I = SCHEMA.img2img, OVR = SCHEMA.overrides, AD = SCHEMA.adetailer;

// one ADetailer detection unit at the extension's schema defaults
const adUnit = () => ({
  ad_model: AD.ad_model.def, ad_prompt: AD.ad_prompt.def, ad_negative_prompt: AD.ad_negative_prompt.def,
  ad_confidence: AD.ad_confidence.def, ad_denoising_strength: AD.ad_denoising_strength.def
});

// Extended params beyond the Basic row — one state object keyed by the exact
// schema field name, initialized to the schema defaults (sd-schema.json is the
// openapi.json ground truth; '' stands in for nullable strings, and nullable
// numerics start as null = "untouched, omit from the request").
const initExtended = () => ({
  scheduler: 'automatic',
  batch_size: T.batch_size.def, n_iter: T.n_iter.def, styles: [],
  subseed: T.subseed.def, subseed_strength: T.subseed_strength.def,
  seed_resize_from_w: T.seed_resize_from_w.def, seed_resize_from_h: T.seed_resize_from_h.def,
  enable_hr: T.enable_hr.def, hr_scale: T.hr_scale.def, hr_upscaler: '',
  hr_second_pass_steps: T.hr_second_pass_steps.def, hr_resize_x: T.hr_resize_x.def, hr_resize_y: T.hr_resize_y.def,
  hr_checkpoint_name: '', hr_sampler_name: '', hr_scheduler: '',
  hr_prompt: T.hr_prompt.def, hr_negative_prompt: T.hr_negative_prompt.def,
  hr_cfg: T.hr_cfg.def, hr_distilled_cfg: T.hr_distilled_cfg.def,
  refiner_checkpoint: '', refiner_switch_at: 0.8,
  restore_faces: false, tiling: false, distilled_cfg_scale: T.distilled_cfg_scale.def,
  eta: null, s_churn: null, s_tmin: null, s_tmax: null, s_noise: null, s_min_uncond: null,
  resize_mode: I2I.resize_mode.def, image_cfg_scale: null, initial_noise_multiplier: null,
  mask_blur: I2I.mask_blur.def, inpainting_fill: I2I.inpainting_fill.def,
  inpaint_full_res: I2I.inpaint_full_res.def, inpaint_full_res_padding: I2I.inpaint_full_res_padding.def,
  inpainting_mask_invert: I2I.inpainting_mask_invert.def
});

const HR_KEYS = Object.keys(initExtended()).filter(k => k === 'enable_hr' || k.startsWith('hr_'));
const INPAINT_KEYS = ['mask_blur', 'inpainting_fill', 'inpaint_full_res', 'inpaint_full_res_padding', 'inpainting_mask_invert'];
const I2I_KEYS = ['resize_mode', 'image_cfg_scale', 'initial_noise_multiplier', ...INPAINT_KEYS];

function StatusPill({ status }) {
  const label = status === 'running' ? 'Forge running'
    : status === 'starting' ? 'Starting Forge…' : 'Forge stopped';
  return <span className={'sd-pill ' + status}>{label}</span>;
}

function ProgressBar({ progress, eta }) {
  return (
    <div className="sd-progress" title={eta > 0 ? `~${Math.ceil(eta)}s left` : undefined}>
      <div className="sd-progress-fill" style={{ width: Math.round(progress * 100) + '%' }} />
    </div>
  );
}

// collapsible stdout pane for the Forge process
function LogPane({ lines, open, onToggle }) {
  const preRef = useRef(null);
  useEffect(() => { if (open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; }, [lines, open]);
  return (
    <details className="sd-log" open={open} onToggle={e => onToggle(e.currentTarget.open)}>
      <summary>Forge log</summary>
      <pre ref={preRef}>{lines.length ? lines.join('\n') : '(no output yet)'}</pre>
    </details>
  );
}

// collapsible parameter section, collapsed by default (Basic stays inline)
function Section({ title, hint, children }) {
  return (
    <details className="sd-sec">
      <summary>{title}{hint ? <span className="sd-hint"> — {hint}</span> : null}</summary>
      {children}
    </details>
  );
}

// numeric input wired to a schema range; empty = null = "omit from request"
// when allowNull, otherwise clamped back onto the range on blur
function NumRow({ label, value, meta, onChange, allowNull, title }) {
  return (
    <label className="sd-row" title={title}>{label}
      <input type="number" min={meta.min} max={meta.max} step={meta.step}
        value={value == null ? '' : value}
        placeholder={allowNull ? 'default' : undefined}
        onChange={e => {
          if (e.target.value === '') { onChange(allowNull ? null : meta.def); return; }
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={e => { if (e.target.value !== '') onChange(clampParam(e.target.value, meta)); }} />
    </label>
  );
}

export default function SdPanel({ open, onToast, onImage, onVideo, onGenStart, onGenFail, convoImages, controlRef }) {
  // media and backend are SEPARATE axes. The toggle picks the media
  // ('image' | 'video'); the model/workflow picked below decides the backend
  // (Forge or ComfyUI) — the user never chooses a backend directly. In image
  // mode one unified list holds Forge checkpoints AND ComfyUI image
  // workflows; imageWf = '' means a Forge checkpoint is selected. The
  // backends still never run simultaneously — main's gpu-lock enforces it.
  const [media, setMedia] = useState('image');
  const [imageWf, setImageWf] = useState('');            // '' = Forge, else ComfyUI workflow name
  const [comfyImageWfs, setComfyImageWfs] = useState([]);
  const [comfyBusy, setComfyBusy] = useState(false);
  const [status, setStatus] = useState('stopped');
  const [statusMsg, setStatusMsg] = useState('');
  const [url, setUrl] = useState('');
  const [managed, setManaged] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [logOpen, setLogOpen] = useState(false);

  const [mode, setMode] = useState('txt2img');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  // Basic controls: initial values are the schema defaults from openapi.json
  const [steps, setSteps] = useState(T.steps.def);
  const [cfg, setCfg] = useState(T.cfg_scale.def);
  const [width, setWidth] = useState(T.width.def);
  const [height, setHeight] = useState(T.height.def);
  const [sampler, setSampler] = useState('');           // '' = model default (schema: null)
  const [seed, setSeed] = useState(T.seed.def);
  const [denoise, setDenoise] = useState(I2I.denoising_strength.def);
  const [xp, setXp] = useState(initExtended);
  const setP = useCallback((k, v) => setXp(prev => ({ ...prev, [k]: v })), []);
  // per-generation overrides (sent via override_settings, never persisted)
  const [ovr, setOvr] = useState({ sd_vae: OVR.sd_vae.def, CLIP_stop_at_last_layers: OVR.CLIP_stop_at_last_layers.def });
  // ADetailer: master toggle + two detection units
  const [ad, setAd] = useState({ enabled: false, units: [adUnit(), adUnit()] });
  const [adModels, setAdModels] = useState([]);
  const setAdUnit = (i, patch) => setAd(prev => ({
    ...prev, units: prev.units.map((u, x) => x === i ? { ...u, ...patch } : u)
  }));
  const toggleAd = (on) => setAd(prev => {
    const units = prev.units.slice();
    // spec default when first enabled: unit 1 = face_yolov8n.pt, denoise 0.4
    if (on && units[0].ad_model === 'None') units[0] = { ...units[0], ad_model: 'face_yolov8n.pt' };
    return { ...prev, enabled: on, units };
  });
  // what Forge's global options currently hold — overrides equal to these are omitted
  const [baseOpts, setBaseOpts] = useState({ checkpoint: '', vae: OVR.sd_vae.def, clipSkip: OVR.CLIP_stop_at_last_layers.def });

  const [samplers, setSamplers] = useState([]);
  const [lists, setLists] = useState({ schedulers: [], upscalers: [], latentUpscaleModes: [], styles: [] });
  const [checkpoints, setCheckpoints] = useState([]);
  const [currentCkpt, setCurrentCkpt] = useState('');
  const [vaes, setVaes] = useState([]);
  const [loras, setLoras] = useState([]);
  const [loraWeight, setLoraWeight] = useState(0.8);
  const [lorasOpen, setLorasOpen] = useState(false);
  const [presets, setPresets] = useState({});
  const [presetSel, setPresetSel] = useState('');
  const [presetName, setPresetName] = useState('');

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ progress: 0, eta: 0 });
  const [lastError, setLastError] = useState('');
  const [lastSeed, setLastSeed] = useState(null);

  // img2img / inpaint source: { b64, mime, label, w, h }
  const [srcImage, setSrcImage] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const maskRef = useRef(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const pushLog = useCallback((line) => {
    setLogLines(prev => [...prev.slice(-499), line]);
  }, []);

  // ---------- boot + events ----------
  const refresh = useCallback(async () => {
    try {
      const r = await api.sd.status();
      if (r && r.ok) {
        setStatus(r.status); setUrl(r.url); setManaged(!!r.managed);
        if (r.log && r.log.length) setLogLines(r.log);
      }
      const [disk, loraR, vaeR, settingsR, wfR] = await Promise.all([
        api.sd.scanCheckpoints(), api.sd.scanLoras(), api.sd.scanVae(), api.getSettings(),
        api.comfy.workflows()
      ]);
      const diskList = disk && disk.ok ? disk.list : [];
      if (wfR && wfR.ok) setComfyImageWfs(wfR.list.filter(w => (w.media || 'video') === 'image'));
      if (loraR && loraR.ok) setLoras(loraR.list);
      if (vaeR && vaeR.ok) setVaes(vaeR.list);
      if (settingsR && settingsR.ok) {
        setPresets({ ...(SD_DEFAULTS.sdPresets || {}), ...(settingsR.settings.sdPresets || {}) });
      }
      if (r && r.ok && r.status === 'running') {
        const [listsR, oR] = await Promise.all([api.sd.lists(), api.sd.getOptions()]);
        if (listsR && listsR.ok) {
          setSamplers((listsR.samplers || []).map(s => s.name));
          setLists({
            schedulers: listsR.schedulers || [],
            upscalers: (listsR.upscalers || []).map(u => u.name),
            latentUpscaleModes: (listsR.latentUpscaleModes || []).map(u => u.name),
            styles: (listsR.styles || []).map(s => s.name)
          });
          setCheckpoints(reconcileCheckpoints(diskList, listsR.models || []));
        } else {
          setCheckpoints(reconcileCheckpoints(diskList, []));
        }
        if (oR && oR.ok) {
          setBaseOpts({ checkpoint: oR.checkpoint, vae: oR.vae ?? OVR.sd_vae.def, clipSkip: oR.clipSkip ?? OVR.CLIP_stop_at_last_layers.def });
          if (oR.checkpoint) setCurrentCkpt(prev => prev || oR.checkpoint);
        }
      } else {
        // Forge stopped — dropdown still populates from the disk scan
        setCheckpoints(reconcileCheckpoints(diskList, []));
      }
    } catch (err) {
      setStatus('stopped');
      setStatusMsg(String(err && err.message || err));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ADetailer model list — fetched lazily and re-tried on enable, because the
  // extension registers its endpoints a few seconds AFTER Forge's API answers
  useEffect(() => {
    if (status !== 'running' || adModels.length) return;
    let alive = true;
    api.sd.adModels().then(r => { if (alive && r && r.ok) setAdModels(r.models || []); });
    return () => { alive = false; };
  }, [status, ad.enabled, adModels.length]);

  useEffect(() => {
    const offP = api.sd.onProgress((d) => setProgress(d.done ? { progress: 0, eta: 0 } : d));
    const offL = api.sd.onLog((d) => pushLog(d.line));
    const offS = api.sd.onStatus((d) => {
      const was = statusRef.current;
      setStatus(d.status); setManaged(!!d.managed);
      setStatusMsg(d.message || '');
      if (d.status === 'running' && was !== 'running') refresh();
    });
    return () => { offP(); offL(); offS(); };
  }, [pushLog, refresh]);

  const refreshLists = async () => {
    await api.sd.refreshLists();
    await refresh();
    onToast('Model lists refreshed');
  };

  // ---------- process control ----------
  const startForge = async () => {
    setLogOpen(true);
    const r = await api.sd.start();
    if (!r.ok) onToast('Could not start Forge: ' + (r.error || 'unknown'), 'warn');
    else setStatus(r.status);
  };
  const stopForge = async () => {
    const r = await api.sd.stop();
    if (!r.ok) onToast(r.error || 'Could not stop Forge', 'warn');
    else if (!r.portFree) onToast('Forge killed but port still busy — check Task Manager', 'warn');
  };

  // ---------- lora ----------
  const insertLora = (name) => setPrompt(p => (p ? p.trimEnd() + ' ' : '') + loraTag(name, loraWeight));

  // ---------- source image (img2img / inpaint) ----------
  // `path` is kept when the source came from disk — it lets a stored image
  // message replay img2img generations after an app restart.
  const setSource = (b64, mime, label, path) => {
    const img = new Image();
    img.onload = () => setSrcImage({ b64, mime, label, path, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => onToast('Could not read that image', 'warn');
    img.src = `data:${mime};base64,${b64}`;
    setShowPicker(false);
  };
  const pickConvoImage = async (ci) => {
    if (ci.b64) { setSource(ci.b64, ci.mime || 'image/png', ci.label); return; }
    const r = await api.sd.readImage(ci.path);
    if (r.ok) setSource(r.b64, r.mime, ci.label, ci.path);
    else onToast('Could not load image: ' + (r.error || 'unknown'), 'warn');
  };
  const fileToB64 = (f) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : '');
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(f);
  });
  const onDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const f = files.find(f => f.type && f.type.startsWith('image/'));
    if (!f) return;
    const p = api.getPathForFile(f);
    if (p) {
      const r = await api.readFiles([p]);
      const a = r.ok && r.files.find(x => x.kind === 'image');
      if (a) { setSource(a.data, a.mime, a.name, p); return; }
    }
    const b64 = await fileToB64(f);
    if (b64) setSource(b64, f.type, f.name);
  };
  // Paste routing: while the panel is open in a source mode, an image paste
  // belongs to the source box ("Drop or paste an image here") regardless of
  // which element has focus. Paste events target the focused element, and the
  // panel's divs are unfocusable — an onPaste prop on the aside only ever fired
  // by focus-accident. A window listener in the CAPTURE phase runs before the
  // chat-attach paste listener in App; stopPropagation keeps the image out of
  // the chat attach bar.
  useEffect(() => {
    if (!open || mode === 'txt2img') return;
    const onPaste = (e) => {
      const item = Array.from((e.clipboardData || {}).items || []).find(i => i.type && i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault(); e.stopPropagation();
      const mime = item.type;
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const b64 = s.includes(',') ? s.slice(s.indexOf(',') + 1) : '';
        if (b64) setSource(b64, mime, 'pasted image');
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // when a source lands, default output size to (snapped) source size
  useEffect(() => {
    if (srcImage) { setWidth(snapDim(srcImage.w)); setHeight(snapDim(srcImage.h)); }
  }, [srcImage]);

  // ---------- apply parameters (PNG-info import / presets) ----------
  const schedulerByName = (v) => {
    const s = String(v || '').toLowerCase();
    const hit = lists.schedulers.find(x => x.name.toLowerCase() === s || String(x.label || '').toLowerCase() === s);
    return hit ? hit.name : s.replace(/ /g, '_');
  };
  const applyParams = useCallback((pr, model) => {
    if (pr.steps != null) setSteps(pr.steps);
    if (pr.cfg_scale != null) setCfg(pr.cfg_scale);
    if (pr.width != null) setWidth(pr.width);
    if (pr.height != null) setHeight(pr.height);
    if (pr.seed != null) setSeed(pr.seed);
    if (pr.sampler_name) setSampler(pr.sampler_name);
    if (pr.denoising_strength != null) setDenoise(pr.denoising_strength);
    setXp(prev => {
      const next = { ...prev };
      for (const k of Object.keys(pr)) {
        if (k in next && !['scheduler'].includes(k)) next[k] = pr[k];
      }
      if (pr.scheduler) next.scheduler = schedulerByName(pr.scheduler);
      return next;
    });
    setOvr(prev => ({
      sd_vae: pr.sd_vae != null ? pr.sd_vae : prev.sd_vae,
      CLIP_stop_at_last_layers: pr.CLIP_stop_at_last_layers != null ? pr.CLIP_stop_at_last_layers : prev.CLIP_stop_at_last_layers
    }));
    if (pr.adetailer) {
      setAd({
        enabled: !!pr.adetailer.enabled,
        units: [0, 1].map(i => ({ ...adUnit(), ...((pr.adetailer.units || [])[i] || {}) }))
      });
    }
    if (model) {
      const base = (s) => String(s || '').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt)$/i, '').toLowerCase();
      const hit = checkpoints.find(c => base(c.label) === base(model) || base(c.value) === base(model));
      if (hit) setCurrentCkpt(hit.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpoints, lists.schedulers]);

  // First open starts from the shipped default preset (sensible SDXL values);
  // the schema defaults stay underneath for anything the preset doesn't name.
  useEffect(() => {
    const name = Object.keys(SD_DEFAULTS.sdPresets || {})[0];
    if (name) { applyParams(SD_DEFAULTS.sdPresets[name], null); setPresetSel(name); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PNG-info import: drop any Forge-generated PNG on the panel (outside the
  // source box) and every control repopulates from its embedded parameters.
  const importPngInfo = async (f) => {
    const b64 = await fileToB64(f);
    if (!b64) { onToast('Could not read that PNG', 'warn'); return; }
    const r = await api.sd.pngInfo(b64);
    if (!r.ok) { onToast('PNG info failed: ' + (r.error || 'unknown'), 'warn'); return; }
    const parsed = parseInfotext(r.info);
    if (!parsed || (!parsed.prompt && !Object.keys(parsed.params).length)) {
      onToast('No generation parameters in that PNG', 'warn'); return;
    }
    setPrompt(parsed.prompt);
    setNegative(parsed.negative);
    applyParams({ ...parsed.params, ...(parsed.adetailer ? { adetailer: parsed.adetailer } : {}) }, parsed.model);
    onToast('Imported settings from PNG' + (parsed.model ? ` (model: ${parsed.model})` : ''));
  };
  const onPanelDrop = (e) => {
    if (e.target.closest && e.target.closest('.sd-source')) return;  // source box wins
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const f = files.find(x => (x.type === 'image/png') || /\.png$/i.test(x.name || ''));
    if (!f) return;
    e.preventDefault(); e.stopPropagation();   // keep it out of the chat attach bar
    importPngInfo(f);
  };

  // ---------- presets ----------
  const snapshotParams = () => ({
    steps, cfg_scale: cfg, width, height, sampler_name: sampler || undefined,
    seed, denoising_strength: denoise,
    ...Object.fromEntries(Object.entries(xp).filter(([, v]) => v !== null && v !== '')),
    sd_vae: ovr.sd_vae, CLIP_stop_at_last_layers: ovr.CLIP_stop_at_last_layers,
    adetailer: ad
  });
  const applyPreset = (name) => {
    setPresetSel(name);
    const p = presets[name];
    if (p) { applyParams(p, null); onToast(`Preset "${name}" applied`); }
  };
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) { onToast('Name the preset first', 'warn'); return; }
    const next = { ...presets, [name]: snapshotParams() };
    setPresets(next); setPresetName(''); setPresetSel(name);
    const r = await api.getSettings();
    if (r && r.ok) {
      const user = { ...(r.settings.sdPresets || {}), [name]: next[name] };
      await api.saveSettings({ ...r.settings, sdPresets: user });
    }
    onToast(`Preset "${name}" saved`);
  };

  // ---------- generate / stop ----------
  // Assemble the sparse request params: only fields the user changed from the
  // schema default survive (main's body builder drops the rest), inactive
  // sections are stripped entirely, and overrides matching Forge's live
  // options are omitted.
  const buildParams = () => {
    const p = {
      prompt: prompt.trim(), negative, steps, cfg, width, height, seed,
      ...(sampler ? { sampler } : {})
    };
    const x = { ...xp };
    if (x.scheduler === 'automatic') delete x.scheduler;
    if (!x.enable_hr) for (const k of HR_KEYS) delete x[k];
    if (!x.refiner_checkpoint) { delete x.refiner_checkpoint; delete x.refiner_switch_at; }
    if (!x.restore_faces) delete x.restore_faces;
    if (!x.tiling) delete x.tiling;
    if (mode === 'txt2img') for (const k of I2I_KEYS) delete x[k];
    else if (mode !== 'inpaint') for (const k of INPAINT_KEYS) delete x[k];
    for (const k of Object.keys(x)) if (x[k] === null || x[k] === '') delete x[k];
    Object.assign(p, x);
    // hires needs a denoising strength too — Forge crashes on its None default
    if (mode !== 'txt2img' || xp.enable_hr) p.denoising_strength = denoise;
    // nothing null-ish crosses the IPC boundary (main sanitizes again)
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) delete p[k];
    }

    const o = {};
    const ck = checkpoints.find(c => c.value === currentCkpt);
    if (ck && ck.title && ck.title !== baseOpts.checkpoint) o.sd_model_checkpoint = ck.title;
    if (ovr.sd_vae !== baseOpts.vae) o.sd_vae = ovr.sd_vae;
    if (Number(ovr.CLIP_stop_at_last_layers) !== Number(baseOpts.clipSkip)) o.CLIP_stop_at_last_layers = Number(ovr.CLIP_stop_at_last_layers);
    if (Object.keys(o).length) p.override_settings = o;
    if (ad.enabled && ad.units.some(u => u.ad_model !== 'None')) p.adetailer = ad;
    return p;
  };

  // shared by the Generate button and the chat-side image actions: fires the
  // request, handles the result, and hands the message BACK the full params
  // that produced it (pixel buffers stripped at persist time)
  const runGeneration = async (payload, genMode, promptText) => {
    setBusy(true); setLastError(''); setProgress({ progress: 0, eta: 0 });
    try {
      const r = genMode === 'txt2img' ? await api.sd.txt2img(payload) : await api.sd.img2img(payload);
      if (!r.ok) {
        if (r.offline) { setStatus('stopped'); setStatusMsg(r.error); }
        else setLastError(r.error || 'generation failed');
        return;
      }
      setLastSeed(r.seed);
      const { initB64, ...replayable } = payload;
      // backend rides along so Regenerate replays against Forge, not ComfyUI
      const genParams = { ...replayable, seed: r.seed, mode: genMode, backend: 'forge' };
      for (const f of r.files) onImage({ path: f.path, name: f.name, prompt: promptText, seed: r.seed, mode: genMode, genParams });
    } catch (err) {
      setLastError(String(err && err.message || err).slice(0, 300));
    } finally {
      setBusy(false);
      setProgress({ progress: 0, eta: 0 });
    }
  };

  const generate = async () => {
    const p = prompt.trim();
    if (!p) { onToast('Type a prompt first', 'warn'); return; }
    if (mode !== 'txt2img' && !srcImage) { onToast('Choose a source image first', 'warn'); return; }
    let maskData = null;
    if (mode === 'inpaint') {
      maskData = maskRef.current && maskRef.current.getMask();
      if (!maskData) { onToast('Paint a mask first — white areas get repainted', 'warn'); return; }
    }
    const base = buildParams();
    const payload = mode === 'txt2img' ? base : {
      ...base, initB64: srcImage.b64,
      ...(srcImage.path ? { initPath: srcImage.path } : {}),
      // srcW/srcH: main rescales the (resolution-capped) mask to the
      // source image's exact dimensions before encoding
      ...(maskData ? { maskData, srcW: srcImage.w, srcH: srcImage.h } : {})
    };
    runGeneration(payload, mode, p);
  };
  const stopJob = () => api.sd.interrupt();

  // ---------- chat-side image actions (Regenerate / Reuse / Send-to) ----------
  // stored genParams use the wire shape; map the short names back for the
  // panel-state route (applyParams expects schema names)
  const applyWireParams = (gp) => {
    const pr = { ...gp };
    for (const k of ['prompt', 'negative', 'initB64', 'initPath', 'maskData', 'srcW', 'srcH', 'mode']) delete pr[k];
    if (gp.cfg != null) { pr.cfg_scale = gp.cfg; delete pr.cfg; }
    if (gp.sampler != null) { pr.sampler_name = gp.sampler; delete pr.sampler; }
    if (gp.override_settings) { Object.assign(pr, gp.override_settings); delete pr.override_settings; }
    if (gp.prompt != null) setPrompt(gp.prompt);
    if (gp.negative != null) setNegative(gp.negative);
    applyParams(pr, gp.override_settings && gp.override_settings.sd_model_checkpoint);
  };
  // switching modes mid-generation would orphan the progress UI — refuse
  const switchMedia = (m) => {
    if (m === media) return false;
    if (busy || comfyBusy) { onToast('A generation is running — stop it before switching modes', 'warn'); return false; }
    setMedia(m);
    return true;
  };
  // unified image list: 'forge:<checkpoint>' routes to Forge,
  // 'comfy:<workflow>' routes to ComfyUI — the app picks the backend
  const pickImageModel = (v) => {
    if (busy || comfyBusy) { onToast('A generation is running — stop it before switching models', 'warn'); return; }
    if (v.startsWith('comfy:')) setImageWf(v.slice(6));
    else { setImageWf(''); setCurrentCkpt(v.slice(6)); }
  };

  useEffect(() => {
    if (!controlRef) return;
    // MERGE onto the shared control surface — ComfyBody adds its replay
    // functions to the same object while a ComfyUI body is mounted
    controlRef.current = {
      ...(controlRef.current || {}),
      // chat-side routing target: { media, backend?, workflow? } — regenerate
      // on a stored message steers the panel to the body that produced it
      showTarget: (t) => {
        if (!t || !t.media) return;
        if (t.media !== media && !switchMedia(t.media)) return;
        if (t.media === 'image') {
          if (t.backend === 'comfy' && t.workflow) setImageWf(t.workflow);
          else if (t.backend === 'forge') setImageWf('');
        }
      },
      // kind:'image' Regenerate — replay the stored params (seed -1 unless kept)
      regenerate: (gp, opts = {}) => {
        if (!gp) { onToast('This image has no stored settings to replay', 'warn'); return; }
        if (statusRef.current !== 'running') { onToast('Start Forge first, then regenerate', 'warn'); return; }
        if (busy) { onToast('A generation is already running', 'warn'); return; }
        const gmode = gp.mode || 'txt2img';
        if (gmode !== 'txt2img' && !gp.initPath && !gp.initB64) {
          onToast('Original source image unavailable — use → img2img instead', 'warn'); return;
        }
        const { mode: _m, seed: storedSeed, ...rest } = gp;
        runGeneration({ ...rest, seed: opts.keepSeed ? storedSeed : -1 }, gmode, gp.prompt || '');
      },
      loadSettings: (gp) => {
        if (!gp) { onToast('This image has no stored settings', 'warn'); return; }
        applyWireParams(gp);
        onToast('Settings loaded into the panel');
      },
      sendImage: async (path, m) => {
        setMode(m);
        const r = await api.sd.readImage(path);
        if (r && r.ok) setSource(r.b64, r.mime, path.split(/[\\/]/).pop(), path);
        else onToast('Could not load image: ' + ((r && r.error) || 'unknown'), 'warn');
      }
    };
  });

  // ---------- render ----------
  const running = status === 'running';
  const sourceModes = mode !== 'txt2img';
  const hrUpscalers = [...lists.latentUpscaleModes, ...lists.upscalers];
  const maskDims = srcImage ? (() => {
    const s = Math.min(1, MASK_MAX / Math.max(srcImage.w, srcImage.h));
    return { w: Math.max(1, Math.round(srcImage.w * s)), h: Math.max(1, Math.round(srcImage.h * s)) };
  })() : null;

  const ckptSelect = (value, onChange, emptyLabel) => (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {checkpoints.filter(c => c.title).map(c => (
        <option key={c.value} value={c.title}>{c.label}</option>
      ))}
    </select>
  );

  return (
    <aside className={'sd-panel' + (open ? ' open' : '')}
      onDrop={onPanelDrop} onDragOver={e => { e.preventDefault(); }}>
      {/* media toggle — what to make, not which backend; the model picked
          below decides Forge vs ComfyUI (one GPU, one backend at a time) */}
      <div className="sd-tabs sd-backend" title="Pick what to make — the model choice decides the backend. Forge and ComfyUI never run together.">
        <button className={'sd-tab' + (media === 'image' ? ' active' : '')}
          onClick={() => switchMedia('image')}>Image</button>
        <button className={'sd-tab' + (media === 'video' ? ' active' : '')}
          onClick={() => switchMedia('video')}>Video</button>
      </div>

      {/* image mode: ONE list — Forge checkpoints and ComfyUI image
          workflows together; picking an entry routes to its backend */}
      {media === 'image' && (
        <label className="sd-row sd-model-row"
          title="Checkpoints generate on Forge; workflows generate on ComfyUI — starting one backend stops the other">Model
          <select value={imageWf ? 'comfy:' + imageWf : 'forge:' + currentCkpt}
            onChange={e => pickImageModel(e.target.value)}>
            {!imageWf && !checkpoints.some(c => c.value === currentCkpt) &&
              <option value={'forge:' + currentCkpt}>(select a model…)</option>}
            <optgroup label="Checkpoints — Forge">
              {checkpoints.map(c => <option key={c.value} value={'forge:' + c.value}>{c.label}</option>)}
            </optgroup>
            {comfyImageWfs.length > 0 && (
              <optgroup label="Workflows — ComfyUI">
                {comfyImageWfs.map(w => <option key={w.name} value={'comfy:' + w.name}>{w.label}</option>)}
              </optgroup>
            )}
          </select>
        </label>
      )}

      {media === 'video' ? (
        <ComfyBody media="video" onToast={onToast} onImage={onImage} onVideo={onVideo}
          onGenStart={onGenStart} onGenFail={onGenFail}
          controlRef={controlRef} onBusyChange={setComfyBusy} />
      ) : imageWf ? (
        <ComfyBody media="image" workflow={imageWf} onToast={onToast} onImage={onImage} onVideo={onVideo}
          onGenStart={onGenStart} onGenFail={onGenFail}
          controlRef={controlRef} onBusyChange={setComfyBusy} />
      ) : (<>
      <div className="sd-head">
        <h3>Stable Diffusion</h3>
        <StatusPill status={status} />
        {running && managed && <button className="ghost sd-mini" onClick={stopForge}>Stop Forge</button>}
      </div>

      {!running && status !== 'starting' && (
        <div className="sd-offline">
          <div>Forge not running at <code>{url || '…'}</code>{statusMsg ? ` — ${statusMsg}` : ''}</div>
          <div className="sd-offline-actions">
            <button className="ghost" onClick={refresh}>Retry</button>
            <button onClick={startForge}>Start</button>
          </div>
        </div>
      )}
      {status === 'starting' && (
        <div className="sd-offline">
          <div><span className="dots">Starting Forge</span> — usually 30–90s, log below.</div>
        </div>
      )}

      <div className="sd-body">
        <div className="sd-tabs">
          {MODES.map(m => (
            <button key={m.id} className={'sd-tab' + (mode === m.id ? ' active' : '')}
              onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>

        <div className="sd-preset-row">
          <select value={presetSel} onChange={e => applyPreset(e.target.value)} title="Apply a saved preset">
            <option value="">Presets…</option>
            {Object.keys(presets).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <input className="set-text" placeholder="save as…" value={presetName}
            onChange={e => setPresetName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') savePreset(); }} />
          <button className="ghost sd-mini" onClick={savePreset}>Save</button>
        </div>

        {sourceModes && (
          <div className="sd-source" onDrop={onDrop} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}>
            {srcImage ? (
              <div className="sd-source-set">
                <img src={`data:${srcImage.mime};base64,${srcImage.b64}`} alt={srcImage.label} />
                <div className="sd-source-meta">
                  <span title={srcImage.label}>{srcImage.label}</span>
                  <span className="sd-hint">{srcImage.w}×{srcImage.h}</span>
                  <button className="ghost sd-mini" onClick={() => setSrcImage(null)}>✕ Change</button>
                </div>
              </div>
            ) : (
              <div className="sd-source-empty">
                <div>Drop or paste an image here</div>
                {convoImages.length > 0 && (
                  <button className="ghost sd-mini" onClick={() => setShowPicker(s => !s)}>
                    …or pick from this chat ({convoImages.length})
                  </button>
                )}
                {showPicker && (
                  <div className="sd-picker">
                    {convoImages.map((ci, i) => (
                      <button key={i} className="ghost sd-mini" onClick={() => pickConvoImage(ci)}>{ci.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {mode === 'inpaint' && srcImage && maskDims && (
          <SdMaskCanvasWithBrush ref={maskRef}
            src={`data:${srcImage.mime};base64,${srcImage.b64}`}
            width={maskDims.w} height={maskDims.h} />
        )}

        <label className="sd-row">Prompt
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
            placeholder="what to generate…" />
        </label>
        <label className="sd-row">Negative prompt
          <textarea value={negative} onChange={e => setNegative(e.target.value)} rows={2}
            placeholder="what to avoid (optional)" />
        </label>

        {/* prompt cluster: everything that edits the prompt sits next to it */}
        {lists.styles.length > 0 && (
          <label className="sd-row">Styles <span className="sd-hint">(ctrl-click for several)</span>
            <select multiple size={3} value={xp.styles}
              onChange={e => setP('styles', Array.from(e.target.selectedOptions).map(o => o.value))}>
              {lists.styles.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}

        <details className="sd-loras" open={lorasOpen} onToggle={e => setLorasOpen(e.currentTarget.open)}>
          <summary>LoRAs ({loras.length})</summary>
          {!loras.length
            ? <div className="sd-hint sd-loras-empty">none found in models\Lora</div>
            : <>
                <label className="sd-row">Weight <span className="set-val">{loraWeight.toFixed(2)}</span>
                  <input type="range" min="-1" max="2" step="0.05" value={loraWeight}
                    onChange={e => setLoraWeight(parseFloat(e.target.value))} />
                </label>
                <div className="sd-lora-list">
                  {loras.map(l => (
                    <button key={l.rel} className="ghost sd-mini" title={'insert ' + loraTag(l.name, loraWeight)}
                      onClick={() => insertLora(l.name)}>{l.name}</button>
                  ))}
                </div>
              </>}
        </details>

        <div className="sd-group">Model</div>
        <label className="sd-row">Checkpoint
          <span className="sd-ckpt-row">
            <select value={currentCkpt} onChange={e => setCurrentCkpt(e.target.value)}
              title="Sent per-request via override_settings — no global switch">
              {!checkpoints.length && <option value="">(no checkpoints found)</option>}
              {checkpoints.length > 0 && !checkpoints.some(c => c.value === currentCkpt) &&
                <option value="">(select…)</option>}
              {checkpoints.map(c => (
                <option key={c.value} value={c.value} disabled={!c.title && running}>
                  {c.label}{c.title ? '' : ' (on disk)'}
                </option>
              ))}
            </select>
            <button className="ghost sd-mini" onClick={refreshLists} disabled={!running}
              title="Rescan checkpoints / VAEs / LoRAs without restarting Forge">🔄</button>
          </span>
        </label>
        <div className="sd-grid">
          <label className="sd-row">Sampler
            <select value={sampler} onChange={e => setSampler(e.target.value)}>
              <option value="">(model default)</option>
              {samplers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="sd-row">Scheduler
            <select value={xp.scheduler} onChange={e => setP('scheduler', e.target.value)}>
              {!lists.schedulers.length && <option value="automatic">Automatic</option>}
              {lists.schedulers.map(s => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
            </select>
          </label>
        </div>

        <div className="sd-group">Sampling</div>
        <div className="sd-grid">
          <label className="sd-row">Steps <span className="set-val">{steps}</span>
            <input type="range" min={T.steps.min} max={T.steps.max} value={steps}
              onChange={e => setSteps(parseInt(e.target.value))} />
          </label>
          <label className="sd-row">CFG <span className="set-val">{cfg}</span>
            <input type="range" min={T.cfg_scale.min} max={T.cfg_scale.max} step={T.cfg_scale.step} value={cfg}
              onChange={e => setCfg(parseFloat(e.target.value))} />
          </label>
          <label className="sd-row">Width
            <input type="number" step={T.width.step} min={T.width.min} max={T.width.max} value={width}
              onChange={e => setWidth(parseInt(e.target.value) || T.width.def)} onBlur={e => setWidth(snapDim(e.target.value))} />
          </label>
          <label className="sd-row">Height
            <input type="number" step={T.height.step} min={T.height.min} max={T.height.max} value={height}
              onChange={e => setHeight(parseInt(e.target.value) || T.height.def)} onBlur={e => setHeight(snapDim(e.target.value))} />
          </label>
          <label className="sd-row">Seed
            <input type="number" value={seed} title="-1 = random"
              onChange={e => {
                const n = parseInt(e.target.value, 10);
                setSeed(Number.isFinite(n) ? n : T.seed.def);   // cleared -> -1 (random)
              }} />
          </label>
          <NumRow label="Batch size" value={xp.batch_size} meta={T.batch_size} onChange={v => setP('batch_size', v)} />
          <NumRow label="Batch count" value={xp.n_iter} meta={T.n_iter} onChange={v => setP('n_iter', v)}
            title="n_iter: sequential batches" />
        </div>

        {sourceModes && (
          <label className="sd-row">Denoising strength <span className="set-val">{denoise.toFixed(2)}</span>
            <input type="range" min={I2I.denoising_strength.min} max={I2I.denoising_strength.max}
              step={I2I.denoising_strength.step} value={denoise}
              onChange={e => setDenoise(parseFloat(e.target.value))} />
          </label>
        )}

        <Section title="Seed" hint="variation / resize">
          <button className="ghost sd-mini" disabled={lastSeed == null}
            onClick={() => setSeed(lastSeed)} title="Set seed to the last generation's seed">
            ♻ Reuse last seed{lastSeed != null ? ` (${lastSeed})` : ''}
          </button>
          <div className="sd-grid">
            <NumRow label="Variation seed" value={xp.subseed} meta={T.subseed} onChange={v => setP('subseed', v)} />
            <NumRow label="Variation strength" value={xp.subseed_strength} meta={T.subseed_strength}
              onChange={v => setP('subseed_strength', v)} />
            <NumRow label="Resize from W" value={xp.seed_resize_from_w} meta={T.seed_resize_from_w}
              onChange={v => setP('seed_resize_from_w', v)} />
            <NumRow label="Resize from H" value={xp.seed_resize_from_h} meta={T.seed_resize_from_h}
              onChange={v => setP('seed_resize_from_h', v)} />
          </div>
        </Section>

        {mode === 'txt2img' && (
          <Section title="Hires fix" hint={xp.enable_hr ? 'on' : 'off'}>
            <label className="sd-check">
              <input type="checkbox" checked={xp.enable_hr} onChange={e => setP('enable_hr', e.target.checked)} />
              Enable hires fix
            </label>
            {xp.enable_hr && <>
              <div className="sd-grid">
                <NumRow label="Upscale by" value={xp.hr_scale} meta={T.hr_scale} onChange={v => setP('hr_scale', v)} />
                <NumRow label="Hires steps" value={xp.hr_second_pass_steps} meta={T.hr_second_pass_steps}
                  onChange={v => setP('hr_second_pass_steps', v)} title="0 = same as base steps" />
                <NumRow label="Resize X" value={xp.hr_resize_x} meta={T.hr_resize_x} onChange={v => setP('hr_resize_x', v)}
                  title="0 = use Upscale by" />
                <NumRow label="Resize Y" value={xp.hr_resize_y} meta={T.hr_resize_y} onChange={v => setP('hr_resize_y', v)} />
                <NumRow label="Hires CFG" value={xp.hr_cfg} meta={T.hr_cfg} onChange={v => setP('hr_cfg', v)} />
                <NumRow label="Hires distilled CFG" value={xp.hr_distilled_cfg} meta={T.hr_distilled_cfg}
                  onChange={v => setP('hr_distilled_cfg', v)} />
              </div>
              <label className="sd-row">Hires denoising <span className="set-val">{denoise.toFixed(2)}</span>
                <input type="range" min="0" max="1" step="0.01" value={denoise}
                  onChange={e => setDenoise(parseFloat(e.target.value))} />
              </label>
              <label className="sd-row">Upscaler
                <select value={xp.hr_upscaler} onChange={e => setP('hr_upscaler', e.target.value)}>
                  <option value="">(default)</option>
                  {hrUpscalers.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <label className="sd-row">Hires checkpoint
                {ckptSelect(xp.hr_checkpoint_name, v => setP('hr_checkpoint_name', v), '(same as base)')}
              </label>
              <div className="sd-grid">
                <label className="sd-row">Hires sampler
                  <select value={xp.hr_sampler_name} onChange={e => setP('hr_sampler_name', e.target.value)}>
                    <option value="">(same)</option>
                    {samplers.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="sd-row">Hires scheduler
                  <select value={xp.hr_scheduler} onChange={e => setP('hr_scheduler', e.target.value)}>
                    <option value="">(same)</option>
                    {lists.schedulers.map(s => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
                  </select>
                </label>
              </div>
              <label className="sd-row">Hires prompt
                <textarea rows={2} value={xp.hr_prompt} placeholder="(same as base prompt)"
                  onChange={e => setP('hr_prompt', e.target.value)} />
              </label>
              <label className="sd-row">Hires negative prompt
                <textarea rows={2} value={xp.hr_negative_prompt} placeholder="(same as base)"
                  onChange={e => setP('hr_negative_prompt', e.target.value)} />
              </label>
            </>}
          </Section>
        )}

        <Section title="Refiner">
          <label className="sd-row">Refiner checkpoint
            {ckptSelect(xp.refiner_checkpoint, v => setP('refiner_checkpoint', v), '(none)')}
          </label>
          {xp.refiner_checkpoint && (
            <NumRow label="Switch at" value={xp.refiner_switch_at} meta={T.refiner_switch_at}
              onChange={v => setP('refiner_switch_at', v)} title="fraction of steps before the refiner takes over" />
          )}
        </Section>

        <Section title="Advanced" hint="sampler internals">
          <label className="sd-check">
            <input type="checkbox" checked={xp.restore_faces} onChange={e => setP('restore_faces', e.target.checked)} />
            Restore faces
          </label>
          <label className="sd-check">
            <input type="checkbox" checked={xp.tiling} onChange={e => setP('tiling', e.target.checked)} />
            Tiling
          </label>
          <div className="sd-grid">
            <NumRow label="Distilled CFG (Flux)" value={xp.distilled_cfg_scale} meta={T.distilled_cfg_scale}
              onChange={v => setP('distilled_cfg_scale', v)} />
            <NumRow label="Eta" value={xp.eta} meta={T.eta} onChange={v => setP('eta', v)} allowNull />
            <NumRow label="s_churn" value={xp.s_churn} meta={T.s_churn} onChange={v => setP('s_churn', v)} allowNull />
            <NumRow label="s_tmin" value={xp.s_tmin} meta={T.s_tmin} onChange={v => setP('s_tmin', v)} allowNull />
            <NumRow label="s_tmax" value={xp.s_tmax} meta={T.s_tmax} onChange={v => setP('s_tmax', v)} allowNull />
            <NumRow label="s_noise" value={xp.s_noise} meta={T.s_noise} onChange={v => setP('s_noise', v)} allowNull />
            <NumRow label="s_min_uncond" value={xp.s_min_uncond} meta={T.s_min_uncond}
              onChange={v => setP('s_min_uncond', v)} allowNull />
          </div>
        </Section>

        <Section title="Overrides" hint="per-generation, auto-restored">
          <label className="sd-row">VAE
            <select value={ovr.sd_vae} onChange={e => setOvr(o => ({ ...o, sd_vae: e.target.value }))}>
              {['Automatic', 'None', ...vaes.map(v => v.name)].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <NumRow label="CLIP skip" value={ovr.CLIP_stop_at_last_layers} meta={OVR.CLIP_stop_at_last_layers}
            onChange={v => setOvr(o => ({ ...o, CLIP_stop_at_last_layers: v }))} />
        </Section>

        <Section title="ADetailer"
          hint={ad.enabled && ad.units.some(u => u.ad_model !== 'None')
            ? ad.units.filter(u => u.ad_model !== 'None')
                .map(u => u.ad_model.replace(/\.pt$/, '') + ', ' + u.ad_denoising_strength).join(' · ')
            : 'off'}>
          <label className="sd-check">
            <input type="checkbox" checked={ad.enabled} onChange={e => toggleAd(e.target.checked)} />
            Detect and refine faces / hands after generation
          </label>
          {ad.enabled && ad.units.map((u, i) => (
            <div key={i} className="sd-ad-unit">
              <label className="sd-row">Unit {i + 1} — detection model
                <select value={u.ad_model} onChange={e => setAdUnit(i, { ad_model: e.target.value })}>
                  <option value="None">(off)</option>
                  {adModels.map(m => <option key={m} value={m}>{m}</option>)}
                  {u.ad_model !== 'None' && !adModels.includes(u.ad_model) &&
                    <option value={u.ad_model}>{u.ad_model}</option>}
                </select>
              </label>
              {u.ad_model !== 'None' && <>
                <label className="sd-row">Prompt
                  <textarea rows={2} value={u.ad_prompt} placeholder="(reuse main prompt)"
                    onChange={e => setAdUnit(i, { ad_prompt: e.target.value })} />
                </label>
                <label className="sd-row">Negative prompt
                  <textarea rows={2} value={u.ad_negative_prompt} placeholder="(reuse main negative)"
                    onChange={e => setAdUnit(i, { ad_negative_prompt: e.target.value })} />
                </label>
                <div className="sd-grid">
                  <NumRow label="Confidence" value={u.ad_confidence} meta={AD.ad_confidence}
                    onChange={v => setAdUnit(i, { ad_confidence: v })}
                    title="minimum detection confidence, 0-1" />
                  <NumRow label="Denoise" value={u.ad_denoising_strength} meta={AD.ad_denoising_strength}
                    onChange={v => setAdUnit(i, { ad_denoising_strength: v })}
                    title="how strongly the detected region is repainted" />
                </div>
              </>}
            </div>
          ))}
        </Section>

        {sourceModes && (
          <Section title={mode === 'inpaint' ? 'Image / inpaint settings' : 'Image settings'}>
            <label className="sd-row">Resize mode
              <select value={xp.resize_mode} onChange={e => setP('resize_mode', Number(e.target.value))}>
                <option value={0}>Just resize</option>
                <option value={1}>Crop and resize</option>
                <option value={2}>Resize and fill</option>
                <option value={3}>Just resize (latent)</option>
              </select>
            </label>
            <div className="sd-grid">
              <NumRow label="Image CFG" value={xp.image_cfg_scale} meta={I2I.image_cfg_scale}
                onChange={v => setP('image_cfg_scale', v)} allowNull />
              <NumRow label="Noise multiplier" value={xp.initial_noise_multiplier} meta={I2I.initial_noise_multiplier}
                onChange={v => setP('initial_noise_multiplier', v)} allowNull />
            </div>
            {mode === 'inpaint' && <>
              <div className="sd-grid">
                <NumRow label="Mask blur" value={xp.mask_blur} meta={I2I.mask_blur} onChange={v => setP('mask_blur', v)} />
                <NumRow label="Masked padding" value={xp.inpaint_full_res_padding} meta={I2I.inpaint_full_res_padding}
                  onChange={v => setP('inpaint_full_res_padding', v)} />
              </div>
              <label className="sd-row">Masked content
                <select value={xp.inpainting_fill} onChange={e => setP('inpainting_fill', Number(e.target.value))}>
                  <option value={0}>Fill</option>
                  <option value={1}>Original</option>
                  <option value={2}>Latent noise</option>
                  <option value={3}>Latent nothing</option>
                </select>
              </label>
              <label className="sd-row">Inpaint area
                <select value={xp.inpaint_full_res ? 1 : 0} onChange={e => setP('inpaint_full_res', e.target.value === '1')}>
                  <option value={0}>Whole picture</option>
                  <option value={1}>Only masked</option>
                </select>
              </label>
              <label className="sd-row">Mask mode
                <select value={xp.inpainting_mask_invert} onChange={e => setP('inpainting_mask_invert', Number(e.target.value))}>
                  <option value={0}>Inpaint masked</option>
                  <option value={1}>Inpaint not masked</option>
                </select>
              </label>
            </>}
          </Section>
        )}

        <div className="sd-pnginfo" title="Reads the parameters Forge embeds in its PNGs">
          ⤵ Drop a Forge PNG anywhere on this panel to import its settings
        </div>
      </div>

      {/* action bar pinned outside the scroll — Generate, progress, and errors
          stay visible however deep the parameter list goes */}
      <div className="sd-actions">
        {busy && <ProgressBar progress={progress.progress} eta={progress.eta} />}
        {lastError && <div className="err sd-err">{lastError}</div>}
        {lastSeed != null && !busy && !lastError && <div className="sd-hint">last seed: {lastSeed}</div>}
        <button className={'sd-gen' + (busy ? ' stopping' : '')} disabled={!running}
          onClick={() => busy ? stopJob() : generate()}>
          {busy ? 'Stop' : 'Generate'}
        </button>
      </div>

      <LogPane lines={logLines} open={logOpen} onToggle={setLogOpen} />
      </>)}
    </aside>
  );
}

// brush-size wrapper so SdMaskCanvas itself stays dumb
const SdMaskCanvasWithBrush = React.forwardRef(function SdMaskCanvasWithBrush(props, ref) {
  const [brush, setBrush] = useState(32);
  return (
    <div>
      <label className="sd-row">Brush size <span className="set-val">{brush}</span>
        <input type="range" min="4" max="128" value={brush} onChange={e => setBrush(parseInt(e.target.value))} />
      </label>
      <SdMaskCanvas {...props} brush={brush} ref={ref} />
    </div>
  );
});
