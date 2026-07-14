import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../api.js';

// Video (ComfyUI) side of the generation panel. Controls are rendered
// DYNAMICALLY from the selected workflow's manifest — adding a model is a
// data drop in workflows/, never a code change here.

function defaultsFor(wf) {
  const v = {};
  for (const [key, ctl] of Object.entries(wf.controls || {})) {
    if (ctl.type === 'text') v[key] = '';
    else if (ctl.type === 'seed') v[key] = -1;
    else v[key] = ctl.default != null ? ctl.default : (ctl.min != null ? ctl.min : 0);
  }
  return v;
}

function ControlRow({ name, ctl, value, onChange }) {
  if (ctl.type === 'text') {
    const label = name === 'prompt' ? 'Prompt' : name === 'negative' ? 'Negative prompt'
      : name.charAt(0).toUpperCase() + name.slice(1);
    return (
      <label className="sd-row">{label}
        <textarea rows={name === 'prompt' ? 3 : 2} value={value}
          placeholder={name === 'prompt' ? 'what to generate…' : '(optional)'}
          onChange={e => onChange(e.target.value)} />
      </label>
    );
  }
  const label = name === 'seed' ? 'Seed' : name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <label className="sd-row" title={name === 'seed' ? '-1 = random' : undefined}>{label}
      <input type="number" min={ctl.min} max={ctl.max} step={ctl.step} value={value}
        onChange={e => {
          const n = Number(e.target.value);
          onChange(e.target.value === '' || !Number.isFinite(n)
            ? (ctl.type === 'seed' ? -1 : (ctl.default != null ? ctl.default : ctl.min || 0))
            : n);
        }} />
    </label>
  );
}

