# Persistent Terminal Sessions via a Detached PTY Daemon

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan
**Component:** Embedded terminal (`src/terminal/*`, `src/components/Terminal*.jsx`, `main.js`, `preload.js`)

## Goal

Let a user **pin** a terminal tab so its underlying process (e.g. a live `claude`
session) keeps running after the app is fully closed, and is **reconnected**
automatically on the next launch — as the same live process, not a fresh one.

Unpinned tabs behave exactly as today: they die when the app closes.

## Why a daemon is required (non-negotiable constraint)

A PTY is a child process of whatever spawned it. Today that owner is the Electron
main process, so `app.on('before-quit', disposeAll)` kills every PTY on quit
(`src/terminal/pty.js:127`). A process can only outlive the app if something *other
than* the app owns it. Therefore the PTYs must move into a **separate, detached,
long-lived process** — the daemon — that the app connects to as a client.

This is, in effect, a minimal single-user `tmux` scoped to this app.

## Accepted limitations (explicitly in scope as "acceptable")

1. Pinned processes consume CPU/RAM in the background while the app is closed.
   They are killed only by: the tab's ✕, unpinning, or "Quit & kill all terminals".
2. Reconnect replays the recent output buffer and nudges a repaint; it is **not** a
   pixel-perfect snapshot of a full-screen TUI. Most TUIs (claude, vim) redraw
   correctly on the resize nudge.
3. The daemon does **not** survive an OS reboot (nothing can without installing a
   Windows service, which is out of scope). After a reboot, pinned tabs are
   respawned **fresh** from saved metadata, with a toast telling the user so.

## Architecture

```
┌────────────────────────┐        named pipe (JSON-lines)       ┌───────────────────────┐
│  Electron main process │ <──────────────────────────────────> │   PTY daemon process  │
│                        │   \\.\pipe\superchat-term-<userhash>  │  (detached, unref'd)  │
│  daemon-client.js      │                                       │  daemon.js            │
│   - connect-or-spawn   │                                       │   - node-pty sessions │
│   - request/response   │                                       │   - ring buffers      │
│   - event fan-out      │                                       │   - net server        │
│  pty.js (IPC bridge)   │                                       │   - stable session ids│
└───────────┬────────────┘                                       └───────────────────────┘
            │ term:* IPC
┌───────────┴────────────┐
│      Renderer          │
│  TerminalDock.jsx      │
│  TerminalPanel.jsx     │
└────────────────────────┘
```

### Transport

- **Named pipe** on Windows (`\\.\pipe\...`), Unix domain socket path on POSIX, via
  Node's `net` module. No TCP, so no Windows Firewall prompt.
- **Protocol:** newline-delimited JSON control messages. PTY output/input bytes are
  carried as base64 strings inside those messages (simple and correct for a local
  pipe; a binary length-prefixed framing is a possible later optimization).
- **Auth:** a random token generated on first daemon spawn, stored in the lockfile,
  sent by the client as the first `hello` message. Daemon rejects mismatches. This
  backs up the OS-level per-user ACL on the pipe.

### Daemon: `src/terminal/daemon.js` (new)

Standalone script run as plain Node via Electron's own binary
(`ELECTRON_RUN_AS_NODE=1`), so the **already-rebuilt `node-pty`** loads without a
separate native build.

Responsibilities:
- Own all `node-pty` sessions in a `Map<id, session>`, `id` a monotonically
  increasing integer **assigned by the daemon** and stable for the session's life.
- Per session, keep a **ring buffer** (~256 KB) of recent raw output for replay.
- Track a `persist` (pinned) flag per session.
- `net` server on the pipe. Accept multiple sequential client connections (the app
  disconnects on quit and a new app instance reconnects later).
- Self-exit when `sessions.size === 0` (all closed or all unpinned-and-killed), so
  an empty daemon never lingers. It is respawned on demand next time.
- Write `{ pipe, token, pid }` to the lockfile on startup; remove it on exit.

Daemon message types (client → daemon): `hello`, `create`, `write`, `resize`,
`start`, `kill`, `list`, `setPinned`, `reattach`, `killUnpinned`, `quitAll`.
Daemon → client: `hello-ok`, `created`, `data`, `exit`, `list-result`,
`replay` (buffered bytes for a reattach), `ack`/`error`.

### Client: `src/terminal/daemon-client.js` (new, main process)

- **connect-or-spawn:** read lockfile; try to connect to the pipe. On failure
  (no daemon, or stale lockfile), spawn the daemon detached
  (`spawn(process.execPath, [daemonPath], { detached: true, stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref()`), poll for the
  pipe to appear (bounded retries), then connect and `hello`.
