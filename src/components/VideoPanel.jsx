import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import api from '../api.js';

// ComfyUI side of the generation panel — serves BOTH media. Controls are
// rendered DYNAMICALLY from the selected workflow's manifest — adding a model
// is a data drop in workflows/, never a code change here.
//
// media='video': owns its workflow dropdown (manifests with media 'video').
// media='image': the parent (SdPanel) owns model selection via the unified
// image list and pins one workflow through the `workflow` prop.
//
// Manifest control vocabulary: text, textarea, select (static `options` or
// live "options_from": "object_info:<NodeType>:<input>"), checkbox, readonly
// (rendered locked, always patched to its default), number/int/float, seed.
// `group` buckets controls into collapsible sections (Basic stays inline,
// matching the Forge panel's conventions); `targets` maps one control onto
// several node inputs.

function defaultsFor(wf) {
  const v = {};
  for (const [key, ctl] of Object.entries(wf.controls || {})) {
    if (ctl.type === 'text' || ctl.type === 'textarea') v[key] = '';
    else if (ctl.type === 'seed') v[key] = -1;
    else if (ctl.type === 'checkbox') v[key] = ctl.default != null ? !!ctl.default : false;
    else if (ctl.type === 'select' || ctl.type === 'readonly') v[key] = ctl.default != null ? ctl.default : '';
    else v[key] = ctl.default != null ? ctl.default : (ctl.min != null ? ctl.min : 0);
  }
  return v;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const labelFor = (name, ctl) => ctl.label
  || (name === 'prompt' ? 'Prompt' : name === 'negative' ? 'Negative prompt'
    : name === 'cfg' ? 'CFG' : cap(name));

// textarea for explicit textareas and the legacy manifests that typed their
// prompt boxes as plain 'text'
const isTextArea = (name, ctl) =>
  ctl.type === 'textarea' || (ctl.type === 'text' && (name === 'prompt' || name === 'negative'));

function ControlRow({ name, ctl, value, options, onChange }) {
  const label = labelFor(name, ctl);
  if (isTextArea(name, ctl)) {
    return (
      <label className="sd-row" title={ctl.tooltip}>{label}
        <textarea rows={name === 'prompt' ? 3 : 2} value={value}
          placeholder={name === 'prompt' ? 'what to generate…' : '(optional)'}
          onChange={e => onChange(e.target.value)} />
      </label>
    );
  }
  if (ctl.type === 'text') {
    return (
      <label className="sd-row" title={ctl.tooltip}>{label}
        <input type="text" value={value} onChange={e => onChange(e.target.value)} />
      </label>
    );
  }
  if (ctl.type === 'checkbox') {
    return (
      <label className="sd-check" title={ctl.tooltip}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (ctl.type === 'readonly') {
    return (
      <label className="sd-row" title={ctl.tooltip || 'fixed by this workflow'}>{label} 🔒
        <input type="text" value={String(value)} readOnly disabled />
      </label>
    );
  }
  if (ctl.type === 'select') {
    // live options (options_from) or the manifest's static list; the current
    // value always stays selectable even before/without a fetch
    const opts = (options && options.length ? options : (ctl.options || [])).slice();
    if (value !== '' && value != null && !opts.includes(value)) opts.unshift(value);
    return (
      <label className="sd-row" title={ctl.tooltip}>{label}
        <select value={value} onChange={e => onChange(e.target.value)}>
          {!opts.length && <option value="">(start ComfyUI to list options)</option>}
          {opts.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="sd-row" title={name === 'seed' ? '-1 = random' : ctl.tooltip}>{label}
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

// one group's controls: full-width rows first, the numeric/select grid after
function ControlGroup({ controls, values, options, setValue }) {
  const wide = controls.filter(([n, c]) => isTextArea(n, c) || c.type === 'text' || c.type === 'checkbox');
  const grid = controls.filter(([n, c]) => !wide.some(([wn]) => wn === n));
  return (
    <>
      {wide.map(([name, ctl]) => (
        <ControlRow key={name} name={name} ctl={ctl} options={options[name]}
          value={values[name] != null ? values[name] : ''}
          onChange={(v) => setValue(name, v)} />
      ))}
      <div className="sd-grid">
        {grid.map(([name, ctl]) => (
          <ControlRow key={name} name={name} ctl={ctl} options={options[name]}
            value={values[name] != null ? values[name] : ''}
            onChange={(v) => setValue(name, v)} />
        ))}
      </div>
    </>
  );
}

export default function ComfyBody({ media = 'video', workflow: pinnedWf, onToast, onImage, onVideo, controlRef, onBusyChange }) {
  const [status, setStatus] = useState('stopped');
  const [statusMsg, setStatusMsg] = useState('');
  const [url, setUrl] = useState('');
  const [managed, setManaged] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [logOpen, setLogOpen] = useState(false);

  const [workflows, setWorkflows] = useState([]);      // ALL workflows, both media
  const [ownWfName, setOwnWfName] = useState('');      // video mode's own selection
  const [values, setValues] = useState({});
  const [options, setOptions] = useState({});          // control -> resolved options_from list

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);   // { phase, value, max, elapsed }
  const [lastError, setLastError] = useState('');
  const [lastSeed, setLastSeed] = useState(null);

  const statusRef = useRef(status); statusRef.current = status;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => { onBusyChange && onBusyChange(busy); }, [busy, onBusyChange]);

  const mine = useMemo(() => workflows.filter(w => (w.media || 'video') === media), [workflows, media]);
  const wfName = media === 'image' ? (pinnedWf || '') : ownWfName;
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
        if (media !== 'image') {
          const list = w.list.filter(x => (x.media || 'video') === media);
          setOwnWfName(prev => prev && list.some(x => x.name === prev) ? prev
            : (list[0] ? list[0].name : ''));
        }
      }
    } catch (err) { setStatus('stopped'); setStatusMsg(String(err && err.message || err)); }
  }, [media]);

  useEffect(() => { refresh(); }, [refresh]);

  // when the workflow changes, (re)seed the control values from its manifest
  useEffect(() => {
    if (wf) setValues(prev => ({ ...defaultsFor(wf), ...(prev.__wf === wf.name ? prev : {}), __wf: wf.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfName, workflows.length]);

  // resolve "options_from": "object_info:<NodeType>:<input>" dropdowns once
  // the server is up — samplers/schedulers/model lists are never hardcoded
  useEffect(() => {
    if (!wf || status !== 'running') return;
    let alive = true;
    for (const [name, ctl] of Object.entries(wf.controls || {})) {
      const m = typeof ctl.options_from === 'string' && ctl.options_from.match(/^object_info:([^:]+):(.+)$/);
      if (!m) continue;
      api.comfy.objectInfo(m[1], m[2]).then(r => {
        if (alive && r && r.ok && r.options.length) setOptions(prev => ({ ...prev, [name]: r.options }));
      });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfName, status, workflows.length]);

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
      // the result's media decides the message kind; the backend rides along
      // in genParams so Regenerate replays against ComfyUI, never Forge
      const outMedia = r.media
        || ((workflows.find(w => w.name === workflow) || {}).media || 'video');
      const deliver = outMedia === 'image' ? onImage : onVideo;
      const genParams = {
        workflow, backend: 'comfy', mode: outMedia,
        values: { ...vals, ...(r.seed != null ? { seed: r.seed } : {}) }
      };
      for (const f of r.files) deliver({
        path: f.path, name: f.name, prompt: promptText, seed: r.seed, elapsed: r.elapsed, genParams
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

  // chat-side actions (Regenerate / Reuse) for ComfyUI-produced messages of
  // EITHER media — merged onto the shared control surface; SdPanel merges its
  // Forge keys onto the same object
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      ...(controlRef.current || {}),
      comfyRegenerate: (gp, opts = {}) => {
        if (!gp || !gp.workflow) { onToast('This result has no stored settings to replay', 'warn'); return; }
        if (statusRef.current !== 'running') { onToast('Start ComfyUI first, then regenerate', 'warn'); return; }
        if (busyRef.current) { onToast('A generation is already running', 'warn'); return; }
        if (!workflows.some(w => w.name === gp.workflow)) {
          onToast(`Workflow "${gp.workflow}" is no longer in workflows/`, 'warn'); return;
        }
        const vals = { ...gp.values };
        if ('seed' in vals && !opts.keepSeed) vals.seed = -1;
        runGeneration(gp.workflow, vals, String(vals.prompt || gp.workflow));
      },
      comfyLoadSettings: (gp) => {
        if (!gp || !gp.workflow) { onToast('This result has no stored settings', 'warn'); return; }
        // image-media workflows are pinned by the parent (showTarget already
        // switched the unified list); the video dropdown is ours to move
        if (media !== 'image' && workflows.some(w => w.name === gp.workflow)) setOwnWfName(gp.workflow);
        setValues({ ...gp.values, __wf: gp.workflow });
        onToast('Settings loaded into the panel');
      }
    };
    // on unmount (media switched away) drop the stale closures so callers
    // wait for a fresh mount instead of driving a dead component
    return () => {
      if (controlRef.current) {
        delete controlRef.current.comfyRegenerate;
        delete controlRef.current.comfyLoadSettings;
      }
    };
  });

  const running = status === 'running';
  const pct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : null;

  // group controls: Basic / ungrouped stays inline, named groups collapse —
  // same convention as the Forge panel's sections; order = first appearance
  const grouped = useMemo(() => {
    const out = [];   // [{ title: string|null, controls: [[name, ctl]] }]
    for (const [name, ctl] of (wf ? Object.entries(wf.controls) : [])) {
      const title = ctl.group && ctl.group !== 'Basic' ? ctl.group : null;
      let g = out.find(x => x.title === title);
      if (!g) out.push(g = { title, controls: [] });
      g.controls.push([name, ctl]);
    }
    return out.sort((a, b) => (a.title === null ? -1 : b.title === null ? 1 : 0));
  }, [wf]);

  const setValue = (name, v) => setValues(prev => ({ ...prev, [name]: v }));

  return (
    <>
      <div className="sd-head">
        <h3>{media === 'image' ? 'Image · ComfyUI' : 'Video · ComfyUI'}</h3>
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
        {media !== 'image' && (
          <label className="sd-row">Workflow
            <select value={ownWfName} onChange={e => setOwnWfName(e.target.value)}>
              {!mine.length && <option value="">(no workflows found in workflows\)</option>}
              {mine.map(w => <option key={w.name} value={w.name}>{w.label}</option>)}
            </select>
          </label>
        )}

        {grouped.map(g => g.title === null ? (
          <ControlGroup key="__basic" controls={g.controls} values={values} options={options} setValue={setValue} />
        ) : (
          <details key={g.title} className="sd-sec">
            <summary>{g.title}</summary>
            <ControlGroup controls={g.controls} values={values} options={options} setValue={setValue} />
          </details>
        ))}
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