export default function VideoBody({ onToast, onVideo, controlRef, onBusyChange }) {
  const [status, setStatus] = useState('stopped');
  const [statusMsg, setStatusMsg] = useState('');
  const [url, setUrl] = useState('');
  const [managed, setManaged] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [logOpen, setLogOpen] = useState(false);

  const [workflows, setWorkflows] = useState([]);
  const [wfName, setWfName] = useState('');
  const [values, setValues] = useState({});

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);   // { phase, value, max, elapsed }
  const [lastError, setLastError] = useState('');
  const [lastSeed, setLastSeed] = useState(null);

  const statusRef = useRef(status); statusRef.current = status;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => { onBusyChange && onBusyChange(busy); }, [busy, onBusyChange]);

  const wf = workflows.find(w => w.name === wfName) || null;

  const pushLog = useCallback((line) => setLogLines(prev => [...prev.slice(-499), line]), []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.comfy.status();
      if (r && r.ok) {
        setStatus(r.status); setUrl(r.url); setManaged(!!r.managed);
        if (r.log && r.log.length) setLogLines(r.log);
      }
      const w = await api.comfy.workflows();
      if (w && w.ok) {
        setWorkflows(w.list);
        setWfName(prev => prev && w.list.some(x => x.name === prev) ? prev
          : (w.list[0] ? w.list[0].name : ''));
      }
    } catch (err) { setStatus('stopped'); setStatusMsg(String(err && err.message || err)); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // when the workflow changes, (re)seed the control values from its manifest
  useEffect(() => {
    if (wf) setValues(prev => ({ ...defaultsFor(wf), ...(prev.__wf === wf.name ? prev : {}), __wf: wf.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfName, workflows.length]);

  useEffect(() => {
    const offP = api.comfy.onProgress((d) => setProgress(d.done ? null : d));
    const offL = api.comfy.onLog((d) => pushLog(d.line));
    const offS = api.comfy.onStatus((d) => {
      setStatus(d.status); setManaged(!!d.managed); setStatusMsg(d.message || '');
    });
    return () => { offP(); offL(); offS(); };
  }, [pushLog]);

  const startComfy = async () => {
    setLogOpen(true);
    const r = await api.comfy.start();
    if (!r.ok) onToast('Could not start ComfyUI: ' + (r.error || 'unknown'), 'warn');
    else setStatus(r.status);
  };
  const stopComfy = async () => {
    const r = await api.comfy.stop();
    if (!r.ok) onToast(r.error || 'Could not stop ComfyUI', 'warn');
  };

  const runGeneration = async (workflow, vals, promptText) => {
    setBusy(true); setLastError(''); setProgress(null);
    try {
      const r = await api.comfy.generate({ workflow, values: vals });
      if (!r.ok) {
        if (r.offline) { setStatus('stopped'); setStatusMsg(r.error); }
        else setLastError(r.error || 'generation failed');
        return;
      }
      setLastSeed(r.seed);
      for (const f of r.files) onVideo({
        path: f.path, name: f.name, prompt: promptText, seed: r.seed, elapsed: r.elapsed,
        genParams: { workflow, values: { ...vals, ...(r.seed != null ? { seed: r.seed } : {}) }, mode: 'video' }
      });
    } catch (err) {
      setLastError(String(err && err.message || err).slice(0, 300));
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  const generate = () => {
    if (!wf) { onToast('Pick a workflow first', 'warn'); return; }
    const { __wf, ...vals } = values;
    if (wf.controls.prompt && !String(vals.prompt || '').trim()) { onToast('Type a prompt first', 'warn'); return; }
    runGeneration(wf.name, vals, String(vals.prompt || wf.label));
  };
  const stopJob = () => api.comfy.interrupt();

  // chat-side video actions (Regenerate / Reuse) — merged onto the shared
  // control surface; SdPanel merges its image keys onto the same object
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      ...(controlRef.current || {}),
      regenerateVideo: (gp, opts = {}) => {
        if (!gp || !gp.workflow) { onToast('This video has no stored settings to replay', 'warn'); return; }
        if (statusRef.current !== 'running') { onToast('Start ComfyUI first, then regenerate', 'warn'); return; }
        if (busyRef.current) { onToast('A generation is already running', 'warn'); return; }
        if (!workflows.some(w => w.name === gp.workflow)) {
          onToast(`Workflow "${gp.workflow}" is no longer in workflows/`, 'warn'); return;
        }
        const vals = { ...gp.values };
        if ('seed' in vals && !opts.keepSeed) vals.seed = -1;
        runGeneration(gp.workflow, vals, String(vals.prompt || gp.workflow));
      },
      loadVideoSettings: (gp) => {
        if (!gp || !gp.workflow) { onToast('This video has no stored settings', 'warn'); return; }
        if (workflows.some(w => w.name === gp.workflow)) setWfName(gp.workflow);
        setValues({ ...gp.values, __wf: gp.workflow });
        onToast('Video settings loaded into the panel');
      }
    };
    // on unmount (backend switched away) drop the stale closures so callers
    // wait for a fresh mount instead of driving a dead component
    return () => {
      if (controlRef.current) {
        delete controlRef.current.regenerateVideo;
        delete controlRef.current.loadVideoSettings;
      }
    };
  });

  const running = status === 'running';
  const pct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : null;

  const controls = wf ? Object.entries(wf.controls) : [];
  const textControls = controls.filter(([, c]) => c.type === 'text');
  const numControls = controls.filter(([, c]) => c.type !== 'text');

  return (
    <>
      <div className="sd-head">
        <h3>Video · ComfyUI</h3>
        <span className={'sd-pill ' + status}>
          {status === 'running' ? 'ComfyUI running' : status === 'starting' ? 'Starting ComfyUI…' : 'ComfyUI stopped'}
        </span>
        {running && managed && <button className="ghost sd-mini" onClick={stopComfy}>Stop ComfyUI</button>}
      </div>

      {!running && status !== 'starting' && (
        <div className="sd-offline">
          <div>ComfyUI not running at <code>{url || '…'}</code>{statusMsg ? ` — ${statusMsg}` : ''}</div>
          <div className="sd-hint" style={{ marginTop: 4 }}>One GPU: starting ComfyUI stops Forge.</div>
          <div className="sd-offline-actions">
            <button className="ghost" onClick={refresh}>Retry</button>
            <button onClick={startComfy}>Start</button>
          </div>
        </div>
      )}
      {status === 'starting' && (
        <div className="sd-offline"><div><span className="dots">Starting ComfyUI</span> — first boot can take a minute, log below.</div></div>
      )}

      <div className="sd-body">
        <label className="sd-row">Workflow
          <select value={wfName} onChange={e => setWfName(e.target.value)}>
            {!workflows.length && <option value="">(no workflows found in workflows\)</option>}
            {workflows.map(w => <option key={w.name} value={w.name}>{w.label}</option>)}
          </select>
        </label>

        {textControls.map(([name, ctl]) => (
          <ControlRow key={name} name={name} ctl={ctl} value={values[name] != null ? values[name] : ''}
            onChange={(v) => setValues(prev => ({ ...prev, [name]: v }))} />
        ))}
        <div className="sd-grid">
          {numControls.map(([name, ctl]) => (
            <ControlRow key={name} name={name} ctl={ctl} value={values[name] != null ? values[name] : ''}
              onChange={(v) => setValues(prev => ({ ...prev, [name]: v }))} />
          ))}
        </div>
        {!wf && <div className="sd-hint">Drop a &lt;name&gt;.json + &lt;name&gt;.manifest.json pair into workflows\ to add a model.</div>}
      </div>

      <div className="sd-actions">
        {busy && progress && (
          <div className="vid-progress">
            <div className="vid-progress-meta">
              <span>{progress.phase || 'queued'}</span>
              <span>{pct != null ? pct + '%' : ''} · {Math.round(progress.elapsed || 0)}s</span>
            </div>
            <div className="sd-progress"><div className="sd-progress-fill" style={{ width: (pct != null ? pct : 4) + '%' }} /></div>
          </div>
        )}
        {busy && !progress && <div className="sd-hint">queued…</div>}
        {lastError && <div className="err sd-err">{lastError}</div>}
        {lastSeed != null && !busy && !lastError && <div className="sd-hint">last seed: {lastSeed}</div>}
        <button className={'sd-gen' + (busy ? ' stopping' : '')} disabled={!running}
          onClick={() => busy ? stopJob() : generate()}>
          {busy ? 'Stop' : 'Generate'}
        </button>
      </div>

      <details className="sd-log" open={logOpen} onToggle={e => setLogOpen(e.currentTarget.open)}>
        <summary>ComfyUI log</summary>
        <pre>{logLines.length ? logLines.join('\n') : '(no output yet)'}</pre>
      </details>
    </>
  );
}
