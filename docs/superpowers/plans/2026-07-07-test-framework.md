# Test Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified `npm test` covering terminal daemon, pure unit logic, and renderer smoke tests, with Windows CI.

**Architecture:** Hybrid runners — `node:test` for terminal (unchanged) and unit tests; Vitest + jsdom for renderer/JSX. Extract pure helpers (`persist.js`, `sse.js`) from `App.jsx` / `main.js` for testability. Single `npm test` orchestrates all layers.

**Tech Stack:** Node `node:test` + `node:assert`, Vitest, jsdom (existing), `@testing-library/react`, Vite (`@vitejs/plugin-react` existing). No new runtime dependencies.

## Global Constraints

- Terminal tests: `node:test` + `node:assert` only; never `require('node-pty')` under plain `node` — use `test/terminal/fake-pty.js`.
- Renderer tests import from `src/`, not `dist/`.
- `npm test` exits non-zero if any layer fails.
- No live OpenRouter / network calls in tests.
- CI runs on `windows-latest`, Node 20, `npm run test:ci` (`build` then `npm test`).
- Naming: `*.test.js` / `*.test.mjs` for node:test; `*.test.jsx` for Vitest.
- ESM unit tests that import `src/*.js` use `.mjs` extension (package is CJS at root).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json` | Scripts: `test`, `test:unit`, `test:term`, `test:renderer`, `test:watch`, `test:ci`; devDeps: `vitest`, `@testing-library/react` |
| `vitest.config.js` | Vitest + React plugin, jsdom, setup file |
| `src/persist.js` | `stripContentForPersist`, `toPersistedMessage` (ESM) |
| `src/main/sse.js` | `parseSseLine`, `drainSseBuffer`, `createSseState` (CJS for `main.js`) |
| `test/unit/models.test.mjs` | Unit tests for `src/models.js` |
| `test/unit/persist.test.mjs` | Unit tests for `src/persist.js` |
| `test/unit/sse.test.js` | Unit tests for `src/main/sse.js` |
| `test/renderer/setup.js` | jsdom rAF shim |
| `test/renderer/helpers/mock-api.js` | Shared `window.api` stub |
| `test/renderer/markdown.test.jsx` | `parseSegments`, `highlight` tests |
| `test/renderer/app-smoke.test.jsx` | Port of `harness.mjs` |
| `.github/workflows/test.yml` | Windows CI |
| `main.js` | Import SSE module instead of inline helpers |
| `src/App.jsx` | Import from `src/persist.js` |
| `README-REACT.md` | Document `npm test` |
| `harness.mjs` | Deprecate → thin redirect |

---

## Task 1: Tooling scaffold (Vitest + npm scripts)

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `test/renderer/setup.js`
- Create: `test/unit/.gitkeep` (removed when first unit test lands)

**Interfaces:**
- Produces: npm scripts `test`, `test:unit`, `test:term`, `test:renderer`, `test:watch`, `test:ci`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install --save-dev vitest @testing-library/react @testing-library/dom
```

- [ ] **Step 2: Add scripts to `package.json`**

Add inside `"scripts"`:

```json
"test": "npm run test:unit && npm run test:term && npm run test:renderer",
"test:unit": "node --test test/unit/*.test.js test/unit/*.test.mjs",
"test:renderer": "vitest run",
"test:watch": "vitest",
"test:ci": "npm run build && npm test"
```

(`test:term` already exists — leave unchanged.)

- [ ] **Step 3: Create `vitest.config.js`**

```javascript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/renderer/setup.js'],
    include: ['test/renderer/**/*.test.{js,jsx}'],
  },
});
```

- [ ] **Step 4: Create `test/renderer/setup.js`**

```javascript
// jsdom lacks rAF timing the app expects during streaming flushes.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
```

- [ ] **Step 5: Verify terminal tests still pass**

Run: `npm run test:term`  
Expected: 21 tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js test/renderer/setup.js
git commit -m "chore(test): add vitest scaffold and unified npm test scripts"
```

---

## Task 2: Unit tests for `models.js`

**Files:**
- Create: `test/unit/models.test.mjs`

**Interfaces:**
- Consumes: `extractText`, `modelLabel`, `contextBudget`, `fmtCost` from `src/models.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/models.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, modelLabel, contextBudget, fmtCost } from '../../src/models.js';

test('extractText returns string content as-is', () => {
  assert.equal(extractText('hello'), 'hello');
});

