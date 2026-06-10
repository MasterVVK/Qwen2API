const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUpstreamHeaders } = require('../src/utils/upstream-headers.js');

test('buildUpstreamHeaders: core fingerprint + auth/origin', () => {
  const h = buildUpstreamHeaders({ token: 'jwt123', chatBaseUrl: 'https://chat.qwen.ai' });
  assert.equal(h['Authorization'], 'Bearer jwt123');
  assert.equal(h['Origin'], 'https://chat.qwen.ai');
  assert.equal(h['Referer'], 'https://chat.qwen.ai/c/guest');
  // fingerprint headers the upstream client sends
  assert.equal(h['Version'], '0.1.13');
  assert.equal(h['bx-v'], '2.5.31');
  assert.ok(h['Timezone']);
});

test('buildUpstreamHeaders: Accept defaults to application/json, overridable', () => {
  assert.equal(buildUpstreamHeaders({ token: 't', chatBaseUrl: 'x' })['Accept'], 'application/json');
  assert.equal(
    buildUpstreamHeaders({ token: 't', chatBaseUrl: 'x', accept: 'text/event-stream' })['Accept'],
    'text/event-stream'
  );
});

test('buildUpstreamHeaders: Cookie set only when truthy', () => {
  assert.equal('Cookie' in buildUpstreamHeaders({ token: 't', chatBaseUrl: 'x' }), false);
  assert.equal('Cookie' in buildUpstreamHeaders({ token: 't', chatBaseUrl: 'x', cookieHeader: '' }), false);
  assert.equal(
    buildUpstreamHeaders({ token: 't', chatBaseUrl: 'x', cookieHeader: 'a=1; b=2' })['Cookie'],
    'a=1; b=2'
  );
});
