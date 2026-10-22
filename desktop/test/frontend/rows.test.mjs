import assert from 'node:assert/strict';
import test from 'node:test';
import { appendProjectedRecords, projectRecord } from '../../frontend/src/rows.ts';

test('controller messages stay distinct from human messages in the transcript', () => {
  assert.deepEqual(projectRecord({ kind: 'user', origin: 'controller', text: 'Inspect the workspace.' }).map(({ kind, text, source }) => ({ kind, text, source })), [
    { kind: 'question', text: 'Inspect the workspace.', source: 'controller' },
  ]);
  assert.deepEqual(projectRecord({ kind: 'user', origin: 'human', text: 'Keep the first option.' }).map(({ kind, text, source }) => ({ kind, text, source })), [
    { kind: 'question', text: 'Keep the first option.', source: undefined },
  ]);
});

test('observed records keep existing row identities and local rows', () => {
  const existing = projectRecord({ seq: 4, kind: 'user', text: 'existing' });
  const local = { id: 900, kind: 'meta', text: 'local status' };
  const current = [...existing, local];
  const observed = [
    { seq: 4, kind: 'user', text: 'existing' },
    { seq: 5, kind: 'assistant', text: 'new reply' },
  ];

  const updated = appendProjectedRecords(current, observed);

  assert.equal(updated[0], existing[0]);
  assert.equal(updated[1], local);
  assert.equal(updated[2]?.kind, 'answer');
  assert.equal(updated[2]?.seq, 5);
  assert.equal(appendProjectedRecords(updated, observed), updated);
});
