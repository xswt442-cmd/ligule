import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRecord } from '../../frontend/src/rows.ts';

test('controller messages stay distinct from human messages in the transcript', () => {
  assert.deepEqual(projectRecord({ kind: 'user', origin: 'controller', text: 'Inspect the workspace.' }).map(({ kind, text, source }) => ({ kind, text, source })), [
    { kind: 'question', text: 'Inspect the workspace.', source: 'controller' },
  ]);
  assert.deepEqual(projectRecord({ kind: 'user', origin: 'human', text: 'Keep the first option.' }).map(({ kind, text, source }) => ({ kind, text, source })), [
    { kind: 'question', text: 'Keep the first option.', source: undefined },
  ]);
});
