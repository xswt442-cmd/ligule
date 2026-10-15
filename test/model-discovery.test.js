import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveredModelIds } from '../dist/model/discovery.js';

test('model discovery keeps unique valid IDs from an OpenAI-compatible catalog', () => {
  assert.deepEqual(discoveredModelIds({ data: [
    { id: 'model-a' }, { id: 'model-a' }, { id: ' model-b ' }, { id: '' }, { id: 'bad\nvalue' }, { name: 'no id' },
  ] }), ['model-a', 'model-b']);
});

test('model discovery rejects malformed catalogs and limits the result size', () => {
  assert.throws(() => discoveredModelIds({ models: [] }), { code: 'model_discovery_response_invalid' });
  const models = Array.from({ length: 140 }, (_, index) => ({ id: `model-${index}` }));
  assert.equal(discoveredModelIds({ data: models }).length, 128);
});
