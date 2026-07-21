# Known lows — residual audit findings not fixed in the audit-fix pass

Context: the 71-finding audit (2026-07-20) was fixed across Phases 0–8
(2026-07-21). The items below were deliberately deferred — each is either out of
the fix plan's scope, a feature gap rather than a defect, or needs a change
larger/riskier than the finding warrants. They are recorded here so they are not
lost. None is a crash or data-loss path.

## 1. `files:read` reads renderer-supplied absolute paths with no user gesture (medium, security)
- **Where:** `main.js` — `ipcMain.handle('files:read', …)` → `readOne(p)`.
- **What:** Any path the renderer sends is read from disk (text ext ≤5MB, or any
  file <256KB) with no dialog and no allow-list. A renderer compromise could
  exfiltrate arbitrary local files through this channel.
- **Why deferred:** contextIsolation + sandbox + strict CSP are intact, so this
  requires a renderer compromise to exploit; the legitimate callers (drag-drop
  and the file picker) already produce the paths. A correct fix tracks a
  per-session set of paths granted via `files:pick` / `webUtils` drop and honors
  only those — a behavior change beyond the fix plan's Phase 1 scope and one that
  can break the drop/paste flow if done carelessly.
- **Recommended fix:** in main, maintain a `Set` of paths produced by
  `files:pick` and by the renderer's `getPathForFile` drops this session; have
  `files:read` reject any path not in that set.

## 2. Fragmented binary WebSocket frame dropped in the manual RFC 6455 fallback (low)
- **Where:** `src/main/comfy-core.js` — the hand-rolled WS client (`openManualWs`)
  used only when the Node runtime has no global `WebSocket`.
- **What:** A binary preview frame split across WS fragments (opcode 2, FIN=0) is
  delivered on the first fragment as if complete; continuation frames fall into
  the text path and fail `JSON.parse`, so the frame arrives truncated/corrupt.
- **Why deferred:** Electron's renderer/main both have a native `WebSocket`, so
  the generation path uses `openNativeWs`; the manual client is a fallback for
  bare-Node runtimes only, and preview frames are cosmetic (live sampler
  thumbnails), never the saved result. Fixing it means buffering fragmented
  binary opcodes until FIN in the fallback client.

## 3. Dead CSS: `.md blockquote` and `.tok-fn` never match (low, cosmetic)
- **Where:** `src/styles.css`.
- **What:** The markdown parser emits no blockquotes (so `>` quotes render as
  plain paragraphs with a literal `>`), and `highlight()` emits no `tok-fn`
  span — both rules are unreachable.
- **Why deferred:** These are a feature gap (no blockquote support) plus dead
  weight, not a defect that breaks rendering. Resolve by either adding blockquote
  handling to `parseTextBlocks` (and a function-name pass to `highlight`) or
  deleting the two rules.

## 4. Terminal pipe: only a cheap server-identity check, not full challenge-response (low, security, multi-user machines)
- **Where:** `src/terminal/daemon-client.js` — `serverLooksOurs()` / `hello()`.
- **What (now):** Before sending the daemon token, the client confirms the
  lockfile's daemon pid is a live process THIS user owns (`process.kill(pid, 0)`
  → EPERM/ESRCH ⇒ refuse). Combined with the lockfile living in ACL-protected
  userData, this raises the bar against another local user pre-creating the
  predictable pipe to capture the token.
- **Residual:** It is not proof that the process answering the pipe IS that pid.
  Full server-identity verification (Windows `GetNamedPipeServerProcessId` +
  owner-SID match, or a two-way challenge-response using the lockfile token in
  both directions) needs native code and is out of scope. On a shared multi-user
  Windows machine a determined local attacker could still race the pipe. Single-
  user machines (the app's target) are unaffected.