test('extractText joins text parts and skips images', () => {
  const content = [
    { type: 'text', text: 'see this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
  ];
  assert.equal(extractText(content), 'see this');
});

test('extractText returns (attachment) when only images', () => {
  assert.equal(extractText([{ type: 'image_url', image_url: { url: 'x' } }]), '(attachment)');
});

test('modelLabel resolves known id', () => {
  assert.equal(modelLabel('openai/gpt-5.5'), 'GPT-5.5');
});

test('modelLabel falls back to raw id', () => {
  assert.equal(modelLabel('unknown/model'), 'unknown/model');
});

test('contextBudget returns tiered values', () => {
  assert.equal(contextBudget('google/gemini-3.1-pro-preview'), 900000);
  assert.equal(contextBudget('anthropic/claude-opus-4.8'), 180000);
  assert.equal(contextBudget('x-ai/grok-4.3'), 120000);
});

test('fmtCost formats USD', () => {
  assert.equal(fmtCost(0.0123), '$0.0123');
  assert.equal(fmtCost(0), '$0.0000');
});
```

- [ ] **Step 2: Run test to verify it passes (no impl change needed)**

Run: `node --test test/unit/models.test.mjs`  
Expected: PASS — all 7 tests.

- [ ] **Step 3: Commit**

```bash
git add test/unit/models.test.mjs
git commit -m "test(unit): add models.js unit tests"
```

---

## Task 3: Extract `persist.js` + unit tests

**Files:**
- Create: `src/persist.js`
- Modify: `src/App.jsx` (remove inline helpers, import from `persist.js`)
- Create: `test/unit/persist.test.mjs`

**Interfaces:**
- Produces:
  - `stripContentForPersist(content: string | array): string | array`
  - `toPersistedMessage(m: object): { role, content, attachNames?, reasoning?, citations? }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/persist.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripContentForPersist, toPersistedMessage } from '../../src/persist.js';

test('stripContentForPersist removes image_url parts', () => {
  const content = [
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZZ' } }
  ];
  assert.equal(stripContentForPersist(content), 'hi');
});

test('stripContentForPersist returns marker when only images', () => {
  const content = [{ type: 'image_url', image_url: { url: 'x' } }];
  assert.equal(stripContentForPersist(content), '(image attachment)');
});

