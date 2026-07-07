// TerminalDock — owns the set of open terminal instances, the tab strip, and the
// per-instance working-folder bar.
//
// There is always a plain "Shell" tab. Each launcher (Claude/Cursor/Grok/GPT)
// opens its OWN persistent instance the first time it's clicked (running its
// command once); clicking it again switches back to that same running instance
// with its scrollback intact. ✕ closes a tool instance (kills its pty).
//
// Each instance has its own working folder. Setting/changing it (Browse or type +
// Enter/Open) RESTARTS that instance in the new folder — a pty's cwd is fixed at
// spawn and a running CLI can't be cd'd, so re-spawning is the correct way to
// point an instance (e.g. claude) at a project directory. Restart is done by
// bumping the instance's `gen`, which remounts its TerminalPanel (old pty killed,
// new one spawned in the new cwd, launch command re-run).
//
// Every open instance keeps its TerminalPanel mounted (hidden via CSS when not
// active), so switching tabs — or toggling away to the chat view — never loses
// state or stops a session. A pty is killed when its tab is closed (✕), when a
// folder change respawns it, or when the app quits.
import React, { useState, useCallback, useEffect } from 'react';
import TerminalPanel from './TerminalPanel.jsx';
import api from '../api.js';
import { LAUNCHERS } from '../terminal/launchers.js';

// cwd '' means "home (default)". cwdDraft is the editable bar value; cwd is the
// applied value the pty spawns with; gen bumps to force a restart. sessionId is
// the daemon session bound to this instance (null until created/reattached);
// pinned marks it to survive app close and be restored on next launch.
const makeShell = () => ({ key: 'shell', label: 'Shell', command: null, cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false });

