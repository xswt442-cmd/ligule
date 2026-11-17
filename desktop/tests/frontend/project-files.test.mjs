import assert from 'node:assert/strict';
import test from 'node:test';
import { saveProjectFile } from '../../frontend/src/project-files.ts';

function clientReturning(value) {
  return { call: async (method, params, timeout) => {
    assert.equal(method, 'project.file.save');
    assert.equal(params.expectedVersion, 'a'.repeat(16));
    assert.equal(timeout, 30_000);
    return value;
  } };
}

test('project file saves validate Host outcomes, including a recorded write with new edits still pending', async () => {
  const saved = { saved: true, changed: true, version: 'b'.repeat(16), recorded: true, outcome: 'written' };
  assert.deepEqual(await saveProjectFile(clientReturning(saved), 'session', 'src/file.ts', 'a'.repeat(16), 'text'), saved);

  const unrecorded = { ...saved, recorded: false, errorCode: 'workspace_file_change_record_failed' };
  assert.deepEqual(await saveProjectFile(clientReturning(unrecorded), 'session', 'src/file.ts', 'a'.repeat(16), 'text'), unrecorded);
});

test('project file save rejects malformed outcomes and oversized text before Host dispatch', async () => {
  await assert.rejects(saveProjectFile(clientReturning({ saved: true, changed: true, version: null,
    recorded: true, outcome: 'written' }), 'session', 'file.ts', 'a'.repeat(16), 'text'), {
    code: 'project_file_save_response_invalid',
  });
  let calls = 0;
  const client = { call: async () => { calls += 1; return {}; } };
  await assert.rejects(saveProjectFile(client, 'session', 'file.ts', 'a'.repeat(16), 'x'.repeat(256 * 1024 + 1)), {
    code: 'project_file_text_invalid',
  });
  assert.equal(calls, 0);
});
