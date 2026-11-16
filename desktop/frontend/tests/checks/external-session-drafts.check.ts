// 外控 Composer 可卸载重挂；未发送指导草稿必须由 Session 身份持有。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearExternalSessionDraftIfCurrent,
  externalSessionDraftFor,
  externalSessionDraftRevisionFor,
  updateExternalSessionDrafts,
  type ExternalSessionDrafts,
} from '../../src/external-session-drafts.ts';
import {
  clearSessionDraftIfCurrent,
  sessionDraftRevisionFor,
  updateSessionDraftRevision,
  type SessionDraftRevisions,
} from '../../src/session-draft-revisions.ts';

test('external guidance drafts survive composer remounts and remain isolated by session', () => {
  let drafts: ExternalSessionDrafts = new Map();
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');

  drafts = updateExternalSessionDrafts(drafts, 'session-b', 'another draft');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'unsent guidance');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');

  drafts = updateExternalSessionDrafts(drafts, 'session-a', '');
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), '');
  assert.equal(externalSessionDraftFor(drafts, 'session-b'), 'another draft');
});

test('a send completion clears only the exact draft revision it submitted', () => {
  let drafts: ExternalSessionDrafts = new Map();
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message A');
  const sentRevision = externalSessionDraftRevisionFor(drafts, 'session-a');

  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message B');
  const newerRevision = externalSessionDraftRevisionFor(drafts, 'session-a');
  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', sentRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'message B');
  assert.equal(externalSessionDraftRevisionFor(drafts, 'session-a'), newerRevision);

  drafts = updateExternalSessionDrafts(drafts, 'session-a', '');
  drafts = updateExternalSessionDrafts(drafts, 'session-a', 'message A');
  const reenteredRevision = externalSessionDraftRevisionFor(drafts, 'session-a');
  assert.notEqual(reenteredRevision, sentRevision);
  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', sentRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), 'message A');

  drafts = clearExternalSessionDraftIfCurrent(drafts, 'session-a', reenteredRevision);
  assert.equal(externalSessionDraftFor(drafts, 'session-a'), '');
  assert.equal(externalSessionDraftRevisionFor(drafts, 'session-a'), reenteredRevision + 1);
});

test('a background send clears only its session draft revision after a session switch', () => {
  let drafts: SessionDraftRevisions = new Map();
  const keyA = JSON.stringify(['/project-a', 'session-a']);
  const keyB = JSON.stringify(['/project-b', 'session-b']);
  drafts = updateSessionDraftRevision(drafts, keyA, 'sent from A');
  const sentRevision = sessionDraftRevisionFor(drafts, keyA);
  drafts = updateSessionDraftRevision(drafts, keyB, 'keep the draft in B');
  drafts = clearSessionDraftIfCurrent(drafts, keyA, sentRevision);
  assert.equal(drafts.get(keyA)?.text, '');
  assert.equal(drafts.get(keyB)?.text, 'keep the draft in B');

  drafts = updateSessionDraftRevision(drafts, keyA, 'new draft in A');
  const newerRevision = sessionDraftRevisionFor(drafts, keyA);
  drafts = clearSessionDraftIfCurrent(drafts, keyA, sentRevision);
  assert.equal(drafts.get(keyA)?.text, 'new draft in A', 'a late response cannot erase a newer draft after A is reopened');
  assert.equal(sessionDraftRevisionFor(drafts, keyA), newerRevision);
});