export default function TerminalDock({ active, onToast }) {
  const [instances, setInstances] = useState([makeShell()]);
  const [activeKey, setActiveKey] = useState('shell');
  const [restored, setRestored] = useState(false);

  const activeInst = instances.find(i => i.key === activeKey) || instances[0];
  const isOpen = useCallback((key) => instances.some(i => i.key === key), [instances]);
  const patch = useCallback((key, p) => setInstances(prev => prev.map(i => i.key === key ? { ...i, ...p } : i)), []);

  // Persist the pinned tabs' metadata so a pinned tab whose process later died
  // (force-kill / reboot) can be respawned fresh on a future launch.
  const persistPinned = useCallback((list) => {
    const pinned = list.filter(i => i.pinned).map(i => ({ sessionId: i.sessionId, key: i.key, label: i.label, command: i.command, cwd: i.cwd }));
    api.getSettings().then(r => {
      const s = (r && r.settings) || {};
      s.pinnedTerminals = pinned;
      api.saveSettings(s);
    });
  }, []);

  // On mount, reconcile saved pinned tabs against sessions still alive in the daemon.
  // Build the ENTIRE initial instance list (including the shell) before setting
  // state once — never let a fresh shell mount (and spawn a session) before we
  // know whether a pinned shell session should be reattached instead.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [listRes, setRes] = await Promise.all([api.term.list(), api.getSettings()]);
        if (cancelled) return;
        const live = (listRes && listRes.sessions) || [];
        const saved = ((setRes && setRes.settings && setRes.settings.pinnedTerminals) || []);
        const built = [makeShell()];
        for (const meta of saved) {
          const liveMatch = live.find(s => s.id === meta.sessionId);
          if (meta.key === 'shell') {
            // Reconcile into the always-present shell instance instead of pushing
            // a second one — a saved pinned shell and the default shell share key
            // 'shell', so this is a merge, not an append.
            const idx = built.findIndex(i => i.key === 'shell');
            if (idx !== -1) {
              const base = built[idx];
              if (liveMatch) {
                built[idx] = { ...base, pinned: true, command: meta.command, sessionId: liveMatch.id, cwd: liveMatch.cwd, cwdDraft: liveMatch.cwd };
              } else {
                built[idx] = { ...base, pinned: true, command: meta.command };
                if (onToast) onToast('Shell: reconnected as a fresh session', 'warn');
              }
            }
            continue;
          }
          if (built.some(i => i.key === meta.key)) continue; // dedupe
          if (liveMatch) {
            built.push({ key: meta.key, label: meta.label, command: meta.command, cwd: liveMatch.cwd, cwdDraft: liveMatch.cwd, gen: 0, sessionId: liveMatch.id, pinned: true });
          } else {
            // Process gone — respawn fresh (create path) and tell the user.
            built.push({ key: meta.key, label: meta.label, command: meta.command, cwd: meta.cwd || '', cwdDraft: meta.cwd || '', gen: 0, sessionId: null, pinned: true });
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

  const openTool = useCallback((l) => {
    setInstances(prev => prev.some(i => i.key === l.label)
      ? prev
      : [...prev, { key: l.label, label: l.label, command: l.command, cwd: '', cwdDraft: '', gen: 0, sessionId: null, pinned: false }]);
    setActiveKey(l.label);
  }, []);

  const closeInstance = useCallback((key) => {
    setInstances(prev => {
      const inst = prev.find(i => i.key === key);
      if (inst && inst.sessionId != null) api.term.kill(inst.sessionId);
      const next = prev.filter(i => i.key !== key);
      persistPinned(next);
      return next;
    });
    setActiveKey(prev => (prev === key ? 'shell' : prev));
  }, [persistPinned]);

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
    const r = await api.getSettings();
    const s = (r && r.settings) || {};
    s.pinnedTerminals = [];
    api.saveSettings(s);
    if (onToast) onToast('All terminals stopped', 'ok');
  }, [onToast]);

  // Apply a folder to an instance: validate it exists, then set cwd + bump gen so
  // the TerminalPanel remounts (kill + respawn in the new folder, re-run command).
  const applyCwd = useCallback(async (key, rawPath) => {
    const p = (rawPath ?? '').trim();
    if (p) {
      const r = await api.term.pathExists(p);
      // only block when we definitively know it's missing (ok:true, exists:false);
      // if validation itself failed (e.g. no Electron), let main be the authority.
      if (r && r.ok && !r.exists) { onToast && onToast('Folder not found: ' + p, 'warn'); return; }
    }
    // Changing the folder respawns: kill the old session (if any) so it doesn't
    // leak in the daemon, forget its id so the panel creates a new one, and bump
    // gen to remount.
    setInstances(prev => prev.map(i => {
      if (i.key !== key) return i;
      if (i.sessionId != null) api.term.kill(i.sessionId);
      return { ...i, cwd: p, cwdDraft: p, sessionId: null, gen: i.gen + 1 };
    }));
  }, [onToast]);

  const browse = useCallback(async (key) => {
    const r = await api.term.pickFolder();
    if (r && r.ok && r.path) applyCwd(key, r.path);
  }, [applyCwd]);

  // Reflect where the pty actually started. Main resolves the cwd (and may fall
  // back to home if the folder became unavailable); mirror that into the bar and
  // warn on fallback. Don't clobber a path the user is mid-editing.
  const handleResolvedCwd = useCallback((key, { cwd, fallback }) => {
    setInstances(prev => prev.map(i => i.key === key
      ? { ...i, cwd, cwdDraft: i.cwdDraft === i.cwd ? cwd : i.cwdDraft }
      : i));
    if (fallback && onToast) onToast('Folder unavailable — opened your home folder instead', 'warn');
  }, [onToast]);

  const renderPin = (inst) => (
    <span className={'pin' + (inst.pinned ? ' on' : '')}
      title={inst.pinned ? 'Pinned — survives app close. Click to unpin.' : 'Pin — keep running after the app closes.'}
      onClick={(e) => { e.stopPropagation(); togglePin(inst.key); }}>📍</span>
  );

  return (
    <>
      <div className="term-tabs">
        <div className={'term-tab' + (activeKey === 'shell' ? ' active' : '')} onClick={() => setActiveKey('shell')}>
          <span className="lbl">Shell</span>
          {renderPin(instances.find(i => i.key === 'shell') || makeShell())}
        </div>
        {instances.filter(i => i.key !== 'shell' && !LAUNCHERS.some(l => l.label === i.key)).map(inst => (
          <div key={inst.key} className={'term-tab open' + (activeKey === inst.key ? ' active' : '')} onClick={() => setActiveKey(inst.key)}>
            <span className="lbl">{inst.label}</span>
            {renderPin(inst)}
            <span className="x" title={'Close ' + inst.label} onClick={(e) => { e.stopPropagation(); closeInstance(inst.key); }}>✕</span>
          </div>
        ))}
        {LAUNCHERS.map(l => {
          const open = isOpen(l.label);
          const inst = instances.find(i => i.key === l.label);
          return (
            <div key={l.label}
              className={'term-tab' + (activeKey === l.label ? ' active' : '') + (open ? ' open' : '')}
              title={open ? 'Switch to ' + l.label : 'Launch: ' + l.command}
              onClick={() => openTool(l)}>
              <span className="lbl">{l.label}</span>
              {open && inst && renderPin(inst)}
              {open && (<span className="x" title={'Close ' + l.label} onClick={(e) => { e.stopPropagation(); closeInstance(l.label); }}>✕</span>)}
            </div>
          );
        })}
        <button className="ghost term-quit-all" title="Stop and kill every terminal (including pinned)" onClick={quitAll}>Quit all</button>
      </div>

      {/* per-instance working folder — reflects/edits the active instance */}
      <div className="term-cwd">
        <span className="term-cwd-ico" title="Working folder for this terminal">📁</span>
        <input className="term-cwd-input" type="text" spellCheck={false}
          placeholder="Working folder for this instance — blank = home. Enter to (re)open here."
          value={activeInst.cwdDraft}
          onChange={(e) => patch(activeKey, { cwdDraft: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') applyCwd(activeKey, activeInst.cwdDraft); }} />
        <button className="ghost" onClick={() => browse(activeKey)}>Browse…</button>
        <button className="ghost" onClick={() => applyCwd(activeKey, activeInst.cwdDraft)}>Open</button>
      </div>

      <div className="term-stack">
        {restored && instances.map(inst => {
          const show = active && activeKey === inst.key;
          return (
            <div key={inst.key} className="term-slot" style={{ display: show ? 'flex' : 'none' }}>
              {/* key includes gen so applying a folder remounts -> respawns in new cwd */}
              <TerminalPanel key={inst.key + ':' + inst.gen}
                active={show} initialCommand={inst.command} initialCwd={inst.cwd}
                sessionId={inst.sessionId}
                onSession={(id) => setSession(inst.key, id)}
                onResolvedCwd={(info) => handleResolvedCwd(inst.key, info)} />
            </div>
          );
        })}
      </div>
    </>
  );
}
