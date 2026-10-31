import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeModelRows, mergeModelRows, modelName, modelRows, newModelRow, thinkingChoices } from '../../frontend/src/model-catalog.ts';

const service = { id: 'custom', name: 'Custom', api: 'chat-completions', baseURL: 'https://example.com/v1', apiKeyEnv: 'MODEL_KEY', models: ['model-a'] };

test('legacy catalogs retain IDs without inventing per-model overrides', () => {
  assert.deepEqual(encodeModelRows(modelRows(service)), { models: ['model-a'] });
  assert.equal(modelName(service, 'model-a'), 'model-a');
});

test('names and independent token limits round trip through editable rows', () => {
  const configured = { ...service, modelSettings: [{ id: 'model-a', name: 'Model A', contextTokens: 128000, outputTokens: 16384 }] };
  assert.deepEqual(encodeModelRows(modelRows(configured)), { models: configured.models, modelSettings: configured.modelSettings });
  assert.equal(modelName(configured, 'model-a'), 'Model A');
  const rows = modelRows(configured).map(row => ({ ...row, id: 'model-renamed' }));
  assert.equal(encodeModelRows(rows).modelSettings[0].id, 'model-renamed');
});

test('image input overrides preserve true, false, and automatic values', () => {
  const configured = {
    ...service,
    models: ['image-on', 'image-off', 'automatic'],
    modelSettings: [{ id: 'image-on', imageInput: true }, { id: 'image-off', imageInput: false }],
  };
  const rows = modelRows(configured);
  assert.equal(rows[0].imageInput, true);
  assert.equal(rows[1].imageInput, false);
  assert.equal(rows[2].imageInput, undefined);
  assert.deepEqual(encodeModelRows(rows), { models: configured.models, modelSettings: configured.modelSettings });
});

test('an image input false override is retained without other model settings', () => {
  assert.deepEqual(
    encodeModelRows([{ ...newModelRow('model-a'), imageInput: false }]),
    { models: ['model-a'], modelSettings: [{ id: 'model-a', imageInput: false }] },
  );
});

test('fetching adds models and preserves existing manually edited rows', () => {
  const row = { ...newModelRow('model-a'), name: 'Chosen name', contextTokens: '128000', outputTokens: '16384' };
  const merged = mergeModelRows([row], ['model-a', 'model-b', 'model-b']);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], row);
  assert.equal(merged[1].id, 'model-b');
  assert.deepEqual(mergeModelRows([row], []), [row]);
});

test('clearing both limits and name removes the optional settings entry', () => {
  assert.deepEqual(encodeModelRows([{ ...newModelRow('model-a'), name: '', contextTokens: '', outputTokens: '' }]), { models: ['model-a'] });
});

test('duplicate IDs and incomplete rows cannot be saved', () => {
  for (const [rows, code] of [
    [[], 'model_catalog_empty'],
    [[newModelRow()], 'model_id_invalid'],
    [[newModelRow('model-a'), newModelRow(' model-a ')], 'model_id_duplicate'],
  ]) assert.throws(() => encodeModelRows(rows), error => error.code === code);
});

test('invalid numbers and output beyond the context are rejected', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => encodeModelRows([{ ...newModelRow('model-a'), outputTokens: value }]), error => error.code === 'model_limit_invalid');
  }
  assert.throws(() => encodeModelRows([{ ...newModelRow('model-a'), contextTokens: '1000', outputTokens: '1001' }]), error => error.code === 'model_output_exceeds_context');
});

test('discovery cannot silently truncate a catalog larger than the supported size', () => {
  const rows = Array.from({ length: 128 }, (_, index) => newModelRow(`model-${index}`));
  assert.throws(() => mergeModelRows(rows, ['extra']), error => error.code === 'model_catalog_too_large');
  assert.equal(rows.length, 128);
});

test('thinking choices keep the canonical order and never drop an advertised effort', () => {
  assert.deepEqual(thinkingChoices(['max', 'none', 'high', 'low']), ['none', 'low', 'high', 'max']);
  assert.deepEqual(thinkingChoices(['high', 'xhigh']), ['high', 'xhigh']);
  assert.deepEqual(thinkingChoices([]), []);
});
