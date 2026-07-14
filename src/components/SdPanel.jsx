import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../api.js';
import { reconcileCheckpoints, loraTag, snapDim } from '../sd-utils.js';
import SdMaskCanvas from './SdMaskCanvas.jsx';

const MODES = [
  { id: 'txt2img', label: 'Text' },
  { id: 'img2img', label: 'Image' },
  { id: 'inpaint', label: 'Inpaint' }
];
// keep huge photos from turning the mask buffer into tens of MB
const MASK_MAX = 1536;

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

export default function SdPanel({ open, onToast, onImage, convoImages }) {
  const [status, setStatus] = useState('stopped');
  const [statusMsg, setStatusMsg] = useState('');
  const [url, setUrl] = useState('');
  const [managed, setManaged] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [logOpen, setLogOpen] = useState(false);

  const [mode, setMode] = useState('txt2img');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [steps, setSteps] = useState(25);
  const [cfg, setCfg] = useState(7);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [sampler, setSampler] = useState('Euler a');
  const [seed, setSeed] = useState(-1);
  const [denoise, setDenoise] = useState(0.5);

  const [samplers, setSamplers] = useState([]);
  const [checkpoints, setCheckpoints] = useState([]);
  const [currentCkpt, setCurrentCkpt] = useState('');
  const [ckptLoading, setCkptLoading] = useState(false);
  const [loras, setLoras] = useState([]);
  const [loraWeight, setLoraWeight] = useState(0.8);
  const [lorasOpen, setLorasOpen] = useState(false);

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
      const [disk, loraR] = await Promise.all([api.sd.scanCheckpoints(), api.sd.scanLoras()]);
      const diskList = disk && disk.ok ? disk.list : [];
      if (loraR && loraR.ok) setLoras(loraR.list);
      if (r && r.ok && r.status === 'running') {
        const [mR, sR, oR] = await Promise.all([api.sd.models(), api.sd.samplers(), api.sd.getOptions()]);
        setCheckpoints(reconcileCheckpoints(diskList, mR && mR.ok ? mR.data : []));
        if (sR && sR.ok) setSamplers(sR.data.map(s => s.name));
        if (oR && oR.ok && oR.checkpoint) setCurrentCkpt(oR.checkpoint);
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

  // ---------- checkpoint / lora ----------
  const switchCkpt = async (value) => {
    const entry = checkpoints.find(c => c.value === value);
    if (!entry) return;
    if (!entry.title || status !== 'running') { onToast('Start Forge to switch checkpoints', 'warn'); return; }
    setCurrentCkpt(value); setCkptLoading(true);
    const r = await api.sd.setModel(entry.title);
    setCkptLoading(false);
    if (!r.ok) { onToast('Checkpoint switch failed: ' + (r.error || 'unknown'), 'warn'); refresh(); }
  };
  const insertLora = (name) => setPrompt(p => (p ? p.trimEnd() + ' ' : '') + loraTag(name, loraWeight));

  // ---------- source image (img2img / inpaint) ----------
  const setSource = (b64, mime, label) => {
    const img = new Image();
    img.onload = () => setSrcImage({ b64, mime, label, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => onToast('Could not read that image', 'warn');
    img.src = `data:${mime};base64,${b64}`;
    setShowPicker(false);
  };
  const pickConvoImage = async (ci) => {
    if (ci.b64) { setSource(ci.b64, ci.mime || 'image/png', ci.label); return; }
    const r = await api.sd.readImage(ci.path);
    if (r.ok) setSource(r.b64, r.mime, ci.label);
    else onToast('Could not load image: ' + (r.error || 'unknown'), 'warn');
  };
  const onDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const f = files.find(f => f.type && f.type.startsWith('image/'));
    if (!f) return;
    const p = api.getPathForFile(f);
    if (p) {
      const r = await api.readFiles([p]);
      const a = r.ok && r.files.find(x => x.kind === 'image');
      if (a) { setSource(a.data, a.mime, a.name); return; }
    }
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const b64 = s.includes(',') ? s.slice(s.indexOf(',') + 1) : '';
      if (b64) setSource(b64, f.type, f.name);
    };
    reader.readAsDataURL(f);
  };
  const onPaste = (e) => {
    if (mode === 'txt2img') return;
    const item = Array.from((e.clipboardData || {}).items || []).find(i => i.type && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault(); e.stopPropagation();   // keep it out of the chat attach bar
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

  // when a source lands, default output size to (snapped) source size
  useEffect(() => {
    if (srcImage) { setWidth(snapDim(srcImage.w)); setHeight(snapDim(srcImage.h)); }
  }, [srcImage]);

  // ---------- generate / stop ----------
  const generate = async () => {
    const p = prompt.trim();
    if (!p) { onToast('Type a prompt first', 'warn'); return; }
    if (mode !== 'txt2img' && !srcImage) { onToast('Choose a source image first', 'warn'); return; }
    let maskData = null;
    if (mode === 'inpaint') {
      maskData = maskRef.current && maskRef.current.getMask();
      if (!maskData) { onToast('Paint a mask first — white areas get repainted', 'warn'); return; }
    }
    setBusy(true); setLastError(''); setProgress({ progress: 0, eta: 0 });
    const base = { prompt: p, negative, steps, cfg, width, height, sampler, seed };
    try {
      const r = mode === 'txt2img'
        ? await api.sd.txt2img(base)
        : await api.sd.img2img({
            ...base, initB64: srcImage.b64, denoise,
            // srcW/srcH: main rescales the (resolution-capped) mask to the
            // source image's exact dimensions before encoding
            ...(maskData ? { maskData, srcW: srcImage.w, srcH: srcImage.h } : {})
          });
      if (!r.ok) {
        if (r.offline) { setStatus('stopped'); setStatusMsg(r.error); }
        else setLastError(r.error || 'generation failed');
        return;
      }
      setLastSeed(r.seed);
      for (const f of r.files) onImage({ path: f.path, name: f.name, prompt: p, seed: r.seed, mode });
    } catch (err) {
      setLastError(String(err && err.message || err).slice(0, 300));
    } finally {
      setBusy(false);
      setProgress({ progress: 0, eta: 0 });
    }
  };
  const stopJob = () => api.sd.interrupt();

  // ---------- render ----------
  const running = status === 'running';
  const sourceModes = mode !== 'txt2img';
  const maskDims = srcImage ? (() => {
    const s = Math.min(1, MASK_MAX / Math.max(srcImage.w, srcImage.h));
    return { w: Math.max(1, Math.round(srcImage.w * s)), h: Math.max(1, Math.round(srcImage.h * s)) };
  })() : null;

  return (
    <aside className={'sd-panel' + (open ? ' open' : '')} onPaste={onPaste}>
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

        <div className="sd-grid">
          <label className="sd-row">Steps <span className="set-val">{steps}</span>
            <input type="range" min="1" max="80" value={steps} onChange={e => setSteps(parseInt(e.target.value))} />
          </label>
          <label className="sd-row">CFG <span className="set-val">{cfg}</span>
            <input type="range" min="1" max="20" step="0.5" value={cfg} onChange={e => setCfg(parseFloat(e.target.value))} />
          </label>
          <label className="sd-row">Width
            <input type="number" step="64" min="64" max="2048" value={width}
              onChange={e => setWidth(parseInt(e.target.value) || 1024)} onBlur={e => setWidth(snapDim(e.target.value))} />
          </label>
          <label className="sd-row">Height
            <input type="number" step="64" min="64" max="2048" value={height}
              onChange={e => setHeight(parseInt(e.target.value) || 1024)} onBlur={e => setHeight(snapDim(e.target.value))} />
          </label>
          <label className="sd-row">Sampler
            <select value={sampler} onChange={e => setSampler(e.target.value)}>
              {(samplers.length ? samplers : [sampler]).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="sd-row">Seed
            <input type="number" value={seed} onChange={e => setSeed(parseInt(e.target.value) || 0)}
              title="-1 = random" />
          </label>
        </div>

        {sourceModes && (
          <label className="sd-row">Denoising strength <span className="set-val">{denoise.toFixed(2)}</span>
            <input type="range" min="0" max="1" step="0.05" value={denoise}
              onChange={e => setDenoise(parseFloat(e.target.value))} />
          </label>
        )}

        <label className="sd-row">Checkpoint {ckptLoading && <span className="dots sd-hint">loading</span>}
          <select value={currentCkpt} onChange={e => switchCkpt(e.target.value)} disabled={ckptLoading}>
            {!checkpoints.length && <option value="">(no checkpoints found)</option>}
            {checkpoints.length > 0 && !checkpoints.some(c => c.value === currentCkpt) &&
              <option value="">{running ? '(select…)' : '(start Forge to switch)'}</option>}
            {checkpoints.map(c => (
              <option key={c.value} value={c.value}>{c.label}{c.title ? '' : ' (on disk)'}</option>
            ))}
          </select>
        </label>

        <details className="sd-loras" open={lorasOpen} onToggle={e => setLorasOpen(e.currentTarget.open)}>
          <summary>LoRAs ({loras.length})</summary>
          {!loras.length
            ? <div className="sd-hint" style={{ padding: '4px 0' }}>none found in models\Lora</div>
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

        {busy && <ProgressBar progress={progress.progress} eta={progress.eta} />}
        {lastError && <div className="err sd-err">{lastError}</div>}
        {lastSeed != null && !busy && !lastError && <div className="sd-hint">last seed: {lastSeed}</div>}

        <button className={'sd-gen' + (busy ? ' stopping' : '')} disabled={!running}
          onClick={() => busy ? stopJob() : generate()}>
          {busy ? 'Stop' : 'Generate'}
        </button>
      </div>

      <LogPane lines={logLines} open={logOpen} onToggle={setLogOpen} />
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
