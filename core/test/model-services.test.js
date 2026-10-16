import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { modelServices, resolveModel } from '../dist/kernel/model-services.js';
import { configVersion, writeConfigField } from '../dist/kernel/config-edit.js';

const service = { id: 'deepseek', name: 'DeepSeek 🌿', api: 'chat-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'LIGULE_SERVICE_KEY', models: ['deepseek-reasoner', 'org/model-v2'] };

test('service validation rejects unknown fields, duplicate ids, unsafe URLs, and invalid references', () => {
  for (const value of [
    [{ ...service, unsupportedField: true }],
    [service, service],
    [{ ...service, baseURL: 'https://user:secret@example.test' }],
    [{ ...service, baseURL: 'https://example.test/?api_key=secret' }],
    [{ ...service, apiKeyEnv: 'not an environment variable' }],
    [{ ...service, models: [] }],
  ]) assert.throws(() => modelServices(value), error => error.code === 'model_service_invalid');
  assert.throws(() => resolveModel({ services: [service] }, { provider: 'missing', model: 'm' }), error => error.code === 'model_service_not_found');
  assert.throws(() => resolveModel({ services: [service] }, { provider: service.id, model: 'missing' }), error => error.code === 'model_not_available');
});

test('service and default selection use versioned TOML writes and preserve unrelated bytes', async () => {
  const scratch = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'model-services-'));
  const file = join(root, 'config.toml');
  const untouched = '# another section\n[future]\nvalue = "中文" # preserve this\n';
  try {
    await writeFile(file, untouched, 'utf8');
    const saved = await writeConfigField(file, { field: 'model.services', value: [service], version: configVersion(untouched) });
    const text = await readFile(file, 'utf8');
    assert.equal(text.startsWith(untouched), true);
    assert.deepEqual(structuredClone(parse(text).model.services), [service]);
    assert.equal(resolveModel(parse(text).model).model, service.models[0]);
    const selected = await writeConfigField(file, { field: 'model.selection', value: { provider: service.id, model: service.models[1] }, version: saved.version });
    assert.equal(resolveModel(parse(await readFile(file, 'utf8')).model).model, service.models[1]);
    await writeConfigField(file, { field: 'model.services', value: [{ ...service, name: 'Updated' }], version: selected.version });
    assert.equal((await readFile(file, 'utf8')).startsWith(untouched), true);
    const commented = '[model]\nservices = [\n# keep this service comment\n{ id = "x", name = "X", api = "messages", baseURL = "https://example.test", apiKeyEnv = "KEY", models = ["m"] }\n]\n';
    await writeFile(file, commented, 'utf8');
    await assert.rejects(writeConfigField(file, { field: 'model.services', value: [service], version: configVersion(commented) }), error => error.code === 'config_edit_shape_unsupported');
    assert.equal(await readFile(file, 'utf8'), commented);
  } finally { await rm(root, { recursive: true, force: true }); }
});
