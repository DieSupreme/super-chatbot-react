// TerminalDock — owns the set of open terminal instances, the tab strip, and the
// per-instance working-folder bar.
//
// There is always at least one plain "Shell" tab. Each launcher (Claude/Cursor/…)
// can have multiple independent instances — click a launcher name to focus an
// existing one (or open the first), click + to spawn another. ✕ closes an instance
// (kills its pty). Drop files onto the terminal to paste their paths (Claude Code, etc.).
//
// Each instance has its own working folder. Changing it RESTARTS that instance in
// the new folder (pty cwd is fixed at spawn). Restart bumps `gen`, remounting the
// TerminalPanel.
import React, { useState, useCallback, useEffect, useRef } from 'react';
import TerminalPanel from './TerminalPanel.jsx';
import api from '../api.js';
import { LAUNCHERS } from '../terminal/launchers.js';

let instanceSeq = 0;
const allocKey = (prefix) => `${prefix}:${++instanceSeq}`;

const makeShell = (key = 'shell', label = 'Shell') => ({
  key, label, launcherKey: null, command: null,
  cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false
});

const makeToolInstance = (launcher, key, label) => ({
  key, label, launcherKey: launcher.label, command: launcher.command,
  cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false
});

function nextInstanceLabel(launcherLabel, instances) {
  const n = instances.filter(i => i.launcherKey === launcherLabel).length;
  return n === 0 ? launcherLabel : `${launcherLabel} ${n + 1}`;
}

function formatPathsForPty(paths) {
  return paths.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + '\r';
}

function normalizeFolderPath(raw) {
  let p = (raw ?? '').trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch (_) {}
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  return p;
}

