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
