import React from 'react';

// ---------- editable-files allow-list panel ----------
export function SidePanel({ open, paths, onAdd, onRemove }) {
  return (
    <aside id="side" className={open ? 'open' : ''}>
      <div className="side-head">
        <h3>Editable files</h3>
        <p>Only files you add here can be edited, and only after you confirm each save. A <code>.bak</code> backup is kept.</p>
      </div>
      <div id="allowList">
        {!paths.length
          ? <div className="side-empty">No files added yet.</div>
          : paths.map(p => {
              const name = p.split(/[\\/]/).pop();
              return (
                <div key={p} className="allow-item">
                  <span className="nm" title={p}>{name}</span>
                  <span className="x" title="Remove" onClick={() => onRemove(p)}>✕</span>
                </div>
              );
            })}
      </div>
      <div className="side-foot"><button style={{ width: '100%' }} onClick={onAdd}>Add files…</button></div>
    </aside>
  );
}

// ---------- per-chat standing instructions ----------
export function SysPromptBar({ open, value, onChange, onBlur }) {
  if (!open) return null;
  return (
    <div id="sysPromptBar">
      <textarea id="sysPrompt" value={value} autoFocus
        placeholder="Standing instructions for this chat — e.g. 'Vanilla JavaScript only, no frameworks. I'm building an RPG Maker game launcher. Keep answers concise.'"
        onChange={e => onChange(e.target.value)} onBlur={onBlur} />
      <span className="sp-note">Applies to every message in this conversation. Saved with the chat.</span>
    </div>
  );
}

// ---------- toast notifications ----------
export function Toasts({ toasts }) {
  return (
    <div id="toasts">
      {toasts.map(t => <div key={t.id} className={'toast' + (t.kind ? ' ' + t.kind : '')}>{t.msg}</div>)}
    </div>
  );
}

// ---------- drag-and-drop overlay ----------
export function DropZone({ show }) {
  return (
    <div id="dropZone" className={show ? 'show' : ''}>
      <div className="inner">
        <div className="big">⬇</div>
        <div className="lbl">Drop files to attach</div>
      </div>
    </div>
  );
}
