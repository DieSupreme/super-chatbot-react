const { test } = require('node:test');
const assert = require('node:assert');
const { pipePath, lockfilePath, makeToken, encodeMessage, createDecoder } = require('../../src/terminal/protocol');

test('encodeMessage round-trips through a decoder', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  feed(encodeMessage({ t: 'hello', token: 'abc' }));
  feed(encodeMessage({ t: 'data', id: 3, data: 'eA==' }));
  assert.deepStrictEqual(got, [{ t: 'hello', token: 'abc' }, { t: 'data', id: 3, data: 'eA==' }]);
});

test('decoder reassembles messages split across chunks', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  const wire = encodeMessage({ t: 'x', n: 1 });
  feed(wire.slice(0, 4));
  feed(wire.slice(4));
  assert.deepStrictEqual(got, [{ t: 'x', n: 1 }]);
});

test('decoder skips blank lines and bad JSON without throwing', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  feed('\n');
  feed('not json\n');
  feed(encodeMessage({ t: 'ok' }));
  assert.deepStrictEqual(got, [{ t: 'ok' }]);
});

test('pipePath honors TERM_PIPE_NAME and is platform-shaped', () => {
  process.env.TERM_PIPE_NAME = 'unit-test-tag';
  const p = pipePath();
  delete process.env.TERM_PIPE_NAME;
  if (process.platform === 'win32') assert.ok(p.startsWith('\\\\.\\pipe\\'));
  assert.ok(p.includes('unit-test-tag'));
});

test('makeToken returns a long hex string, unique per call', () => {
  const a = makeToken(), b = makeToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(a, b);
});

test('lockfilePath joins under the given userData dir', () => {
  const p = lockfilePath('/tmp/ud');
  assert.ok(p.includes('ud'));
  assert.ok(p.endsWith('terminal-daemon.json'));
});
