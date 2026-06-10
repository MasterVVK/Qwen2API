const test = require('node:test');
const assert = require('node:assert/strict');

const { detectTruncation } = require('../src/utils/truncation.js');

test('detectTruncation: null/empty content is not truncated', () => {
  assert.equal(detectTruncation(''), null);
  assert.equal(detectTruncation(null), null);
  assert.equal(detectTruncation(undefined), null);
});

test('detectTruncation: plain answer without thinking is not truncated', () => {
  assert.equal(detectTruncation('просто ответ без think-блока'), null);
});

test('detectTruncation: properly closed think block is not truncated', () => {
  assert.equal(detectTruncation('<think>рассуждение</think>\nфинальный ответ'), null);
});

test('detectTruncation: unclosed think block is flagged', () => {
  assert.deepEqual(
    detectTruncation('<think>рассуждение без закрытия'),
    { reason: 'thinking_truncated' }
  );
});

test('detectTruncation: second think section left open is flagged', () => {
  assert.deepEqual(
    detectTruncation('<think>a</think>\nответ\n<think>b'),
    { reason: 'thinking_truncated' }
  );
});

test('detectTruncation: two fully-closed think sections are fine', () => {
  assert.equal(detectTruncation('<think>a</think>txt<think>b</think>x'), null);
});
