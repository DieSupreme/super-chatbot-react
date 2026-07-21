// TerminalPanel — the xterm.js widget. Either creates a new PTY session in main
// or reattaches to an existing daemon session (restored pinned tabs), via the
// `api.term` bridge. Pipes keystrokes -> pty and pty output -> screen, keeps the
// pty sized to the visible area. Session lifecycle (kill) is owned by
// persistence / explicit tab-close, not by this component's unmount.
//
// node-pty is never imported here; the renderer only speaks the term IPC surface.
import React, { useEffect, useRef, useCallback } from 'react';
import api from '../api.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Dark palette tuned to the app theme (see styles.css :root vars).
const THEME = {
  background: '#0a0a0a', foreground: '#cfcfcf', cursor: '#cfcfcf',
  selectionBackground: '#333333', black: '#000000', brightBlack: '#5c5c5c'
};

// `active` controls sizing: xterm/fit can't measure a display:none element, so we
// re-fit whenever the panel becomes visible. `initialCommand` runs once at start
// (only for freshly-created sessions); `initialCwd` is the folder to spawn in;
// `onResolvedCwd` reports where the pty actually landed (main may fall back to
// home). `sessionId`, when set, reattaches to that existing daemon session
// instead of creating a new one; `onSession` reports the id of a freshly
// created session back to the caller (e.g. so it can be persisted).
export default function TerminalPanel({ active, initialCommand, initialCwd, onResolvedCwd, sessionId, onSession }) {
  const hostRef = useRef(null);       // the DOM node xterm mounts into
  const termRef = useRef(null);       // xterm instance
  const fitRef = useRef(null);        // fit addon
  const sessionRef = useRef(null);    // pty session id (null until created)
  const lastSize = useRef({ cols: 0, rows: 0 });   // last size pushed to the pty
  const activeRef = useRef(active);
  activeRef.current = active;

  // Fit to the host and push the new size to the pty. Shared by the resize
  // observer / window-resize path and the hidden->visible transition. Skips the
  // resize IPC when the measured size is unchanged (mount fires fit 2-3x for the
  // same size, and window resizes often settle back to it).
  const refit = useCallback(() => {
    const fit = fitRef.current, term = termRef.current;
    if (!fit || !term) return;
    try {
      fit.fit();
      const id = sessionRef.current;
      if (id != null && (term.cols !== lastSize.current.cols || term.rows !== lastSize.current.rows)) {
        lastSize.current = { cols: term.cols, rows: term.rows };
        api.term.resize(id, term.cols, term.rows);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    let disposed = false;
    let offData = null, offExit = null, resizeObserver = null;
    let inputBuf = [];   // keystrokes typed before the session id is known
    const host = hostRef.current;   // captured for listener add/remove symmetry

    const term = new Terminal({
      fontFamily: '"Consolas","SF Mono",monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 5000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    term.open(hostRef.current);

    const waitForLayout = () => new Promise((resolve) => {
      const tick = () => {
        if (disposed) { resolve(); return; }
        const el = hostRef.current;
        if (el && el.clientWidth > 8 && el.clientHeight > 8) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });

    // Read the native clipboard and feed it to the pty. term.paste() is
    // bracketed-paste aware, so multi-line pastes are delivered as one chunk.
    const pasteFromClipboard = () => {
      const text = api.readClipboard ? api.readClipboard() : '';
      if (text) term.paste(text);
    };

    // Clipboard keys. xterm leans on the browser/Electron native paste accelerator,
    // which isn't wired here (no application Menu), so handle it ourselves:
    //   Ctrl+V / Ctrl+Shift+V -> paste clipboard into the pty
    //   Ctrl+C  -> copy the selection if there is one (then clear it); otherwise
    //              fall through so the shell still receives SIGINT
    //   Ctrl+Shift+C -> always copy the selection
    // Returning false stops xterm from also processing the event.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'v' || e.key === 'V')) {
        pasteFromClipboard();
        return false;
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        // Copy when text is selected (then clear the selection). A bare Ctrl+C
        // with nothing selected falls through so the pty still gets SIGINT.
        if (term.hasSelection()) {
          if (api.writeClipboard) api.writeClipboard(term.getSelection());
          term.clearSelection();
          return false;
        }
        return true;   // no selection -> let it through as interrupt
      }
      return true;
    });

    // Right-click behaves like Windows Terminal: copy the selection if there is
    // one, otherwise paste. Suppress the native context menu either way.
    const onContextMenu = (ev) => {
      ev.preventDefault();
      if (term.hasSelection()) {
        if (api.writeClipboard) api.writeClipboard(term.getSelection());
        term.clearSelection();
      } else {
        pasteFromClipboard();
      }
    };
    host.addEventListener('contextmenu', onContextMenu);

    // Attach the keystroke handler up front and buffer input until the session id
    // is known, so keys typed before the session resolves are not lost.
    term.onData((data) => {
      if (sessionRef.current != null) api.term.write(sessionRef.current, data);
      else inputBuf.push(data);
    });

    // Bind this panel to a daemon session: reattach when restoring a live session,
    // otherwise create fresh. Dead/stale session ids fall back to create.
    // Wire onData/onExit BEFORE reattach — reattach subscribes to live output and
    // the first banner/prompt bytes must not be missed.
    const bind = async () => {
      let id = sessionId;
      let resolvedCwd = initialCwd || '';
      let fallback = false;
      let ring = '';
      let freshCreate = false;

      const wireSession = (sid) => {
        offData = api.term.onData(sid, (data) => term.write(data));
        offExit = api.term.onExit(sid, ({ exitCode }) => {
          sessionRef.current = null;
          term.writeln(`\r\n\x1b[90m[process exited${typeof exitCode === 'number' ? ' with code ' + exitCode : ''}]\x1b[0m`);
        });
      };

      const unwireSession = () => {
        if (offData) offData();
        if (offExit) offExit();
        offData = null;
        offExit = null;
      };

      if (id != null) {
        wireSession(id);
        let re = await api.term.reattach(id);
        if (disposed) { api.term.detach(id); unwireSession(); return; }
        if (re?.ok && re.alive !== false) {
          ring = re.ring || '';
          if (!ring) {
            await new Promise(r => setTimeout(r, 100));
            if (disposed) { api.term.detach(id); unwireSession(); return; }
            re = await api.term.reattach(id);
            if (re?.ok && re.ring) ring = re.ring;
          }
        } else {
          unwireSession();
          if (id != null) api.term.detach(id);
          id = null;
        }
      }

      if (id == null) {
        freshCreate = true;
        const r = await api.term.create({ cols: term.cols, rows: term.rows, cwd: initialCwd || undefined, command: initialCommand || '' });
        if (disposed) { if (r && r.ok) api.term.kill(r.id); return; }
        if (!r || !r.ok) { term.writeln('\r\n\x1b[31mFailed to start terminal: ' + (r && r.error || 'unknown') + '\x1b[0m'); return; }
        id = r.id;
        resolvedCwd = r.cwd;
        fallback = !!r.cwdFallback;
        if (!disposed && onSession) onSession(id);
        wireSession(id);
        let re = await api.term.reattach(id);
        if (disposed) { api.term.detach(id); unwireSession(); return; }
        if (re?.ok && re.ring) ring = re.ring;
        // Shell banner often lands in the ring buffer after create returns — retry once.
        if (!ring) {
          await new Promise(r => setTimeout(r, 150));
          if (disposed) { api.term.detach(id); unwireSession(); return; }
          re = await api.term.reattach(id);
          if (re?.ok && re.ring) ring = re.ring;
        }
      }

      if (ring) term.write(ring);
      else api.term.write(id, '\r');

      for (const d of inputBuf) api.term.write(id, d);
      inputBuf = [];
      sessionRef.current = id;

      if (freshCreate && initialCommand) api.term.write(id, initialCommand + '\r');

      if (onResolvedCwd && !disposed) onResolvedCwd({ cwd: resolvedCwd, fallback });
      try { refit(); } catch (_) {}
      try { term.refresh(0, term.rows - 1); } catch (_) {}
      if (activeRef.current) term.focus();
    };

    (async () => {
      try {
        await waitForLayout();
        if (disposed) return;
        try { fit.fit(); } catch (_) {}
        await bind();
      } catch (err) {
        if (!disposed) term.writeln('\r\n\x1b[31mTerminal error: ' + (err && err.message || err) + '\x1b[0m');
      }
    })();

    // Keep the pty's cols/rows matched to the widget (panel + window resize).
    const applyFit = () => { if (activeRef.current) refit(); };   // can't measure a hidden panel
    resizeObserver = new ResizeObserver(applyFit);
    resizeObserver.observe(hostRef.current);
    window.addEventListener('resize', applyFit);

    // Cleanup: stop listeners, dispose xterm. The pty itself is NOT killed here —
    // persistence and tab-close (✕) own the session lifecycle now.
    return () => {
      disposed = true;
      if (host) host.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('resize', applyFit);
      if (resizeObserver) resizeObserver.disconnect();
      if (offData) offData();
      if (offExit) offExit();
      const sid = sessionRef.current;
      if (sid != null && api.term.detach) api.term.detach(sid);
      sessionRef.current = null;
      try { term.dispose(); } catch (_) {}
      termRef.current = null;
    };
  }, []);

  // Re-fit when the panel transitions hidden -> visible (it couldn't size while
  // display:none). A rAF lets layout settle before fit measures.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      refit();
      const el = document.activeElement;
      if (el?.closest?.('.term-cwd-input')) return;
      if (termRef.current) termRef.current.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, refit]);

  return <div className="term-host" ref={hostRef} />;
}
