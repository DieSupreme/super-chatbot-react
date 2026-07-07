# Super Chatbot — React Rebuild (v3.0.0)

Same app, same look, same features — but the renderer is now React 18 + Vite instead of one 1,256-line `index.html`. The Electron side (`main.js`, `preload.js`) is **unchanged**, and the storage format is byte-compatible: your existing `conversations.json`, `settings.json`, `or-key.bin`, and `allowed-files.json` all load as-is.

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
main.js                    Electron main process (unchanged)
preload.js                 contextBridge API (unchanged)
index.html                 Vite entry (CSP now script-src 'self' — stricter than before)
vite.config.js             base:'./' so Electron can load dist over file://
src/
  main.jsx                 createRoot bootstrap
  App.jsx                  state container: streaming, conversations, attachments, shortcuts
  api.js                   the one place window.api is touched
  models.js                model catalog, context budgets, helpers
  markdown.jsx             fence/inline parser, <Markdown>, <CodeBlock>, syntax tint
  styles.css               the theme, ported verbatim
  components/
    HeaderBar.jsx          model select, key chip, cost badge, toggles
    ConvoSidebar.jsx       chat list, search, rename, delete
    ChatLog.jsx            bubbles, think blocks, citations, edit cards, zip bar, scroll
    Composer.jsx           attach bar + token budget, autosize textarea, Send/Stop
    SettingsModal.jsx      settings overlay
    Panels.jsx             allow-list panel, sys-prompt bar, toasts, drop zone
harness.mjs                jsdom smoke test (23 checks) — run with: node harness.mjs
```

## Small intentional differences

- ````edit path=…``` blocks now render as a labelled read-only block in the reply (the vanilla build showed them as raw text); the Apply/Dismiss card below works the same.
- CSP is stricter: the React bundle is an external file, so `unsafe-inline` scripts are no longer allowed.
- Everything else — shortcuts (Ctrl+N/K/, and Escape), memory/web/image toggles, drag-drop, paste-to-attach, zip download bar, stop button, regenerate/edit-last — behaves identically.