export default function TerminalDock({ active, onToast }) {
  const [instances, setInstances] = useState([makeShell()]);
  const [activeKey, setActiveKey] = useState('shell');
  const [restored, setRestored] = useState(false);
  const [dropShow, setDropShow] = useState(false);
  const stackRef = useRef(null);
  const dragDepth = useRef(0);

  const activeInst = instances.find(i => i.key === activeKey) || instances[0];
  const activeSessionRef = useRef(null);
  activeSessionRef.current = activeInst.sessionId;
  const patch = useCallback((key, p) => setInstances(prev => prev.map(i => i.key === key ? { ...i, ...p } : i)), []);

  const persistPinned = useCallback((list) => {
    const pinned = list.filter(i => i.pinned).map(i => ({
      sessionId: i.sessionId, key: i.key, label: i.label, command: i.command,
      cwd: i.cwd, launcherKey: i.launcherKey
    }));
    api.saveSettings({ pinnedTerminals: pinned });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [listRes, setRes] = await Promise.all([api.term.list(), api.getSettings()]);
        if (cancelled) return;
        const live = (listRes && listRes.sessions) || [];
        const saved = ((setRes && setRes.settings && setRes.settings.pinnedTerminals) || []);
        const built = [makeShell()];
        const seenSessionIds = new Set();
        for (const meta of saved) {
          if (meta.sessionId != null) {
            if (seenSessionIds.has(meta.sessionId)) continue;
            seenSessionIds.add(meta.sessionId);
          }
          const liveMatch = live.find(s => s.id === meta.sessionId);
          const launcherKey = meta.launcherKey != null
            ? meta.launcherKey
            : (meta.key === 'shell' || meta.label === 'Shell' ? null : meta.label);
          const isShell = launcherKey == null;

          if (isShell && meta.key === 'shell') {
            const idx = built.findIndex(i => i.key === 'shell');
            if (idx !== -1) {
              const base = built[idx];
              if (liveMatch) {
                built[idx] = { ...base, pinned: true, command: meta.command || null, sessionId: liveMatch.id, cwd: liveMatch.cwd, cwdDraft: liveMatch.cwd };
              } else {
                built[idx] = { ...base, pinned: true, command: meta.command || null };
                if (onToast) onToast('Shell: reconnected as a fresh session', 'warn');
              }
            }
            continue;
          }
          if (built.some(i => i.key === meta.key)) continue;
          const instKey = meta.key || allocKey(launcherKey || 'shell');
          if (liveMatch) {
            built.push({
              key: instKey, label: meta.label, launcherKey, command: meta.command || null,
              cwd: liveMatch.cwd, cwdDraft: liveMatch.cwd, gen: 0, sessionId: liveMatch.id, pinned: true
            });
          } else {
            built.push({
              key: instKey, label: meta.label, launcherKey, command: meta.command || null,
              cwd: meta.cwd || '', cwdDraft: meta.cwd || '', gen: 0, sessionId: null, pinned: true
            });
            if (onToast) onToast(`${meta.label}: reconnected as a fresh session`, 'warn');
          }
        }
        if (!cancelled) setInstances(built);
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => { cancelled = true; };
  }, [onToast]);

  const addTool = useCallback((launcher) => {
    let newKey = '';
    setInstances(prev => {
      const label = nextInstanceLabel(launcher.label, prev);
      newKey = allocKey(launcher.label);
      return [...prev, makeToolInstance(launcher, newKey, label)];
    });
    setActiveKey(newKey);
  }, []);

  const focusShell = useCallback(() => {
    const shells = instances.filter(i => i.launcherKey == null);
    if (shells.length) setActiveKey(shells[shells.length - 1].key);
  }, [instances]);

  const focusOrOpenTool = useCallback((launcher) => {
    const existing = instances.filter(i => i.launcherKey === launcher.label);
    if (existing.length) setActiveKey(existing[existing.length - 1].key);
    else addTool(launcher);
  }, [instances, addTool]);

  const addShell = useCallback(() => {
    let newKey = '';
    setInstances(prev => {
      const shells = prev.filter(i => i.launcherKey == null);
      const label = shells.length === 0 ? 'Shell' : `Shell ${shells.length + 1}`;
      newKey = shells.length === 0 ? 'shell' : allocKey('shell');
      return [...prev, makeShell(newKey, label)];
    });
    setActiveKey(newKey);
  }, []);

  const closeInstance = useCallback(async (key) => {
    const inst = instances.find(i => i.key === key);
    if (!inst) return;
    if (inst.launcherKey == null && instances.filter(i => i.launcherKey == null).length <= 1) return;
    if (inst.sessionId != null) await api.term.kill(inst.sessionId);
    setInstances(prev => {
      const idx = prev.findIndex(i => i.key === key);
      const next = prev.filter(i => i.key !== key);
      persistPinned(next);
      setActiveKey(ak => {
        if (ak !== key) return ak;
        const neighbor = next[Math.min(idx, next.length - 1)];
        return neighbor ? neighbor.key : 'shell';
      });
      return next;
    });
  }, [instances, persistPinned]);

  const togglePin = useCallback((key) => {
    setInstances(prev => {
      const next = prev.map(i => {
        if (i.key !== key) return i;
        const pinned = !i.pinned;
        if (i.sessionId != null) api.term.setPinned(i.sessionId, pinned);
        return { ...i, pinned };
      });
      persistPinned(next);
      return next;
    });
  }, [persistPinned]);

  const setSession = useCallback((key, id) => {
    setInstances(prev => {
      const next = prev.map(i => i.key === key ? { ...i, sessionId: id } : i);
      const inst = next.find(i => i.key === key);
      if (inst && inst.pinned) api.term.setPinned(id, true);
      persistPinned(next);
      return next;
    });
  }, [persistPinned]);

  const quitAll = useCallback(async () => {
    await api.term.quitAll();
    setInstances([makeShell()]);
    setActiveKey('shell');
    api.saveSettings({ pinnedTerminals: [] });
    if (onToast) onToast('All terminals stopped', 'ok');
  }, [onToast]);

  const applyCwd = useCallback(async (key, rawPath) => {
    const p = normalizeFolderPath(rawPath);
    if (p) {
      const r = await api.term.pathExists(p);
      if (r && r.ok && !r.exists) { onToast && onToast('Folder not found: ' + p, 'warn'); return; }
    }
    const inst = instances.find(i => i.key === key);
    if (inst && inst.sessionId != null) await api.term.kill(inst.sessionId);
    setInstances(prev => {
      const next = prev.map(i => {
        if (i.key !== key) return i;
        return { ...i, cwd: p, cwdDraft: p, sessionId: null, gen: i.gen + 1 };
      });
      persistPinned(next);
      return next;
    });
  }, [instances, onToast, persistPinned]);

  const browse = useCallback(async (key) => {
    const r = await api.term.pickFolder();
    if (r && r.ok && r.path) applyCwd(key, r.path);
    else if (r && r.error && onToast) onToast('Could not open folder picker: ' + r.error, 'warn');
  }, [applyCwd, onToast]);

  const onCwdPaste = useCallback((e) => {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    patch(activeKey, { cwdDraft: normalizeFolderPath(text) });
  }, [activeKey, patch]);

  const handleResolvedCwd = useCallback((key, { cwd, fallback }) => {
    setInstances(prev => prev.map(i => i.key === key
      ? { ...i, cwd, cwdDraft: i.cwdDraft === i.cwd ? cwd : i.cwdDraft }
      : i));
    if (fallback && onToast) onToast('Folder unavailable — opened your home folder instead', 'warn');
  }, [onToast]);

  // Drop files onto the terminal — paste absolute paths into the active pty.
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.contains(e.relatedTarget)) return;
      dragDepth.current++;
      setDropShow(true);
    };
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.contains(e.relatedTarget)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropShow(false);
    };
    const drop = async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDropShow(false);
      const dropped = Array.from(e.dataTransfer.files || []);
      if (!dropped.length) return;
      const paths = dropped.map(f => api.getPathForFile(f)).filter(Boolean);
      if (!paths.length) { onToast && onToast('Could not resolve file paths — try dragging from Explorer', 'warn'); return; }
      const sid = activeSessionRef.current;
      if (sid == null) { onToast && onToast('Terminal not ready yet — wait a moment', 'warn'); return; }
      api.term.write(sid, formatPathsForPty(paths));
    };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [onToast]);

  const renderPin = (inst) => (
    <span className={'pin' + (inst.pinned ? ' on' : '')}
      title={inst.pinned ? 'Pinned — survives app close. Click to unpin.' : 'Pin — keep running after the app closes.'}
      onClick={(e) => { e.stopPropagation(); togglePin(inst.key); }}>📍</span>
  );

  const canClose = (inst) => !(inst.launcherKey == null && instances.filter(i => i.launcherKey == null).length <= 1);

  return (
    <>
      <div className="term-tabs">
        {instances.map(inst => (
          <div key={inst.key}
            className={'term-tab open' + (activeKey === inst.key ? ' active' : '')}
            title={inst.command ? `${inst.label} — ${inst.command}` : inst.label}
            onClick={() => setActiveKey(inst.key)}>
            <span className="lbl">{inst.label}</span>
            {renderPin(inst)}
            {canClose(inst) && (
              <span className="x" title={'Close ' + inst.label}
                onClick={(e) => { e.stopPropagation(); closeInstance(inst.key); }}>✕</span>
            )}
          </div>
        ))}

        <div className="term-launchers">
          <div className="term-launcher">
            <button type="button" className="term-launcher-btn" title="Focus most recent shell"
              onClick={focusShell}>Shell</button>
            <button type="button" className="term-launcher-add" title="New shell instance" onClick={addShell}>+</button>
          </div>
          {LAUNCHERS.map(l => (
            <div key={l.label} className="term-launcher">
              <button type="button" className="term-launcher-btn" title={l.command}
                onClick={() => focusOrOpenTool(l)}>{l.label}</button>
              <button type="button" className="term-launcher-add" title={`New ${l.label} instance`}
                onClick={() => addTool(l)}>+</button>
            </div>
          ))}
        </div>

        <button className="ghost term-quit-all" title="Stop and kill every terminal (including pinned)" onClick={quitAll}>Quit all</button>
      </div>

      <div className="term-cwd">
        <span className="term-cwd-ico" title="Working folder for this terminal">📁</span>
        <input className="term-cwd-input" type="text" spellCheck={false}
          placeholder="Working folder for this instance — blank = home. Enter to (re)open here."
          value={activeInst.cwdDraft}
          onChange={(e) => patch(activeKey, { cwdDraft: e.target.value })}
          onPaste={onCwdPaste}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') applyCwd(activeKey, activeInst.cwdDraft);
          }} />
        <button type="button" className="ghost" onClick={() => browse(activeKey)}>Browse…</button>
        <button type="button" className="ghost" onClick={() => applyCwd(activeKey, activeInst.cwdDraft)}>Open</button>
      </div>

      <div className="term-stack" ref={stackRef}>
        {dropShow && (
          <div className="term-drop">
            <div className="inner">
              <div className="big">⬇</div>
              <div className="lbl">Drop files to paste paths into {activeInst.label}</div>
            </div>
          </div>
        )}
        {restored && instances.map(inst => {
          const show = active && activeKey === inst.key;
          return (
            <div key={inst.key} className="term-slot"
              style={{ display: 'flex', visibility: show ? 'visible' : 'hidden', zIndex: show ? 1 : 0 }}>
              <TerminalPanel key={inst.key + ':' + inst.gen}
                active={show} initialCommand={inst.command} initialCwd={inst.cwd}
                sessionId={inst.sessionId}
                onSession={(id) => setSession(inst.key, id)}
                onResolvedCwd={(info) => handleResolvedCwd(inst.key, info)} />
            </div>
          );
        })}
        {!restored && (
          <div className="term-loading">Connecting to terminal…</div>
        )}
      </div>
    </>
  );
}
