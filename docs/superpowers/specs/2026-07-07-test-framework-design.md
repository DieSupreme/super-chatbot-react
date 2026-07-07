# Test Framework Design

**Date:** 2026-07-07  
**Status:** Approved — pending implementation plan  
**Component:** Project-wide testing (`test/`, `package.json`, CI, selected `src/` extractions)

## Goal

Provide a unified, reliable test framework for Super Chatbot that:

1. Runs all meaningful automated tests with a single `npm test` command.
2. Covers the terminal daemon (already tested), renderer/React flows, and pure logic modules.
3. Gates pull requests via CI on Windows (where named-pipe terminal tests are authoritative).
4. Avoids flaky, slow Electron end-to-end tests in v1.

## Current State

| Layer | Today | Gap |
|-------|-------|-----|
| Terminal daemon | 21 tests via `node:test` + fake PTY (`npm run test:term`) | Not wired into a top-level `npm test` |
| React renderer | `harness.mjs` — jsdom smoke script with manual `check()` calls | Not in `package.json`; requires manual `node harness.mjs` after build |
| Main process | Nothing | SSE parsing, zip helpers, IPC untested |
| CI | None | No automated gate on push/PR |

**Established conventions to preserve:**

- Terminal tests use `node:test` + `node:assert` only — no new runtime deps for daemon tests.
- `node-pty` must never load under plain `node --test`; use `test/terminal/fake-pty.js`.
- Renderer already has `jsdom` as a devDependency.

## Approach

**Hybrid runner (recommended and approved):**

- **Vitest** — renderer and JSX tests (natural fit with Vite + React).
- **node:test** — terminal suite (unchanged) and new pure-JS unit tests.
- **Single orchestrator** — `npm test` runs all layers sequentially; any failure exits non-zero.

**Explicitly out of scope for v1:**

