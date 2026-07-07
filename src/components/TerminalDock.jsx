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
import React, { useState, useCallback } from 'react';
import TerminalPanel from './TerminalPanel.jsx';
import api from '../api.js';
import { LAUNCHERS } from '../terminal/launchers.js';

// cwd '' means "home (default)". cwdDraft is the editable bar value; cwd is the
// applied value the pty spawns with; gen bumps to force a restart.
const makeShell = () => ({ key: 'shell', label: 'Shell', command: null, cwd: '', cwdDraft: '', gen: 0 });

export default function TerminalDock({ active, onToast }) {
  const [instances, setInstances] = useState([makeShell()]);
  const [activeKey, setActiveKey] = useState('shell');

  const activeInst = instances.find(i => i.key === activeKey) || instances[0];
  const isOpen = useCallback((key) => instances.some(i => i.key === key), [instances]);
  const patch = useCallback((key, p) => setInstances(prev => prev.map(i => i.key === key ? { ...i, ...p } : i)), []);

  const openTool = useCallback((l) => {
    setInstances(prev => prev.some(i => i.key === l.label)
      ? prev
      : [...prev, { key: l.label, label: l.label, command: l.command, cwd: '', cwdDraft: '', gen: 0 }]);
    setActiveKey(l.label);
  }, []);

  const closeInstance = useCallback((key) => {
    setInstances(prev => prev.filter(i => i.key !== key));
    setActiveKey(prev => (prev === key ? 'shell' : prev));
  }, []);

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
    setInstances(prev => prev.map(i => i.key === key ? { ...i, cwd: p, cwdDraft: p, gen: i.gen + 1 } : i));
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

  return (
    <>
      <div className="term-tabs">
        <div className={'term-tab' + (activeKey === 'shell' ? ' active' : '')}
          onClick={() => setActiveKey('shell')}>
          <span className="lbl">Shell</span>
        </div>
        {LAUNCHERS.map(l => {
          const open = isOpen(l.label);
          return (
            <div key={l.label}
              className={'term-tab' + (activeKey === l.label ? ' active' : '') + (open ? ' open' : '')}
              title={open ? 'Switch to ' + l.label : 'Launch: ' + l.command}
              onClick={() => openTool(l)}>
              <span className="lbl">{l.label}</span>
              {open && (
                <span className="x" title={'Close ' + l.label}
                  onClick={(e) => { e.stopPropagation(); closeInstance(l.label); }}>✕</span>
              )}
            </div>
          );
        })}
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
        {instances.map(inst => {
          const show = active && activeKey === inst.key;
          return (
            <div key={inst.key} className="term-slot" style={{ display: show ? 'flex' : 'none' }}>
              {/* key includes gen so applying a folder remounts -> respawns in new cwd */}
              <TerminalPanel key={inst.key + ':' + inst.gen}
                active={show} initialCommand={inst.command} initialCwd={inst.cwd}
                onResolvedCwd={(info) => handleResolvedCwd(inst.key, info)} />
            </div>
          );
        })}
      </div>
    </>
  );
}
