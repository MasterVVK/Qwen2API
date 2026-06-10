const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { sniffOrRestore } = require('../src/utils/stream-sniff.js');

// Collect a restored stream to a single string.
function drain(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

test('sniffOrRestore: clean stream that ends early is restored intact', async () => {
  const payload = 'data: {"choices":[{"delta":{"content":"привет"}}]}\n\ndata: [DONE]\n\n';
  const src = Readable.from([Buffer.from(payload)]);
  const { block, restoredStream } = await sniffOrRestore(src, { maxBytes: 4096, timeoutMs: 2000 });
  assert.equal(block, null);
  assert.ok(restoredStream);
  assert.equal(await drain(restoredStream), payload);
});

test('sniffOrRestore: WAF block in first chunk is detected, no restored stream', async () => {
  const raw = JSON.stringify({
    ret: ['FAIL_SYS_USER_VALIDATE'],
    data: { url: 'https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5secdata=z' },
  });
  const src = Readable.from([Buffer.from(raw)]);
  const { block, restoredStream } = await sniffOrRestore(src, { maxBytes: 4096, timeoutMs: 2000 });
  assert.ok(block);
  assert.equal(block.kind, 'slide-captcha');
  assert.equal(restoredStream, null);
});

test('sniffOrRestore: a single chunk larger than maxBytes is replayed without data loss', async () => {
  // Regression guard: detection only slices the inspection text, the restored
  // stream must still replay the FULL chunk.
  const big = 'x'.repeat(10000); // well over maxBytes=4096, no WAF signature
  const src = Readable.from([Buffer.from(big)]);
  const { block, restoredStream } = await sniffOrRestore(src, { maxBytes: 4096, timeoutMs: 2000 });
  assert.equal(block, null);
  const out = await drain(restoredStream);
  assert.equal(out.length, big.length, 'restored length must equal original');
  assert.equal(out, big);
});

test('sniffOrRestore: multi-chunk clean stream is restored in order', async () => {
  const parts = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
  const src = Readable.from(parts.map(p => Buffer.from(p)));
  const { block, restoredStream } = await sniffOrRestore(src, { maxBytes: 4096, timeoutMs: 2000 });
  assert.equal(block, null);
  assert.equal(await drain(restoredStream), parts.join(''));
});
