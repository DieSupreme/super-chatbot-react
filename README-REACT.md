# Super Chatbot — React Rebuild

Same app, same look, same features — but the renderer is now React 18 + Vite instead of one 1,256-line `index.html`. The Electron side (`main.js`, `preload.js`) is **unchanged**, and the storage format is byte-compatible: your existing `conversations.json`, `settings.json`, `or-key.bin`, and `allowed-files.json` all load as-is.

**For AI agents: operational rules, commands, and safety boundaries live in `CLAUDE.md`. This file is the feature/architecture reference. `HANDOFF.md` is per-run and transient.**

## Run it

```
npm install
npm start
```

The ZIP ships with a prebuilt `dist/`, so it runs immediately. After editing anything in `src/`:

```
npm run build     (one-off)
npm run watch     (rebuild on save — keep it running, then just reload the app with Ctrl+R)
```

`main.js` loads `dist/index.html` — the `src/` files are never loaded directly; Vite compiles the JSX into `dist/assets/`.

## Where everything went (vanilla → React)

| Vanilla (index.html) | React |
|---|---|
| Module-level `let history, currentId, pending…` | `useState` in `src/App.jsx` — all app state lives in one component |
| `$('log').appendChild(bubble)` + innerHTML | `messages` array state → `<ChatLog>` re-renders declaratively |
| `renderMarkdown()` building an HTML string | `src/markdown.jsx` parses into segments and returns real React elements |
| `codeRegistry` + re-wiring Copy/Save buttons | `<CodeBlock>` component — each holds its own `copied`/`saved` state |
| `wireMessageTools()` re-attaching listeners | Hover tools are just JSX inside `<MessageBubble>` — nothing to re-wire |
| onChunk appending to `el.textContent` | Chunks buffered in a ref, flushed once per animation frame into state |
| Manual show/hide of `#settingsPanel` etc. | Conditional rendering: `{open && <SettingsModal/>}` |
| Global `document.getElementById` everywhere | Props down, callbacks up; `useRef` for the few real DOM needs (focus, scroll) |

## The three React patterns worth studying in this codebase

**1. The eager ref mirror (`App.jsx`, top).** React state updates are asynchronous, but streaming/persist code needs to read the *current* message list right after writing it. `setMessages` computes the next array from `messagesRef.current` synchronously, stores it in the ref, then hands it to React. This is the single most important trick in the file — without it, `persistConvo` saved stale conversations (found and fixed by the test harness).

**2. rAF-batched streaming (`App.jsx`, chunk pipeline).** SSE deltas arrive far faster than you want React re-renders. `onChunk` appends to a plain object in a ref; one `requestAnimationFrame` callback drains it into a single `setMessages` per frame. Smooth streaming, no render storms.

**3. Component-local state (`markdown.jsx`, `ChatLog.jsx`).** "Copied ✓" feedback, edit-card Apply/Dismiss, sidebar rename — none of that touches App state. Each little component owns its own `useState`. That's the piece that replaces most of the vanilla build's manual DOM bookkeeping.

## File map

