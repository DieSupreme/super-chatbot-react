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

test('contextBudget gives DeepSeek its real ~128K window, not the 1M gemini tier', () => {
  // the over-budget attachment warning must fire where the API actually fails
  assert.equal(contextBudget('deepseek/deepseek-v4-pro'), 128000);
  assert.equal(contextBudget('deepseek/deepseek-v4-flash'), 128000);
});

test('fmtCost formats USD', () => {
  assert.equal(fmtCost(0.0123), '$0.0123');
  assert.equal(fmtCost(0), '$0.0000');
});