- Maintain a request/response layer (correlation ids) plus an event router that
  forwards `data`/`exit` to the renderer keyed by session id (same shape the
  renderer already consumes).
- Expose async methods mirroring the daemon message types.

### Bridge: `src/terminal/pty.js` (reworked)

Keeps its role as the `term:*` IPC surface but delegates to `daemon-client` instead
of owning `node-pty` directly. `registerTerminalIpc(app)` keeps existing handlers
(`term:create/write/resize/start/kill/pickFolder/pathExists`) and adds:
`term:list`, `term:setPinned`, `term:reattach`. `before-quit`/`window-all-closed`
no longer call a local `disposeAll`; instead they call
`daemonClient.killUnpinned()` then disconnect (leaving the daemon and pinned
sessions alive).

### `main.js`

- Initialize `daemon-client` **lazily** on the first `term:*` call, so users who
  never open the terminal never spawn a daemon.
- Replace the `disposeAll` wiring with the "kill unpinned, keep pinned, disconnect"
  behavior described above.

### `preload.js`

Extend the `term` bridge with:
- `list: () => invoke('term:list')`
- `setPinned: (id, pinned) => invoke('term:setPinned', { id, pinned })`
- `reattach: (id) => invoke('term:reattach', id)`
- `quitAll: () => invoke('term:quitAll')`

`readClipboard`/`writeClipboard` (already added) are unaffected.

### `TerminalPanel.jsx`

Add a reattach mode alongside the existing create mode:
- New optional prop `sessionId` (a surviving daemon session to attach to) OR the
  existing create path when absent.
- On reattach: call `api.term.reattach(id)`, receive the replay buffer, write it to
  xterm, wire live `data`/`exit`, then trigger one `resize` so full-screen TUIs
  repaint. Do **not** re-run `initialCommand` on reattach.
- The clipboard/paste handler added previously stays as-is.

### `TerminalDock.jsx`

- **Pin UI:** a 📍 toggle on each tab. Toggling calls `api.term.setPinned(id, on)`
  and updates instance state.
- **Restore on launch:** on mount, call `api.term.list()`. For each surviving
  **pinned** session, create a tab bound to that `sessionId` (reattach path).
- **Metadata persistence:** persist pinned tabs' `{ label, cwd, command }` to
  settings (`settings:get/save`, already present). On launch, for a pinned tab whose
  session is **not** in `list()` (process died / reboot), respawn it **fresh** (run
  its command) and toast "Reconnected as a fresh session".
- **Quit & kill all:** a control that calls a new `term:quitAll` (kills every
  session and lets the daemon exit).

## Session ID stability

IDs are assigned by the daemon and persist for the session's lifetime, surviving
app restarts (the daemon keeps running). The renderer must treat `sessionId` as
opaque and durable, not re-derive it. The current renderer-side `gen`-bump restart
(folder change) becomes: kill the old session, create a new one, adopt the new id.

## Data flow: launch with one pinned `claude` tab

1. App starts → `daemon-client` connects to the already-running daemon (spawned in a
   previous run, still alive because it holds a pinned session).
2. `TerminalDock` calls `term:list` → daemon returns `[{ id: 7, label:'Claude',
   pinned:true, cwd:'D:\\proj' }]`.
3. Dock creates a Claude tab with `sessionId: 7`; `TerminalPanel` reattaches, gets
   the replay buffer, renders it, resizes to repaint claude's TUI.
4. User works; on quit, daemon-client kills unpinned sessions, keeps 7, disconnects.
   Daemon stays alive. Cycle repeats.

## Testing strategy

- **Daemon protocol unit tests:** spawn `daemon.js` as a child, connect over the
  pipe, exercise create/write/resize/kill/list/setPinned/reattach; assert replay
  buffer contents and self-exit on empty.
- **Reconnect integration test:** create + pin a session running a marker command,
  disconnect (simulating app close), reconnect, assert `list` shows it and `reattach`
  replays the marker output.
- **Lifecycle tests:** `killUnpinned` keeps pinned and kills the rest; daemon
  self-exits when the last session is killed; connect-or-spawn spawns when no daemon
  and reuses when one exists; stale-lockfile recovery.
- **Graceful degradation:** with no live daemon, a pinned tab from settings respawns
  fresh and toasts.
- **Manual smoke:** pin a real `claude` tab, fully quit the app, relaunch, confirm
  the same session reattaches and the TUI repaints.

## Out of scope (YAGNI)

- Surviving OS reboot (would need a Windows service).
- Sharing sessions across multiple app windows simultaneously (sequential
  reconnect only).
- Binary/optimized wire framing (JSON-lines + base64 is the v1).
- Scrollback larger than the ~256 KB ring buffer, or persisting scrollback to disk.
