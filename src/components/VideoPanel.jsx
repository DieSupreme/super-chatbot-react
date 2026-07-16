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

// the LoadImage select doubles as an upload target: a picker button and
// drag-drop both POST to ComfyUI's /upload/image and select the result
const isImageInput = (ctl) =>
  ctl.type === 'select' && ctl.options_from === 'object_info:LoadImage:image';

function ControlRow({ name, ctl, value, options, onChange, upload }) {
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
    const uploadable = upload && isImageInput(ctl);
    return (
      <label className="sd-row" title={ctl.tooltip}
        onDragOver={uploadable ? (e) => e.preventDefault() : undefined}
        onDrop={uploadable ? (e) => {
          e.preventDefault(); e.stopPropagation();   // keep it away from PNG-info import / chat attach
          const f = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
            .find(x => (x.type && x.type.startsWith('image/')) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(x.name || ''));
          const p = f && api.getPathForFile(f);
          if (p) upload(name, p);
        } : undefined}>{label}
        <span style={{ display: 'flex', gap: 6 }}>
          <select style={{ flex: 1, minWidth: 0 }} value={value} onChange={e => onChange(e.target.value)}>
            {!opts.length && <option value="">(start ComfyUI to list options)</option>}
            {opts.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          {uploadable && (
            <button type="button" className="ghost sd-mini"
              title="Upload an image to ComfyUI input (or drop one on this row)"
              onClick={() => upload(name, null)}>📂</button>
          )}
        </span>
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
function ControlGroup({ controls, values, options, setValue, upload }) {
  const wide = controls.filter(([n, c]) => isTextArea(n, c) || c.type === 'text' || c.type === 'checkbox');
  const grid = controls.filter(([n, c]) => !wide.some(([wn]) => wn === n));
  return (
    <>
      {wide.map(([name, ctl]) => (
        <ControlRow key={name} name={name} ctl={ctl} options={options[name]} upload={upload}
          value={values[name] != null ? values[name] : ''}
          onChange={(v) => setValue(name, v)} />
      ))}
      <div className="sd-grid">
        {grid.map(([name, ctl]) => (
          <ControlRow key={name} name={name} ctl={ctl} options={options[name]} upload={upload}
            value={values[name] != null ? values[name] : ''}
            onChange={(v) => setValue(name, v)} />
        ))}
      </div>
    </>
  );
}

// ---- saved prompts ----
// Capture the prompt-ish text controls (plus a FIXED seed) into a named
// per-workflow preset stored in workflows/prompt-presets.json. Picking one
// populates the fields — it never locks them, the user keeps editing before
// generating. Naming follows the conversation-rename pattern: inline input,
// Enter commits, Escape cancels, blur commits.
const promptKeysFor = (wf) => Object.entries((wf && wf.controls) || {})
  .filter(([, c]) => (c.type === 'textarea' || c.type === 'text') &&
    (!c.group || c.group === 'Basic' || c.group === 'Prompt'))
  .map(([k]) => k);

function PresetBar({ wf, values, setValues, onToast }) {
  const [presets, setPresets] = useState([]);
  const [selected, setSelected] = useState('');
  const [naming, setNaming] = useState(null);   // null | 'save' | 'rename'
  const [name, setName] = useState('');
  const inpRef = useRef(null);
  const doneRef = useRef(false);                // Enter fires blur too — commit once

  useEffect(() => {
    let alive = true;
    setSelected(''); setNaming(null); setPresets([]);
    if (wf) api.comfy.presets(wf.name).then(r => { if (alive && r && r.ok) setPresets(r.presets || []); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf && wf.name]);
  useEffect(() => {
    if (naming && inpRef.current) { inpRef.current.focus(); inpRef.current.select(); }
  }, [naming]);

  const keys = promptKeysFor(wf);
  if (!wf || !keys.length) return null;

  const apply = (nm) => {
    setSelected(nm);
    const p = presets.find(x => x.name === nm);
    if (p) setValues(prev => ({ ...prev, ...p.values }));
  };
  const capture = () => {
    const out = {};
    for (const k of keys) out[k] = values[k] != null ? values[k] : '';
    // seed rides along only when FIXED — a randomizing (-1) seed is noise
    if (wf.controls.seed && Number(values.seed) >= 0) out.seed = Number(values.seed);
    return out;
  };
  const startNaming = (mode) => {
    doneRef.current = false;
    setName(mode === 'rename' ? selected : '');
    setNaming(mode);
  };
  const commit = async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const mode = naming;
    const nm = name.trim();
    setNaming(null);
    if (!nm || (mode === 'rename' && nm === selected)) return;
    const r = mode === 'rename'
      ? await api.comfy.presetRename({ workflow: wf.name, oldName: selected, newName: nm })
      : await api.comfy.presetSave({ workflow: wf.name, name: nm, values: capture() });
    if (!r || !r.ok) { onToast((r && r.error) || 'could not save preset', 'warn'); return; }
    setPresets(r.presets || []);
    setSelected(nm);
    onToast(mode === 'rename' ? 'Preset renamed' : `Prompts saved as "${nm}"`);
  };
  const del = async () => {
    if (!selected) return;
    const r = await api.comfy.presetDelete({ workflow: wf.name, name: selected });
    if (!r || !r.ok) { onToast((r && r.error) || 'could not delete preset', 'warn'); return; }
    setPresets(r.presets || []);
    setSelected('');
  };

  return (
    <div className="sd-row">Prompts
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {naming ? (
          <input type="text" placeholder="preset name…" value={name} ref={inpRef}
            style={{ flex: 1 }}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { doneRef.current = true; setNaming(null); }
            }}
            onBlur={commit} />
        ) : (
          <>
            <select title="Prompt presets" value={selected} style={{ flex: 1 }}
              onChange={e => apply(e.target.value)}>
              <option value="">{presets.length ? '(saved prompts…)' : '(no saved prompts yet)'}</option>
              {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <button type="button" className="ghost sd-mini" title="Save prompts"
              onClick={() => startNaming('save')}>💾 Save</button>
            {selected && <button type="button" className="ghost sd-mini" title="Rename preset"
              onClick={() => startNaming('rename')}>✎</button>}
            {selected && <button type="button" className="ghost sd-mini" title="Delete preset"
              onClick={del}>🗑</button>}
          </>
        )}
      </span>
    </div>
  );
}

// ---- control picker ("Configure controls") ----
// Generated manifests now extract EVERY static widget as a potential control;
// most land hidden. This view lists them all, grouped by node, with a
// shown/hidden checkbox and an editable label per control. Choices persist as
// overrides in workflows/control-overrides.json (applied at read time in
// main), so "Rescan workflow" — a forced re-extraction — never wipes them.
const targetIdOf = (ctl) => {
  const t = ctl.targets ? ctl.targets[0] : ctl;
  return t.node + ':' + t.input;
};

function ControlPicker({ wf, onToast, onChanged, onClose }) {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const [key, ctl] of Object.entries(wf.controls || {})) {
      const t = ctl.targets ? ctl.targets[0] : ctl;
      const inputs = (ctl.targets || [ctl]).map(x => x.input).join(', ');
      if (needle) {
        const hay = [key, ctl.label, inputs, ctl.node_type, ctl.node_title].join(' ').toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const id = (ctl.node_title || ctl.node_type || 'node') + '·' + t.node;
      let g = out.find(x => x.id === id);
      if (!g) out.push(g = {
        id, node: t.node,
        title: ctl.node_title || ctl.node_type || `node ${t.node}`,
        type: ctl.node_type || '',
        rows: []
      });
      g.rows.push([key, ctl, inputs]);
    }
    return out;
  }, [wf, q]);

  const setOverride = async (ctl, patch) => {
    const r = await api.comfy.setControlOverride({ workflow: wf.name, id: targetIdOf(ctl), ...patch });
    if (!r || !r.ok) { onToast((r && r.error) || 'could not update the control', 'warn'); return; }
    onChanged(r.list);
  };
  const rescan = async () => {
    const r = await api.comfy.rebuildManifests();
    if (!r || !r.ok) { onToast((r && r.error) || 'rescan failed', 'warn'); return; }
    onChanged(r.list);
    onToast('Workflow rescanned — shown/hidden choices and labels kept');
  };

  return (
    <div className="sd-picker">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <button className="ghost sd-mini" onClick={onClose}>← Back</button>
        <input type="text" placeholder="filter controls…" value={q} style={{ flex: 1 }}
          onChange={e => setQ(e.target.value)} />
        <button className="ghost sd-mini" onClick={rescan} title="Re-run extraction; your choices are kept">
          Rescan workflow
        </button>
      </div>
      {groups.map(g => (
        <details key={g.id} open className="sd-sec">
          <summary>
            {g.title}{g.type && g.type !== g.title ? <span className="sd-hint"> — {g.type}</span> : null}
            <span className="sd-hint"> · node {g.node}</span>
          </summary>
          {g.rows.map(([key, ctl, inputs]) => (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <input type="checkbox" checked={!ctl.hidden}
                  onChange={e => setOverride(ctl, { hidden: !e.target.checked })} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inputs}</span>
              </label>
              <input type="text" title={`Label for ${key}`} placeholder="label…"
                defaultValue={ctl.label || ''} style={{ width: 130 }}
                onBlur={e => {
                  const v = e.target.value.trim();
                  if (v !== (ctl.label || '')) setOverride(ctl, { label: v || null });
                }} />
              <span className="sd-hint" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ctl.default !== undefined ? String(ctl.default) : ''}
              </span>
            </div>
          ))}
        </details>
      ))}
      {!groups.length && <div className="sd-hint">no controls match</div>}
    </div>
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

  const [configOpen, setConfigOpen] = useState(false);   // the Configure-controls view
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);   // { phase, value, max, elapsed }
  const [preview, setPreview] = useState(null);     // latest binary preview frame { b64, mime }
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

  // when the workflow (or its refreshed manifest) changes, (re)seed control
  // values: manifest defaults < the persisted working draft
  // (workflows/control-values.json) < this session's live edits. Stale draft
  // keys (control gone after a rescan) are dropped silently.
  useEffect(() => {
    if (!wf) return;
    let alive = true;
    (async () => {
      let stored = {};
      try {
        const r = await api.comfy.values(wf.name);
        if (r && r.ok && r.values) stored = r.values;
      } catch (_) { /* draft unavailable -> plain defaults */ }
      if (!alive) return;
      const draft = {};
      for (const [k, v] of Object.entries(stored)) if (wf.controls && wf.controls[k]) draft[k] = v;
      setValues(prev => ({ ...defaultsFor(wf), ...draft, ...(prev.__wf === wf.name ? prev : {}), __wf: wf.name }));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf]);

  // ---- working-draft persistence ----
  // Every edit lands in workflows/control-values.json ~500ms after the user
  // stops changing things; unmount (tab switch) and window close flush the
  // pending save immediately so nothing typed is ever lost.
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);   // { workflow, values } awaiting the debounce
  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const p = pendingSave.current;
    pendingSave.current = null;
    if (p && api.comfy.valuesSave) {
      try { Promise.resolve(api.comfy.valuesSave(p)).catch(() => {}); } catch (_) {}
    }
  }, []);
  useEffect(() => {
    const { __wf, ...vals } = values;
    if (!__wf) return;
    pendingSave.current = { workflow: __wf, values: vals };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 500);
  }, [values, flushSave]);
  useEffect(() => {
    window.addEventListener('beforeunload', flushSave);
    return () => {
      window.removeEventListener('beforeunload', flushSave);
      flushSave();   // unmount = tab/media switch — the draft must survive it
    };
  }, [flushSave]);

  // deliberate way back to a clean slate — clears the stored draft too
  const resetValues = async () => {
    if (!wf) return;
    const r = await api.comfy.valuesClear(wf.name);
    if (!r || !r.ok) { onToast((r && r.error) || 'could not reset values', 'warn'); return; }
    pendingSave.current = null;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    setValues({ ...defaultsFor(wf), __wf: wf.name });
    onToast('Controls reset to workflow defaults');
  };

  // the picker is per-workflow — close it when the selection moves
  useEffect(() => { setConfigOpen(false); }, [wfName]);

  // resolve "options_from": "object_info:<NodeType>:<input>" dropdowns once
  // the server is up — samplers/schedulers/model lists are never hardcoded.
  // Hidden controls are skipped until opted in (a big workflow can carry
  // dozens of combos).
  useEffect(() => {
    if (!wf || status !== 'running') return;
    let alive = true;
    for (const [name, ctl] of Object.entries(wf.controls || {})) {
      if (ctl.hidden) continue;
      const m = typeof ctl.options_from === 'string' && ctl.options_from.match(/^object_info:([^:]+):(.+)$/);
      if (!m) continue;
      api.comfy.objectInfo(m[1], m[2]).then(r => {
        if (alive && r && r.ok && r.options.length) setOptions(prev => ({ ...prev, [name]: r.options }));
      });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf, status]);

  useEffect(() => {
    const offP = api.comfy.onProgress((d) => {
      setProgress(d.done ? null : d);
      if (d.done) setPreview(null);   // the final output replaces the live frame
    });
    // binary preview frames (if the server's --preview-method produces them);
    // no frames simply means the progress bar stands alone
    const offPrev = api.comfy.onPreview ? api.comfy.onPreview((d) => setPreview(d)) : () => {};
    const offL = api.comfy.onLog((d) => pushLog(d.line));
    const offS = api.comfy.onStatus((d) => {
      setStatus(d.status); setManaged(!!d.managed); setStatusMsg(d.message || '');
    });
    return () => { offP(); offPrev(); offL(); offS(); };
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
      setBusy(false); setProgress(null); setPreview(null);
    }
  };

  const generate = () => {
    if (!wf) { onToast('Pick a workflow first', 'warn'); return; }
    const { __wf, ...vals } = values;
    if (wf.controls.prompt && !String(vals.prompt || '').trim()) { onToast('Type a prompt first', 'warn'); return; }
    runGeneration(wf.name, vals, String(vals.prompt || wf.label));
  };

  // interrupt the running job AND clear anything queued behind it — a
  // deliberate act, hence the confirm
  const cancelJob = async () => {
    if (!window.confirm('Interrupt the running job (and clear any queued jobs)?')) return;
    const r = await api.comfy.cancel();
    if (!r || !r.ok) onToast((r && r.error) || 'Cancel failed', 'warn');
  };

  // release models between image and video runs — one 10GB card
  const freeVram = async () => {
    const r = await api.comfy.free();
    if (r && r.ok) onToast('VRAM freed — models unloaded');
    else onToast((r && r.error) || 'Could not free VRAM', 'warn');
  };

  // POST a local file to /upload/image and point the select at the result;
  // filePath null = open the picker first
  const uploadTo = async (name, filePath) => {
    let p = filePath;
    if (!p) {
      const r = await api.pickFiles();
      const f = r && r.ok && (r.files || []).find(x => x.path &&
        (x.kind === 'image' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(x.name || '')));
      if (!f) return;
      p = f.path;
    }
    const r = await api.comfy.uploadImage(p);
    if (!r || !r.ok) { onToast('Upload failed: ' + ((r && r.error) || 'unknown'), 'warn'); return; }
    setValues(prev => ({ ...prev, [name]: r.name }));
    setOptions(prev => ({ ...prev, [name]: [...new Set([r.name, ...(prev[name] || [])])] }));
    onToast('Uploaded to ComfyUI input: ' + r.name);
  };

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
      },
      // gallery "start image": upload the file to ComfyUI's input folder and
      // point this workflow's LoadImage select at it
      comfyUseStartImage: async (imgPath) => {
        if (statusRef.current !== 'running') { onToast('Start ComfyUI first, then set the start image', 'warn'); return; }
        const entry = Object.entries((wf && wf.controls) || {})
          .find(([, c]) => isImageInput(c) && !c.hidden);
        if (!entry) { onToast('This workflow has no image input', 'warn'); return; }
        await uploadTo(entry[0], imgPath);
      }
    };
    // on unmount (media switched away) drop the stale closures so callers
    // wait for a fresh mount instead of driving a dead component
    return () => {
      if (controlRef.current) {
        delete controlRef.current.comfyRegenerate;
        delete controlRef.current.comfyLoadSettings;
        delete controlRef.current.comfyUseStartImage;
      }
    };
  });

  const running = status === 'running';
  const pct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : null;

  // group controls: Basic / ungrouped stays inline, named groups collapse —
  // same convention as the Forge panel's sections; order = first appearance.
  // Hidden controls (extracted potentials the user has not opted in) never
  // reach the panel — the Configure view is where they live.
  const grouped = useMemo(() => {
    const out = [];   // [{ title: string|null, controls: [[name, ctl]] }]
    for (const [name, ctl] of (wf ? Object.entries(wf.controls) : [])) {
      if (ctl.hidden) continue;
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
        <button className="ghost sd-mini" disabled={!running || busy}
          title={!running ? 'ComfyUI is not running' : busy ? 'Wait for the current job to finish' : 'Unload models and release GPU memory'}
          onClick={freeVram}>Free VRAM</button>
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

        {configOpen && wf ? (
          <ControlPicker wf={wf} onToast={onToast} onClose={() => setConfigOpen(false)}
            onChanged={(list) => setWorkflows(list)} />
        ) : (
          <>
            <PresetBar wf={wf} values={values} setValues={setValues} onToast={onToast} />

            {grouped.map(g => g.title === null ? (
              <ControlGroup key="__basic" controls={g.controls} values={values} options={options} setValue={setValue} upload={uploadTo} />
            ) : (
              <details key={g.title} className="sd-sec">
                <summary>{g.title}</summary>
                <ControlGroup controls={g.controls} values={values} options={options} setValue={setValue} upload={uploadTo} />
              </details>
            ))}
            {wf && (
              <div style={{ display: 'flex', gap: 6 }}>
                {wf.generated && (
                  <button className="ghost sd-mini"
                    onClick={() => setConfigOpen(true)}
                    title="Choose which of the workflow's widgets appear as controls">
                    ⚙ Configure controls
                  </button>
                )}
                <button className="ghost sd-mini" onClick={resetValues}
                  title="Clear this workflow's saved draft and return to manifest defaults">
                  ↺ Reset to defaults
                </button>
              </div>
            )}
          </>
        )}
        {!wf && <div className="sd-hint">Drop a &lt;name&gt;.json + &lt;name&gt;.manifest.json pair into workflows\ to add a model.</div>}
      </div>

      <div className="sd-actions">
        {busy && preview && (
          <img className="vid-live-preview" alt="live preview"
            src={`data:${preview.mime};base64,${preview.b64}`}
            style={{ width: '100%', borderRadius: 6, display: 'block' }} />
        )}
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="sd-gen" style={{ flex: 1 }} disabled={!running || busy}
            title={!running ? 'Start ComfyUI first' : undefined}
            onClick={generate}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
          <button className="ghost" disabled={!busy || !running}
            title={!running ? 'ComfyUI is not running'
              : busy ? 'Interrupt the running job and clear the queue' : 'Nothing is running'}
            onClick={cancelJob}>✕ Cancel</button>
        </div>
      </div>

      <details className="sd-log" open={logOpen} onToggle={e => setLogOpen(e.currentTarget.open)}>
        <summary>ComfyUI log</summary>
        <pre>{logLines.length ? logLines.join('\n') : '(no output yet)'}</pre>
      </details>
    </>
  );
}