test('toPersistedMessage keeps metadata fields', () => {
  const m = {
    role: 'assistant',
    content: 'answer',
    reasoning: 'thought',
    citations: [{ url: 'https://example.com', title: 'Ex' }],
    attachNames: ['a.png']
  };
  const out = toPersistedMessage(m);
  assert.deepEqual(out, {
    role: 'assistant',
    content: 'answer',
    attachNames: ['a.png'],
    reasoning: 'thought',
    citations: [{ url: 'https://example.com', title: 'Ex' }]
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/persist.test.mjs`  
Expected: FAIL — cannot find module `../../src/persist.js`

- [ ] **Step 3: Create `src/persist.js`**

```javascript
// Conversation persistence helpers — strip bulky image data before writing JSON.

export function stripContentForPersist(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const parts = content.filter(p => p.type !== 'image_url');
  if (!parts.length) return '(image attachment)';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

export function toPersistedMessage(m) {
  const out = { role: m.role, content: stripContentForPersist(m.content) };
  if (m.attachNames?.length) out.attachNames = m.attachNames;
  if (m.reasoning) out.reasoning = m.reasoning;
  if (m.citations?.length) out.citations = m.citations;
  return out;
}
```

- [ ] **Step 4: Update `src/App.jsx`**

Remove lines 19–34 (`stripContentForPersist` / `toPersistedMessage`). Add import:

```javascript
import { toPersistedMessage } from './persist.js';
```

(`persistConvo` already calls `toPersistedMessage` — no other changes.)

- [ ] **Step 5: Run tests**

Run: `node --test test/unit/persist.test.mjs`  
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/persist.js src/App.jsx test/unit/persist.test.mjs
git commit -m "refactor: extract persist helpers and add unit tests"
```

---

## Task 4: Extract SSE parser + unit tests

**Files:**
- Create: `src/main/sse.js`
- Modify: `main.js` (use extracted module)
- Create: `test/unit/sse.test.js`

**Interfaces:**
- Produces:
  - `createSseState(): { full: string, usage: object|null, citations: array, processLine(line: string): void }`
  - `drainSseBuffer(buf: string, consumeAll: boolean, processLine: (line: string) => void): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/sse.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSseState, drainSseBuffer } = require('../../src/main/sse.js');

test('processLine accumulates content delta', () => {
  const state = createSseState();
  state.processLine('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }));
  assert.equal(state.full, 'hi');
});

test('processLine captures usage.cost', () => {
  const state = createSseState();
  state.processLine('data: ' + JSON.stringify({ usage: { cost: 0.01, prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
  assert.equal(state.usage.cost, 0.01);
});

test('drainSseBuffer keeps partial line unless consumeAll', () => {
  const state = createSseState();
  const rest = drainSseBuffer('data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":', false, (l) => state.processLine(l));
  assert.equal(state.full, 'a');
  assert.ok(rest.includes('"delta"'));
});

test('drainSseBuffer with consumeAll processes final partial line', () => {
  const state = createSseState();
  let buf = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'end' } }] });
  buf = drainSseBuffer(buf, false, (l) => state.processLine(l));
  drainSseBuffer(buf, true, (l) => state.processLine(l));
  assert.equal(state.full, 'end');
});

test('processLine dedupes url citations', () => {
  const state = createSseState();
  const payload = { choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A' } }] } }] };
  state.processLine('data: ' + JSON.stringify(payload));
  state.processLine('data: ' + JSON.stringify(payload));
  assert.equal(state.citations.length, 1);
  assert.equal(state.citations[0].url, 'https://a.com');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/sse.test.js`  
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/sse.js`**

```javascript
// Pure SSE line parsing for OpenRouter chat streaming (testable without Electron).

function createSseState() {
  const state = { full: '', usage: null, citations: [] };
  state.processLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      const d = json.choices?.[0]?.delta || {};
      if (d.reasoning) state._lastReasoning = d.reasoning;
      if (d.content) state.full += d.content;
      const anns = d.annotations || json.choices?.[0]?.message?.annotations;
      if (Array.isArray(anns)) {
        for (const a of anns) {
          if (a.type === 'url_citation' && a.url_citation) {
            const u = a.url_citation.url;
            if (u && !state.citations.find(c => c.url === u)) {
              state.citations.push({ url: u, title: a.url_citation.title || u });
            }
          }
        }
      }
      if (json.usage) state.usage = json.usage;
    } catch (_) {}
  };
  return state;
}

function drainSseBuffer(buf, consumeAll, processLine) {
  const lines = buf.split('\n');
  const rest = consumeAll ? '' : (lines.pop() ?? '');
  for (const line of lines) processLine(line);
  return rest;
}

module.exports = { createSseState, drainSseBuffer };
```

- [ ] **Step 4: Refactor `main.js` chat handler**

At top of `main.js` add:

```javascript
const { createSseState, drainSseBuffer } = require('./src/main/sse.js');
```

Replace the inline `processSseLine` / `drainSseBuffer` / mutable `full`, `usage`, `citations` in `chat:send` with:

```javascript
const sse = createSseState();
const processLine = (line) => {
  sse.processLine(line);
  // side effects for renderer streaming (keep existing behavior)
  const t = line.trim();
  if (!t.startsWith('data:')) return;
  const data = t.slice(5).trim();
  if (data === '[DONE]') return;
  try {
    const json = JSON.parse(data);
    const d = json.choices?.[0]?.delta || {};
    if (d.reasoning) win.webContents.send('chat:chunk', { requestId, reasoning: d.reasoning });
    if (d.content) win.webContents.send('chat:chunk', { requestId, delta: d.content });
  } catch (_) {}
};
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  buffer = drainSseBuffer(buffer, false, processLine);
}
buffer += decoder.decode();
drainSseBuffer(buffer, true, processLine);
const full = sse.full;
const usage = sse.usage;
const citations = sse.citations;
```

(Remove old inline `processSseLine` / `drainSseBuffer` / `full`/`usage`/`citations` declarations.)

- [ ] **Step 5: Run tests**

Run: `node --test test/unit/sse.test.js`  
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/sse.js main.js test/unit/sse.test.js
git commit -m "refactor: extract SSE parser and add unit tests"
```

---

## Task 5: Renderer mock API helper

**Files:**
- Create: `test/renderer/helpers/mock-api.js`

**Interfaces:**
- Produces:
  - `createMockApi(): { api: object, calls: array, savedConvos: object, tick: (ms?) => Promise<void> }`

- [ ] **Step 1: Create `test/renderer/helpers/mock-api.js`**

Port from `harness.mjs` — export factory:

```javascript
export function createMockApi() {
  const calls = [];
  const savedConvos = {};
  let chunkCb = null;
  const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

  const api = {
    loadKey: async () => ({ ok: true, key: 'sk-or-v1-test' }),
    saveKey: async () => ({ ok: true, encrypted: true }),
    clearKey: async () => ({ ok: true }),
    getSettings: async () => ({ ok: true, settings: {} }),
    saveSettings: async () => ({ ok: true }),
    convoList: async () => ({
      ok: true,
      list: Object.values(savedConvos).map(c => ({
        id: c.id, title: c.title, model: c.model, cost: c.cost || 0, updated: c.updated || Date.now()
      }))
    }),
    convoGet: async (id) => savedConvos[id] ? { ok: true, convo: savedConvos[id] } : { ok: false },
    convoSave: async (c) => { c.updated = Date.now(); savedConvos[c.id] = c; calls.push(['convoSave', c]); return { ok: true }; },
    convoDelete: async (id) => { delete savedConvos[id]; return { ok: true }; },
    allowList: async () => ({ ok: true, paths: ['C:\\proj\\app.js'] }),
    allowAdd: async () => ({ ok: true, paths: [] }),
    allowRemove: async () => ({ ok: true, paths: [] }),
    pickFiles: async () => ({ ok: true, files: [] }),
    readFiles: async () => ({ ok: true, files: [] }),
    getPathForFile: () => null,
    writeFile: async () => ({ ok: true }),
    saveAs: async () => ({ ok: true, path: 'x' }),
    saveZip: async (p) => ({ ok: true, count: p.files.length }),
    generateImage: async () => ({ ok: true, b64: 'aGk=', mime: 'image/png', cost: 0.01 }),
    saveImage: async () => ({ ok: true }),
    stopChat: async () => ({ ok: true }),
    onChunk: (cb) => { chunkCb = cb; return () => { if (chunkCb === cb) chunkCb = null; }; },
    sendChat: async ({ messages, requestId }) => {
      calls.push(['sendChat', messages]);
      await tick();
      chunkCb?.({ requestId, reasoning: 'thinking about it… ' });
      await tick();
      chunkCb?.({ requestId, delta: 'Here is **bold** and `inline`.\n\n' });
      await tick();
      chunkCb?.({ requestId, delta: '```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n' });
      await tick();
      chunkCb?.({ requestId, delta: '```edit path=C:\\proj\\app.js\nnew contents\n```\n' });
      await tick();
      const full = 'Here is **bold** and `inline`.\n\n```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n```edit path=C:\\proj\\app.js\nnew contents\n```\n';
      return { ok: true, full, cost: 0.0123, tokens: { prompt: 10, completion: 20, total: 30 }, citations: [{ url: 'https://example.com/a', title: 'Example' }] };
    },
    readClipboard: () => '',
    writeClipboard: () => {},
    term: {
      create: async () => ({ ok: true, id: 1, cwd: '', cwdFallback: false }),
      reattach: async () => ({ ok: true, ring: '' }),
      write: () => {},
      resize: () => {},
      kill: async () => ({ ok: true }),
      detach: () => {},
      list: async () => ({ ok: true, sessions: [] }),
      setPinned: async () => ({ ok: true }),
      quitAll: async () => ({ ok: true }),
      pickFolder: async () => ({ ok: false, canceled: true }),
      pathExists: async () => ({ ok: true, exists: false }),
      onData: () => () => {},
      onExit: () => () => {}
    }
  };

  return { api, calls, savedConvos, tick };
}
```

- [ ] **Step 2: Commit**

```bash
git add test/renderer/helpers/mock-api.js
git commit -m "test(renderer): add shared mock-api helper"
```

---

## Task 6: Markdown unit tests (Vitest)

**Files:**
- Create: `test/renderer/markdown.test.jsx`

- [ ] **Step 1: Write tests**

```javascript
import { describe, it, expect } from 'vitest';
import { parseSegments, guessFilename, highlight } from '../../src/markdown.jsx';

