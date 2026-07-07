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
