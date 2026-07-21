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

test('processLine captures a mid-stream error frame (first error wins)', () => {
  const state = createSseState();
  state.processLine('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }));
  state.processLine('data: ' + JSON.stringify({ error: { message: 'rate limited', code: 429 } }));
  state.processLine('data: ' + JSON.stringify({ error: { message: 'second error' } }));
  assert.equal(state.error, 'rate limited');
  // content that streamed before the error is still accumulated; the caller
  // decides to surface the error rather than the truncated content
  assert.equal(state.full, 'partial');
});

test('processLine accepts a string-form error', () => {
  const state = createSseState();
  state.processLine('data: ' + JSON.stringify({ error: 'moderation_blocked' }));
  assert.equal(state.error, 'moderation_blocked');
});

test('processLine leaves error null on a clean stream', () => {
  const state = createSseState();
  state.processLine('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }));
  assert.equal(state.error, null);
});

test('processLine dedupes url citations', () => {
  const state = createSseState();
  const payload = { choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A' } }] } }] };
  state.processLine('data: ' + JSON.stringify(payload));
  state.processLine('data: ' + JSON.stringify(payload));
  assert.equal(state.citations.length, 1);
  assert.equal(state.citations[0].url, 'https://a.com');
});
