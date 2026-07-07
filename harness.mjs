// jsdom smoke test for the built React renderer.
// Stubs window.api (the Electron preload bridge), mounts the app, then drives:
// boot → send → streamed reasoning + content chunks → finalize → markdown render.
import { JSDOM } from 'jsdom';
import fs from 'fs';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'file:///app/dist/index.html', pretendToBeVisual: true
});
const { window } = dom;
for (const k of ['window','document','navigator','HTMLElement','Element','Node','getComputedStyle',
  'requestAnimationFrame','cancelAnimationFrame','CustomEvent','Event','KeyboardEvent','MouseEvent','URL','FileReader',
  'MutationObserver','HTMLTextAreaElement','HTMLInputElement','HTMLIFrameElement','SVGElement','DocumentFragment',
  'Text','Comment','location','history','fetch']) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch (_) { try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); } catch (_) {} }
}
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

let chunkCb = null;
const calls = [];
const savedConvos = {};
window.api = {
  loadKey: async () => ({ ok: true, key: 'sk-or-v1-test' }),
  saveKey: async () => ({ ok: true, encrypted: true }),
  clearKey: async () => ({ ok: true }),
  getSettings: async () => ({ ok: true, settings: {} }),
  saveSettings: async () => ({ ok: true }),
  convoList: async () => ({ ok: true, list: Object.values(savedConvos).map(c => ({ id: c.id, title: c.title, model: c.model, cost: c.cost || 0, updated: c.updated || Date.now() })) }),
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
  onChunk: (cb) => { chunkCb = cb; },
  sendChat: async ({ messages, requestId }) => {
    calls.push(['sendChat', messages]);
    // stream a little reasoning, then content with markdown + two named code blocks + an edit block
    await tick(); chunkCb({ requestId, reasoning: 'thinking about it… ' });
    await tick(); chunkCb({ requestId, delta: 'Here is **bold** and `inline`.\n\n' });
    await tick(); chunkCb({ requestId, delta: '```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n' });
    await tick(); chunkCb({ requestId, delta: '```edit path=C:\\proj\\app.js\nnew contents\n```\n' });
    await tick();
    const full = 'Here is **bold** and `inline`.\n\n```js:one.js\nconst a = 1;\n```\n\n```py:two.py\nx = 2\n```\n```edit path=C:\\proj\\app.js\nnew contents\n```\n';
    return { ok: true, full, cost: 0.0123, tokens: { prompt: 10, completion: 20, total: 30 }, citations: [{ url: 'https://example.com/a', title: 'Example' }] };
  }
};

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const $ = sel => window.document.querySelector(sel);
const $$ = sel => [...window.document.querySelectorAll(sel)];
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failures++; };

// find the built JS asset
const asset = fs.readdirSync('dist/assets').find(f => f.endsWith('.js'));
await import('./dist/assets/' + asset);
// React flushes passive effects on its own scheduler in jsdom — poll for the
// boot sequence (key load → compact chip) instead of guessing a fixed delay.
for (let i = 0; i < 80; i++) {
  if ($$('header button').some(b => b.textContent.includes('Key ✓'))) break;
  await tick(25);
}

// ---- boot ----
check('app mounted (header renders)', !!$('header'));
check('key loaded → compact chip shown', $$('header button').some(b => b.textContent.includes('Key ✓')));
check('welcome empty state with starters', $$('.starter').length === 3);
check('model select has 6 options', $$('#model option').length === 6);

// ---- starter fills input ----
$('.starter').click(); await tick();
check('starter click fills the input', $('#input').value.includes('debounce'));

// ---- send a message ----
$('#input').value = '';
const inp = $('#input');
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(inp, 'hello world test');
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick();
$('#send').click();
await tick(400);   // full fake stream + finalize

check('user bubble rendered', $$('.msg.user').length === 1 && $('.msg.user .bubble').textContent.includes('hello world test'));
check('system prompt included allow-list path', calls.find(c => c[0] === 'sendChat')[1][0].content.includes('C:\\proj\\app.js'));
check('assistant bubble rendered with markdown bold', !!$('.msg.ai .md strong') && $('.msg.ai .md strong').textContent === 'bold');
check('inline code rendered', !!$('.msg.ai code.inline'));
check('think block rendered and collapsed after content', !!$('.think') && !$('.think').open);
check('two named code blocks', $$('.codeblock .cb-lang').filter(e => /one\.js|two\.py/.test(e.textContent)).length === 2);
check('zip bar appears for 2+ files', !!$('.zip-bar'));
check('edit card rendered with path', !!$('.edit-card') && $('.edit-card .ef').textContent.includes('C:\\proj\\app.js'));
check('citations rendered', !!$('.citations') && $('.cit-t').textContent === 'Example');
check('cost badge updated', $('#costBadge').textContent === '$0.0123');
check('convo persisted with correct shape', (() => {
  const c = Object.values(savedConvos)[0];
  return c && c.messages.length === 2 && c.messages[0].role === 'user' && typeof c.messages[1].content === 'string' && c.title.startsWith('hello world');
})());
check('regenerate / edit actions on last AI message', !!$('.msg-actions'));

// ---- edit card apply ----
$('.edit-card .actions button').click(); await tick();
check('edit card apply → saved state', $('.edit-card .actions').textContent.includes('Saved'));

// ---- new chat ----
$('#newChat').click(); await tick();
check('new chat clears log to empty state', $$('.msg').length === 0 && $('.empty h2').textContent === 'New chat');
check('sidebar lists the saved convo', $$('.convo-item').length === 1);

// ---- reopen saved convo ----
$('.convo-item .ct').click(); await tick(80);
check('reopened convo re-renders both turns', $$('.msg').length === 2 && !!$('.msg.ai .md'));

// ---- settings modal ----
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
await tick();
check('Ctrl+, opens settings', !!$('#settingsPanel'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await tick();
check('Escape closes settings', !$('#settingsPanel'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
