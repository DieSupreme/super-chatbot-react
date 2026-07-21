Save the following content as CLAUDE.md in the repo root (overwrite CLAUDE-chatbot.md's role; delete CLAUDE-chatbot.md if it exists), then run:

git add CLAUDE.md
git rm --cached CLAUDE-chatbot.md 2>nul & del CLAUDE-chatbot.md 2>nul
git commit -m "Add CLAUDE.md at correct auto-loaded path; fix agent-artifacts rule (docs/agent create-if-missing, superpowers dirs fenced off)"

--- CLAUDE.md content below ---

# CLAUDE.md - Super Chatbot

This file is for AI agents working on this specific app. It must live at the repo root as `CLAUDE.md` (Claude Code only auto-loads that exact name) and must be committed to git.
Current version: see package.json (do not trust version numbers written in docs — they go stale).
Feature docs and the vanilla→React mapping: `README-REACT.md`. Per-run task handoffs: `HANDOFF.md` (transient — replaced each run; prior handoffs live in git history).

## Session start ritual
Before the first edit of any session:
1. Confirm `dist/` is newer than `src/**` (else `npm run build`) — `main.js` loads `dist/index.html`; source files are never loaded directly. A stale dist makes every renderer fix a no-op (reload app with Ctrl+R after rebuild).
2. Identify which layer the task touches — Electron main (`main.js`, `src/main/**`), preload boundary (`preload.js`), or renderer (`src/**` JSX) — and read only those regions.
3. If the task involves image/video generation, check whether it's the Forge path (`src/main/sd.js`, port 7860) or the ComfyUI path (`src/main/comfy.js`, `comfy-core.js`, port 8188) before reading either.

## What this app is
- Windows-first Electron multi-model AI chat app for personal use.
- Chat routes through OpenRouter (one API gateway → Claude, GPT, Gemini, DeepSeek, Grok) with SSE streaming, file attachments, permissioned file editing, markdown rendering, and web search via OpenRouter plugins.
- Local image generation via two app-managed backends: Forge WebUI (SD models, port 7860) and ComfyUI (Krea2 and video workflows, port 8188). The app starts and stops these processes itself.
- Embedded terminal (node-pty + xterm.js).
- Renderer is React 18 + Vite (v3 rebuild); the Electron side predates it and is stable.

## High-level architecture

### Main process
- `main.js`: window lifecycle, IPC, storage, OpenRouter SSE plumbing.
- `src/main/sd.js`: Forge integration (txt2img/img2img).
- `src/main/comfy.js` + `src/main/comfy-core.js`: ComfyUI integration — process management, `/prompt` submission, progress streaming, Stop→`/interrupt`, UI-graph→API conversion, output picking.
- `src/main/sse.js`: streaming plumbing.

### Preload boundary
- `preload.js` exposes the contextBridge API. Treat it as a security boundary.
- `src/api.js` in the renderer is the ONE place `window.api` is touched. New IPC usage goes through it — never call `window.api` from random components.

### Renderer (`src/**`, builds to `dist/` via Vite)
- `src/App.jsx`: the state container — streaming, conversations, attachments, shortcuts. All app state lives here.
- `src/markdown.jsx`: fence/inline parser returning real React elements; `<CodeBlock>` owns its own copied/saved state.
- `src/components/`: HeaderBar, ConvoSidebar, ChatLog, Composer, SettingsModal, Panels.
- `vite.config.js` uses `base:'./'` so Electron can load dist over file:// — do not change this.

### The three load-bearing renderer patterns (do not "simplify" these away)
1. **Eager ref mirror** (`App.jsx`, top): `setMessages` computes the next array from `messagesRef.current` synchronously, stores it in the ref, THEN hands it to React. Streaming/persist code reads the ref. Removing this reintroduces the stale-conversation persist bug the test harness caught.
2. **rAF-batched streaming**: SSE deltas append to a plain object in a ref; one requestAnimationFrame callback drains it into a single `setMessages` per frame. Bypassing this causes render storms during streaming.
3. **Component-local state**: "Copied ✓", edit-card Apply/Dismiss, sidebar rename own their own useState. Do not lift these into App.

## Core project truths
- Storage is byte-compatible across the vanilla→React rebuild and must stay that way: `conversations.json`, `settings.json`, `or-key.bin`, `allowed-files.json` load as-is. No silent reshaping; migrations need a plan.
- `or-key.bin` is the user's OpenRouter API key. NEVER print, log, commit, copy, or transmit its contents. Never weaken how it's stored.
- CSP is strict: `script-src 'self'`, no `unsafe-inline`. Inline `<script>` or inline event handlers in index.html will silently fail — keep everything in the bundle.
- Chat calls cost real money (OpenRouter). Generation runs cost real time (a single Krea2 high-quality image takes 8-13 minutes). Tests must never hit real OpenRouter; never launch paid or long generation runs without asking.
- Windows paths in this ecosystem include the folder `D:\Devlopment\AI\...` — "Devlopment" IS the real spelling on disk. Do not "fix" it in any path.
- Forge cannot load Krea2-architecture checkpoints — those run through ComfyUI only. Backend choice per model/workflow is data, not preference.

## Commands by purpose

### Build / run
- Rebuild renderer: `npm run build` (one-off) or `npm run watch` (keep running, Ctrl+R in app to reload)
- Full app start: `npm start` — do NOT run from an agent session for verification; it launches Electron interactively. Use tests or CDP automation instead.

### Verify a change
- Renderer change: `npm run build && npm run test:renderer` (vitest + jsdom)
- Models / persistence / SSE logic: `npm run test:unit`
- Terminal daemon: `npm run test:term`
- Cross-cutting / boot / storage / backend changes: `npm test` (unit + terminal + renderer) or `npm run test:ci` (build + full suite)
- Live end-to-end (image gen, real IPC): drive the real app over CDP with `--remote-debugging-port`, clicking real buttons — this is the established pattern from the workflow-registration run. Confirm routing by counting backend calls (ComfyUI `/history` prompt count, Forge port listener, zero OpenRouter calls) rather than trusting UI appearance.
- `harness.mjs` is DEPRECATED — use `npm run test:renderer`.

### Diagnose
- "Fix did nothing" → stale `dist/`. Rebuild, Ctrl+R.
- Trace an IPC channel across layers: search the channel name in `main.js`, `src/main/**`, `preload.js`, `src/api.js`.
- ComfyUI workflow issues → fetch the actual `/history` entry and compare against the intended `/prompt` body before touching conversion code.

### Never run
- Anything that reads out or transmits `or-key.bin` contents.
- Real OpenRouter chat calls from tests or verification loops.
- Long/paid generation runs (multi-minute Krea2 pipelines) without explicit user go-ahead.
- Broad `taskkill` on python.exe or electron.exe — the user may have Forge, ComfyUI, or another Electron app running for their own use. Kill only process trees your session spawned, and verify cleanup afterward (no stray listeners on 7860/8188).

## User data files
`conversations.json`, `settings.json`, `or-key.bin`, `allowed-files.json`. Before editing any save/load code, read the current on-disk shape (from a test copy) so writes preserve unknown keys. Test against copies, never the real files — the user's entire conversation history lives here.

## When blocked or uncertain — escalate, don't improvise
Stop and ask before proceeding if a fix seems to require:
- reshaping any storage file
- weakening CSP, sandbox, contextIsolation, or the preload surface
- changes to how `or-key.bin` is handled
- modifying a workflow JSON in `workflows/` (these are tuned artifacts; the established pattern is to adapt the APP to the file, not the file to the app)
- a refactor larger than the requested change
State what you found and 2-3 options. A stalled task is recoverable; a leaked API key or corrupted conversation history is not.

## Agent artifacts and scratch files
- Audit reports, findings lists, and ad-hoc plans go in `docs/agent/` — never the repo root. Create the directory on first use if it doesn't exist.
- `docs/superpowers/**` and `.superpowers/**` are managed by the superpowers plugin — do not put ad-hoc agent artifacts there, and do not move or rewrite what the plugin wrote.
- `HANDOFF.md` is the one exception: unattended runs replace it by convention, with the note that the prior version lives in git history (cite the commit).
- Verification images go to `D:\Devlopment\AI\IMG` (established convention); tell the user the filenames so they can delete at will.
- Delete temp files you created before finishing.

## Installed plugins/MCPs — when to use them
- **code-review plugin**: run for any change touching `main.js`, `preload.js`, `src/main/**`, `src/App.jsx`, or storage code before saying "done".
- **context7 MCP**: check BEFORE guessing at Electron, React 18, Vite, xterm.js, node-pty, or ComfyUI API behavior. The ComfyUI HTTP API (`/prompt`, `/object_info`, `/history`, `/interrupt`) and node-pty Windows quirks are exactly where stale training knowledge causes bugs.
- **playwright plugin/MCP**: for driving the real app over CDP in live verification (the established E2E pattern here).
- **security-guidance plugin**: consult when touching `preload.js`, CSP, IPC validation, the permissioned file-edit flow, or the terminal.
- **typescript-lsp plugin**: plain JS/JSX repo — useful for references/definitions when tracing IPC wiring. Do not suggest TypeScript migration.
- **firecrawl / frontend-design / superpowers / skill-creator**: only on explicit request. The app's look was settled in a deliberate redesign — do not restyle during bug fixes.

## Code-change rules

### 1. Prefer additive, low-risk changes
- Small, targeted fixes over broad refactors unless explicitly requested.
- Cross-process features: inspect all the layers involved — `main.js` / `src/main/**`, `preload.js`, `src/api.js`, and the consuming component.

### 2. Do not weaken security boundaries
- Keep contextIsolation, sandbox, and the strict CSP as they are.
- Validate new IPC inputs in main, not just the renderer.
- The permissioned file-edit flow (`allowed-files.json` + Apply/Dismiss cards) is a consent boundary: edits apply only to allowed paths and only on explicit user Apply. Never auto-apply, never widen the allow-list programmatically.
- The embedded terminal is arbitrary shell access by design — its power must stay behind the existing preload API, and terminal I/O must never be silently fed to models or persisted anywhere new.

### 3. Preserve storage compatibility
- No renaming, reshaping, or dropping unknown keys in the four storage files.
- Watch teardown/flush behavior when editing persistence.

### 4. Protect streaming performance
- Do not add per-chunk React state updates — everything funnels through the rAF batch.
- Do not put heavy parsing (markdown of the full transcript, zip work, image decode) in the streaming hot path.

## Important feature areas

### Chat / streaming (OpenRouter)
- SSE deltas → ref buffer → rAF flush → single setMessages per frame.
- Stop button aborts the in-flight request; regenerate/edit-last must preserve conversation persistence via the eager ref mirror.
- Web search rides OpenRouter plugins; model catalog and context budgets live in `src/models.js`.

### Image / video generation (two backends, one UI)
- The image-mode model list unifies Forge checkpoints and ComfyUI workflows; manifests drive the visible controls — surfacing a new workflow is a data drop, not a code change.
- `workflows/` accepts BOTH ComfyUI export formats: API format and the default Ctrl+S UI/graph format. UI-graph exports are converted at generate time by `uiGraphToApi` in `comfy-core.js`, using `/object_info` for positional widget→input mapping (which is why conversion happens when the server is up). The converter drops bypassed (mode 4) and muted (mode 2) nodes with link pass-through, drops notes, skips the seed `control_after_generate` slot, and preserves `_meta.title` for progress labels.
- A manifest may pin the result node via `"output": "<id>"` (`pickHistoryOutput`). Without it, output picking falls back to first-media-match across all outputs — do not rely on JS integer-key ordering.
- Manifest vocabulary: `label`, `backend` ("comfy"/Forge), `media`, `output`, `controls` (each: node, input, type, group, default/min/max/step).
- Seeds: exposing a sampler seed in a manifest exposes ONLY that node; other samplers keep their exported fixed seeds — and API-format execution does NOT apply `control_after_generate`, so "randomize" in the editor means nothing at runtime. Tuned pipelines depend on this.
- Both backend processes are app-managed: started on demand, stopped via the app's own Stop; after app quit there must be no stray python.exe and no listeners on 7860/8188.

### Embedded terminal
- node-pty + xterm.js; daemon covered by `npm run test:term`. Windows PTY behavior is subtle — process-tree cleanup matters.

### Permissioned file editing
- ```` ```edit path=… ```` blocks render read-only in the reply with an Apply/Dismiss card; applies gate on `allowed-files.json`.

## Testing expectations
- `npm test` → unit + terminal + renderer; `npm run test:ci` → build + full suite.
- Focused test for the area you changed; full suite for cross-cutting, storage, boot, or backend changes.
- When fixing a regression a static check could have caught (stale persist, streaming batching, conversion edge cases), add a test in the same change — the suite (63 unit / 21 terminal / 38 renderer at last count) only works as a regression net if it grows with the bugs.
- For generation features, UI appearance is not verification — count actual backend calls (`/history` prompts, port listeners, OpenRouter call count) like the workflow-registration run did.

## Fragile files and areas
- `src/App.jsx`: the eager ref mirror and rAF pipeline — easy to break subtly; symptoms show up only under streaming or on persist.
- `src/main/comfy-core.js`: format conversion trusts per-node input records over the links table (stale links exist in real exports); positional widget mapping depends on `/object_info`, and the objectInfoCache drops on server restart.
- `preload.js` / `src/api.js`: the security boundary and its single renderer touchpoint.
- `main.js`: storage, SSE plumbing, window lifecycle.
- `workflows/*.json`: tuned artifacts — treat as read-only data.

## Do not touch casually
- CSP, sandbox, contextIsolation, preload surface
- `or-key.bin` handling
- storage file shapes and their load/save paths
- the eager ref mirror and rAF streaming batch
- the file-edit consent flow and allow-list
- workflow JSONs and the UI-graph→API converter
- backend process start/stop and cleanup logic
- `vite.config.js` `base:'./'`

## Common failure playbook
- **"My fix did nothing"** → stale `dist/`. `npm run build`, Ctrl+R.
- **Saved conversation missing the latest messages** → something read React state instead of `messagesRef.current`.
- **UI stutters during streaming** → a per-chunk state update bypassed the rAF batch.
- **Script/feature silently dead in index.html** → CSP blocked an inline script; move it into the bundle.
- **ComfyUI rejects a workflow / wrong widget landed in wrong input** → UI-graph conversion issue; verify against `/object_info` for that node type, and check for bypassed-node link pass-through.
- **Wrong image surfaced (base instead of final)** → manifest missing `output` pin.
- **Same image every run despite "randomize" in the editor** → API execution ignores control_after_generate; expose the seed via manifest if variation is wanted.
- **Generation hangs with no progress** → distinguish model-load gaps (elapsed keeps ticking, node phase stalls — normal, Siax load took ~3 min) from a dead server (no /history entry).
- **Stray python.exe or port 7860/8188 listener after quit** → backend cleanup path regressed.

## Required checks before saying "done"
- State exactly what changed at a high level.
- Mention what tests were run, or explicitly say they were not run.
- Renderer change → confirm `dist/` was rebuilt.
- Storage/security/backend-process change → run the full suite and state compatibility/teardown implications.
- Generation change → verify by backend-call counts, not UI appearance.
- Confirm no stray processes/listeners if backends were started.
- Do not claim success from static inspection when a relevant test can run locally.

## Avoid these mistakes
- Do not treat this as a typical web app — Electron file:// loading, CSP, Windows PTY, and app-managed Python backends dominate the bug surface.
- Do not "clean up" the ref mirror, the rAF batch, or component-local state into something more idiomatic-looking.
- Do not modify workflow JSONs to fit the app; adapt the app to the file (established precedent).
- Do not let any code path touch `or-key.bin` contents beyond the existing load/use flow.
- Do not leave Forge/ComfyUI processes running after automated runs.