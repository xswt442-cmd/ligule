import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels, discoveredModelIds } from '../dist/model/discovery.js';

test('model discovery keeps unique valid IDs from an OpenAI-compatible catalog', () => {
  assert.deepEqual(discoveredModelIds({ data: [
    { id: 'model-a' }, { id: 'model-a' }, { id: ' model-b ' }, { id: '' }, { id: 'bad\nvalue' }, { name: 'no id' },
  ] }), ['model-a', 'model-b']);
});

test('model discovery closes oversized HTTP bodies without masking the size error', async () => {
  const reference = 'LIGULE_DISCOVERY_STREAM_LIMIT_TEST';
  const previousKey = process.env[reference];
  const originalFetch = globalThis.fetch;
  process.env[reference] = 'fake-test-key';
  try {
    let headerCancelled = false;
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({ 'content-length': '2000000' }),
      body: { cancel: async () => { headerCancelled = true; } },
    });
    await assert.rejects(discoverModels({
      api: 'chat-completions', baseURL: 'https://example.test/v1', reference,
    }), { code: 'model_discovery_response_too_large' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(headerCancelled, true, 'oversized response body should be cancelled before streaming');

    let released = false;
    let cancelled = false;
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(1024 * 1024 + 1) }),
          cancel: async () => { cancelled = true; throw new Error('upstream abort failed'); },
          releaseLock: () => { released = true; },
        }),
      },
    });
    await assert.rejects(discoverModels({
      api: 'chat-completions', baseURL: 'https://example.test/v1', reference,
    }), { code: 'model_discovery_response_too_large' });
    assert.equal(cancelled, true);
    assert.equal(released, true, 'reader lock must be released on oversized stream');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env[reference];
    else process.env[reference] = previousKey;
  }
});

test('model discovery rejects malformed catalogs and limits the result size', () => {
  assert.throws(() => discoveredModelIds({ models: [] }), { code: 'model_discovery_response_invalid' });
  const models = Array.from({ length: 140 }, (_, index) => ({ id: `model-${index}` }));
  assert.equal(discoveredModelIds({ data: models }).length, 128);
});
