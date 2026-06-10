const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBlock } = require('../src/utils/captcha-trigger.js');

test('detectBlock: clean text returns null', () => {
  assert.equal(detectBlock('data: {"choices":[{"delta":{"content":"hi"}}]}'), null);
  assert.equal(detectBlock(''), null);
  assert.equal(detectBlock(null), null);
});

test('detectBlock: slide-captcha is detected and URL extracted/normalised', () => {
  const raw = JSON.stringify({
    ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'],
    data: { url: 'https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=abc' },
  });
  const r = detectBlock(raw);
  assert.equal(r.kind, 'slide-captcha');
  // host:443 stripped and //api collapsed to /api
  assert.ok(r.url.startsWith('https://chat.qwen.ai/api/'), `got ${r.url}`);
  assert.ok(!r.url.includes(':443'));
});

test('detectBlock: FAIL_SYS_USER_VALIDATE without url still classifies as slide-captcha', () => {
  const r = detectBlock('{"ret":["FAIL_SYS_USER_VALIDATE"]}');
  assert.equal(r.kind, 'slide-captcha');
  assert.equal(r.url, null);
});

test('detectBlock: hard Bad_Request is classified as hard-block', () => {
  const r = detectBlock('{"code":"Bad_Request","details":"Internal error occurred"}');
  assert.equal(r.kind, 'hard-block');
  assert.equal(r.url, null);
});