```
main.js                    Electron main process: IPC, storage, OpenRouter SSE, key handling
preload.js                 contextBridge API (the security boundary)
index.html                 Vite entry (CSP script-src 'self')
vite.config.js             base:'./' so Electron can load dist over file://
CLAUDE.md                  operational rules + safety boundaries for AI agents (auto-loaded)
workflows/                 ComfyUI workflow JSONs + .manifest.json pairs (+ gitignored
                           control-values / control-overrides / prompt-presets sidecars)
scripts/
  rebuild-node-pty.js      postinstall: rebuild node-pty against Electron's ABI
src/
  main.jsx                 createRoot bootstrap
  App.jsx                  state container: streaming, conversations, attachments, shortcuts
  api.js                   the one place window.api is touched (+ non-Electron stub)
  persist.js               conversation message (de)serialization helpers
  models.js                model catalog, context budgets, helpers
  markdown.jsx             fence/inline parser, <Markdown>, <CodeBlock>, syntax tint
  styles.css               the theme
  tokens.css               design tokens (achromatic palette, spacing, type scale)
  sd-utils.js              Forge/SD renderer-side helpers (reconcile, clamp, infotext)
  sd-schema.json           Forge request-field schema (shared main + renderer)
  sd-defaults.json         Forge default settings (shared main + renderer)
  main/
    sd.js                  Forge (Stable Diffusion WebUI) integration — port 7860
    sd-core.js             Forge spawn/kill, port probes, request-body sanitizer (pure logic)
    comfy.js               ComfyUI integration: process mgmt, generate, progress — port 8188
    comfy-core.js          UI-graph→API conversion, output picking, WS client (pure logic)
    gpu-lock.js            one-GPU mutual exclusion between Forge and ComfyUI
    sse.js                 streaming plumbing
  components/
    HeaderBar.jsx          model select, key chip, cost badge, toggles
    ConvoSidebar.jsx       chat list, search, rename, delete
    ChatLog.jsx            bubbles, think blocks, citations, edit cards, images, video, scroll
    Composer.jsx           attach bar + token budget, autosize textarea, Send/Stop
    SettingsModal.jsx      settings overlay
    Panels.jsx             allow-list panel, sys-prompt bar, toasts, drop zone
    SdPanel.jsx            image/video generation panel (unifies Forge + ComfyUI)
    SdMaskCanvas.jsx       inpaint mask editor
    VideoPanel.jsx         ComfyUI workflow body (controls, presets, drafts, live job)
    TerminalDock.jsx       terminal tab strip, launchers, per-instance working folder
    TerminalPanel.jsx      the xterm.js widget bound to a daemon session
  terminal/
    daemon.js              detached PTY daemon (owns sessions, outlives the app)
    daemon-client.js       main-process client for the daemon (spawn/connect/protocol)
    session-manager.js     PTY session lifecycle + reconnect ring buffer
    pty.js                 term:* IPC bridge to the daemon
    launchers.js           built-in launcher definitions (Claude, Cursor, …)
    protocol.js            wire protocol + pipe/lockfile path helpers
test/                      unit (node --test) + terminal + renderer (vitest) suites
```

`harness.mjs` was removed — the renderer smoke check lives in `test/renderer/app-smoke.test.jsx`.

## Image & video generation (Forge + ComfyUI)

Two app-managed local backends behind one unified image-mode model list:

- **Forge WebUI** (port 7860) serves SD-family checkpoints via `src/main/sd.js` (txt2img/img2img). The app starts and stops the Forge process itself.
- **ComfyUI** (port 8188) serves workflow-based generation — Krea2-architecture models (which Forge cannot load) and video — via `src/main/comfy.js`.

**Adding a workflow is a data drop, no code:** put `<name>.json` + `<name>.manifest.json` in `workflows/`. The manifest supplies `label`, `backend`, `media`, optional `output` (pins which node's files are THE result — don't rely on key ordering), and `controls` (each entry: node id, input name, type, group, default/min/max/step). Only manifest-listed controls appear in the UI; everything else in the workflow stays locked at its exported value.

**Both ComfyUI export formats work.** API-format ("Save (API format)") and the default Ctrl+S UI/graph export are both accepted; UI-graph files are converted at generate time (`uiGraphToApi` in `comfy-core.js`) using the server's `/object_info` for positional widget mapping. Bypassed/muted nodes and notes are dropped correctly; node titles are preserved so progress shows real names.

**Seed semantics:** exposing a seed in the manifest exposes only that node. Other samplers keep their exported fixed seeds, and API-format execution does **not** apply the editor's `control_after_generate: "randomize"` — tuned multi-sampler pipelines rely on this.

Stop is wired to ComfyUI's `/interrupt`; progress streams node-level phases with an elapsed counter (long silent stalls during model loads are normal — elapsed keeps ticking).

## Testing

```
npm test              # unit + terminal + renderer
npm run test:unit     # models, persist, sse, comfy-core
npm run test:term     # terminal daemon (node:test)
npm run test:renderer # vitest + jsdom
npm run test:watch    # vitest watch mode
npm run test:ci       # build + full suite (used in CI)
```

For live end-to-end verification of generation features, the established pattern is driving the real app over CDP (`--remote-debugging-port`) and confirming routing by backend call counts (`/history` prompts, port listeners, zero OpenRouter calls) — not by UI appearance.

## Small intentional differences (vs the vanilla build)

- ````edit path=…``` blocks now render as a labelled read-only block in the reply (the vanilla build showed them as raw text); the Apply/Dismiss card below works the same.
- CSP is stricter: the React bundle is an external file, so `unsafe-inline` scripts are no longer allowed.
- Everything else — shortcuts (Ctrl+N/K/, and Escape), memory/web/image toggles, drag-drop, paste-to-attach, zip download bar, stop button, regenerate/edit-last — behaves identically.
