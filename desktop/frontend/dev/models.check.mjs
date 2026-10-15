import assert from 'node:assert/strict';
import { presetService } from '../src/model-catalog.ts';

const preset = { name: 'OpenAI', api: 'chat-completions', baseURL: 'https://api.openai.com/v1' };
const existing = { id: 'service_original', name: 'Custom', api: 'chat-completions', baseURL: 'https://old.example/v1', apiKeyEnv: 'SHARED_KEY', models: ['old-model'] };
const edited = presetService(preset, existing, true, 'new_id');
assert.equal(edited.id, existing.id, 'changing preset preserves the saved service ID');
assert.equal(edited.apiKeyEnv, existing.apiKeyEnv, 'changing preset preserves the credential reference');
assert.equal(edited.baseURL, preset.baseURL);
assert.equal(presetService(preset, null, false, 'new_id').id, 'new_id');
assert.equal(presetService(preset, null, false, 'new_id').apiKeyEnv, 'LIGULE_NEW_ID_KEY');
console.log('model preset edit identity checks passed');