- Playwright / Spectron / real Electron E2E launches.
- Live OpenRouter API calls in tests.
- Coverage percentage gates.
- Full extraction/refactor of `main.js` for testability (only targeted pure helpers).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  npm test  (local + CI via npm run test:ci)             │
├─────────────────┬───────────────────┬─────────────────────┤
│  test:unit      │  test:renderer    │  test:term          │
│  node:test      │  vitest + jsdom   │  node:test (exist)  │
│  models,        │  markdown,        │  daemon, protocol,  │
│  persist,       │  App smoke flows, │  session-manager,   │
│  sse helpers    │  mock api         │  daemon-client      │
└─────────────────┴───────────────────┴─────────────────────┘
```

### Test layers

| Layer | Runner | Targets |
|-------|--------|---------|
| **Terminal** | `node:test` | `test/terminal/*` — no migration |
| **Unit** | `node:test` | `models.js`, extracted `persist.js`, extracted SSE parser |
| **Renderer** | Vitest + jsdom | `markdown.jsx`, `App.jsx` smoke (port of `harness.mjs`) |
| **CI** | GitHub Actions | `npm ci` → `npm run test:ci` on `windows-latest` |

## Directory Layout

```
test/
  terminal/              # existing — unchanged
    fake-pty.js
    protocol.test.js
    session-manager.test.js
    daemon.test.js
    daemon-client.test.js
  unit/                  # new — node:test
    models.test.js
    persist.test.js      # after extracting from App.jsx
    sse.test.js          # after extracting from main.js
  renderer/              # new — vitest
    setup.js             # jsdom globals, rAF shim
    helpers/
      mock-api.js        # shared window.api stub (from harness.mjs)
    markdown.test.jsx
    app-smoke.test.jsx   # port of harness.mjs checks

vitest.config.js         # vitest + @vitejs/plugin-react, jsdom environment
scripts/
  test-all.js            # optional: orchestrate all suites, aggregate exit code
```

`harness.mjs` is deprecated after port; remove or leave a one-line redirect to `npm run test:renderer` in a follow-up.

## npm Scripts

```json
{
  "test": "npm run test:unit && npm run test:term && npm run test:renderer",
  "test:unit": "node --test test/unit/*.test.js",
  "test:term": "node --test test/terminal/*.test.js",
  "test:renderer": "vitest run",
  "test:watch": "vitest",
  "test:ci": "npm run build && npm test"
}
```

**Renderer import strategy:** Vitest imports from `src/` directly (e.g. `src/App.jsx`), not `dist/`. This removes the build dependency for day-to-day renderer tests. `test:ci` still runs `build` first to catch Vite production bundle errors.

## Shared Test Utilities

### `test/renderer/helpers/mock-api.js`

Extracted from `harness.mjs`:

- Configurable `sendChat` with fake streaming via `onChunk`.
- In-memory `savedConvos` and `calls` spy array.
- Stubs for key, settings, allow-list, file ops.
- `term` stub object for future terminal UI tests (create, write, list, onData disposer pattern).

### `test/terminal/fake-pty.js`

Keep unchanged — already injectable via `TERM_FAKE_PTY`.

### Main-process testability

Extract small **pure** functions from `main.js` into testable modules:

| Module | Functions | Rationale |
|--------|-----------|-----------|
| `src/main/sse.js` (or `lib/sse.js`) | `processSseLine`, `drainSseBuffer` | Recent production bug; high value |
| `src/persist.js` | `stripContentForPersist`, `toPersistedMessage` | Currently inline in `App.jsx`; needed for persist regression tests |

IPC handlers (`ipcMain.handle(...)`) remain integration-tested only indirectly via renderer smoke tests in v1. No Electron mock framework in v1.

## Test Priority Matrix

| Priority | Target | Runner |
|----------|--------|--------|
| **P0** | Wire existing `test:term` into `npm test` | — |
| **P0** | Port `harness.mjs` → `test/renderer/app-smoke.test.jsx` | Vitest |
| **P1** | `models.js` — `extractText`, `contextBudget`, `modelLabel`, `fmtCost` | node:test |
| **P1** | `markdown.jsx` — `parseSegments`, `guessFilename`, `highlight` (XSS: escaped before spans) | Vitest |
| **P1** | `persist.js` — strip images, preserve attachNames/reasoning/citations shape | node:test |
| **P2** | `sse.js` — final buffer flush, usage/cost extraction from SSE lines | node:test |
| **P2** | `Composer`, `ChatLog` isolated component tests | Vitest |
| **P3** | Zip read/write helpers from `main.js` | node:test |
| **Skip** | Live OpenRouter, real `node-pty` under plain node, Electron E2E | — |

## CI

**File:** `.github/workflows/test.yml`

```yaml
name: Test
on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run test:ci
```

**Why Windows:** Terminal daemon tests use `\\.\pipe\` named pipes. Protocol and session-manager tests pass on Linux, but pipe integration tests are authoritative on Windows — matching the app's primary platform.

## Dev Dependencies (new)

| Package | Purpose |
|---------|---------|
| `vitest` | Renderer + JSX test runner (integrates with existing Vite config) |
| `@testing-library/react` | Optional P2 — prefer for component queries over raw `querySelector` |

No new **runtime** dependencies. Terminal tests remain `node:test` only.

## Conventions

1. **Naming:** `*.test.js` for node:test; `*.test.jsx` for Vitest.
2. **No live network** — mock `fetch` when testing main helpers that call HTTP.
3. **Fake PTY only** under plain Node — never `require('node-pty')` in `node --test`.
4. **Renderer tests import `src/`** — not production `dist/` bundles.
5. **Failures propagate** — `npm test` exits 1 if any layer fails.
6. **Async streaming tests** — use Vitest fake timers or small `tick()` helper (25ms from harness).
7. **One assertion style per runner** — `node:assert` in node:test; `expect` from vitest in renderer tests.

## Error Handling in Tests

- Terminal daemon tests: boot isolated daemon per test with unique `TERM_PIPE_NAME` tag (existing pattern).
- Renderer smoke: poll for async React effects (existing harness pattern — boot key chip within 80 × 25ms).
- CI: `npm run test:ci` fails on build errors before running tests.

## Success Criteria

1. `npm test` runs all three layers and passes locally on Windows.
2. `harness.mjs` checks are reproduced in Vitest (≥ same coverage as current 23 checks).
3. New unit tests cover `models.js`, `persist.js`, and SSE parser.
4. GitHub Actions runs `test:ci` on push/PR to main.
5. No regression in existing 21 terminal tests.

## Migration Notes

- `README-REACT.md` — update testing section to reference `npm test` instead of `node harness.mjs`.
- `package.json` — add scripts and `vitest` devDependency.
- `App.jsx` — import persist helpers from `src/persist.js` (thin re-export or direct import).
- `main.js` — import SSE helpers from extracted module; behavior unchanged.

## Future (post-v1)

- `@testing-library/react` for richer component tests.
- Optional Ubuntu CI job for protocol/unit-only (faster feedback, no pipe tests).
- Coverage reporting (informational, not gated).
- Electron E2E only if smoke + integration prove insufficient.