describe('parseSegments', () => {
  it('parses code blocks with filename', () => {
    const segs = parseSegments('```js:app.js\nconst x = 1;\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('code');
    expect(segs[0].fname).toBe('app.js');
    expect(segs[0].raw).toBe('const x = 1;');
  });

  it('parses edit blocks', () => {
    const segs = parseSegments('```edit path=C:\\proj\\a.js\nnew\n```');
    expect(segs[0].kind).toBe('edit');
    expect(segs[0].path).toBe('C:\\proj\\a.js');
  });
});

describe('guessFilename', () => {
  it('reads leading comment filename', () => {
    expect(guessFilename('js', '// app.js\nconst x = 1')).toBe('app.js');
  });
});

describe('highlight', () => {
  it('escapes HTML before adding spans', () => {
    const html = highlight('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run**

Run: `npm run test:renderer`  
Expected: PASS — 4 tests.

- [ ] **Step 3: Commit**

```bash
git add test/renderer/markdown.test.jsx
git commit -m "test(renderer): add markdown parser unit tests"
```

---

## Task 7: App smoke tests (port `harness.mjs`)

**Files:**
- Create: `test/renderer/app-smoke.test.jsx`
- Modify: `harness.mjs` (deprecation comment at top)

**Interfaces:**
- Consumes: `createMockApi()` from `test/renderer/helpers/mock-api.js`

- [ ] **Step 1: Write `test/renderer/app-smoke.test.jsx`**

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App.jsx';
import { createMockApi } from './helpers/mock-api.js';

describe('App smoke', () => {
  let mock;
  beforeEach(() => {
    mock = createMockApi();
    window.api = mock.api;
  });

  it('boots and shows key chip', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Key ✓/)).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: /Write a debounce/i })).toHaveLength(1);
  });

  it('sends a message and renders markdown + edit card + citations', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    const input = screen.getByPlaceholderText(/Type a message/i);
    fireEvent.change(input, { target: { value: 'hello world test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(/hello world test/)).toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText('bold')).toBeInTheDocument());
    expect(screen.getByText(/Sources/i)).toBeInTheDocument();
    expect(screen.getByText(/proposed edit/i)).toBeInTheDocument();
    expect(mock.calls.some(c => c[0] === 'sendChat')).toBe(true);
    const convo = Object.values(mock.savedConvos)[0];
    expect(convo?.messages?.length).toBe(2);
  });

  it('opens and closes settings with keyboard', async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Key ✓/));
    fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    expect(await screen.findByText('Settings')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Done')).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run renderer tests**

Run: `npm run test:renderer`  
Expected: PASS — markdown + smoke tests.

- [ ] **Step 3: Deprecate `harness.mjs`**

Replace first line comment block with:

```javascript
// DEPRECATED — use `npm run test:renderer` instead.
// This file is kept temporarily for reference; it will be removed in a follow-up.
```

- [ ] **Step 4: Run full suite**

Run: `npm test`  
Expected: unit + term + renderer all pass.

- [ ] **Step 5: Commit**

```bash
git add test/renderer/app-smoke.test.jsx harness.mjs
git commit -m "test(renderer): port harness smoke checks to vitest"
```

---

## Task 8: CI + docs

**Files:**
- Create: `.github/workflows/test.yml`
- Modify: `README-REACT.md`

- [ ] **Step 1: Create `.github/workflows/test.yml`**

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

- [ ] **Step 2: Update `README-REACT.md` testing section**

Replace `node harness.mjs` reference with:

```markdown
## Testing

npm test              # unit + terminal + renderer
npm run test:unit     # models, persist, sse
npm run test:term     # terminal daemon (node:test)
npm run test:renderer # vitest + jsdom
npm run test:watch    # vitest watch mode
npm run test:ci       # build + full suite (used in CI)
```

- [ ] **Step 3: Run CI script locally**

Run: `npm run test:ci`  
Expected: build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml README-REACT.md
git commit -m "ci: add Windows test workflow and document npm test"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|------------------|------|
| Unified `npm test` | Task 1 |
| Vitest renderer tests | Tasks 1, 6, 7 |
| node:test unit tests | Tasks 2, 3, 4 |
| Terminal suite unchanged | Task 1 verifies |
| Port harness.mjs | Task 7 |
| Extract persist.js | Task 3 |
| Extract sse.js | Task 4 |
| mock-api helper | Task 5 |
| GitHub Actions Windows CI | Task 8 |
| README update | Task 8 |
| No E2E / no live APIs | Global constraints |
| Success: 21 terminal tests pass | Task 1, 7, 8 |

## Placeholder Scan

No TBD/TODO entries. All steps include concrete file paths, code, and run commands.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-test-framework.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — implement tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
