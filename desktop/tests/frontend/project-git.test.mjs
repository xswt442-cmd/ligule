import assert from 'node:assert/strict';
import test from 'node:test';
import { readProjectGitDiff, readProjectGitStatus } from '../../frontend/src/project-git.ts';
import { projectChangesFrom } from '../../frontend/src/project-changes.ts';

function clientReturning(value) {
  return { call: async (method, params, timeout) => {
    assert.equal(timeout, 15_000);
    if (method === 'project.git.status') assert.deepEqual(params, { sessionId: 'session' });
    if (method === 'project.git.diff') assert.deepEqual(params, { sessionId: 'session', path: 'src/file.ts' });
    return value;
  } };
}

test('Git status responses retain only bounded relative paths and explicit read-only states', async () => {
  const entry = { path: 'src/file.ts', kind: 'modified', staged: true, unstaged: true, untracked: false };
  const result = await readProjectGitStatus(clientReturning({ state: 'ready', files: [entry], truncated: false }), 'session');
  assert.deepEqual(result.files, [entry]);
  assert.equal((await readProjectGitStatus(clientReturning({ state: 'not_repository', files: [], truncated: false }), 'session')).state,
    'not_repository');
  await assert.rejects(readProjectGitStatus(clientReturning({ state: 'ready', files: [
    { ...entry, path: '../outside.ts' },
  ], truncated: false }), 'session'), { code: 'project_git_status_invalid' });
});

test('Git diff responses bound output and classify untracked and binary files without payloads', async () => {
  const ready = { state: 'ready', path: 'src/file.ts', staged: 'staged diff\n', unstaged: 'working diff\n' };
  assert.deepEqual(await readProjectGitDiff(clientReturning(ready), 'session', 'src/file.ts'), ready);
  for (const state of ['untracked', 'binary', 'output_too_large']) {
    assert.equal((await readProjectGitDiff(clientReturning({ state, path: 'src/file.ts', staged: null, unstaged: null }),
      'session', 'src/file.ts')).state, state);
  }
  await assert.rejects(readProjectGitDiff(clientReturning(ready), 'session', '../outside.ts'), {
    code: 'project_file_path_invalid',
  });
  await assert.rejects(readProjectGitDiff(clientReturning({ ...ready, staged: 'x'.repeat(128 * 1024 + 1) }),
    'session', 'src/file.ts'), { code: 'project_git_diff_invalid' });
});

test('Session change projection preserves Desktop source and the Host-decided check status', () => {
  const output = projectChangesFrom([
    { seq: 1, kind: 'check', runId: 'run-a', declaration: { name: 'A', scope: ['src/other.ts'] },
      commandStatus: 'met', reportStatus: 'reported_pass', scopeStatus: 'sampled' },
    { seq: 2, kind: 'check', runId: 'run-b', declaration: { name: 'B', scope: ['src/a.ts'] },
      commandStatus: 'met', reportStatus: 'reported_pass', scopeStatus: 'stale' },
    { seq: 3, kind: 'check', runId: 'run-c', declaration: { name: 'C', scope: ['src/a.ts'] },
      commandStatus: 'unknown', reportStatus: 'unverified', scopeStatus: 'unverified' },
    { seq: 4, kind: 'tool', runId: 'run-c', tool: 'edit', fileChanges: [
      { path: 'src/a.ts', operation: 'edit', outcome: 'written', beforeVersion: 'a'.repeat(16), observedAfterVersion: 'b'.repeat(16) },
    ] },
    { seq: 5, kind: 'workspaceFileChange', ignorable: true, source: 'desktop', fileChanges: [
      { path: 'src/a.ts', operation: 'write', outcome: 'written', beforeVersion: 'b'.repeat(16), observedAfterVersion: 'c'.repeat(16) },
    ] },
    { seq: 6, kind: 'workspaceFileChange', ignorable: true, source: 'desktop', fileChanges: [
      { path: '../outside.ts', operation: 'write', outcome: 'written' },
    ] },
  ]);
  assert.equal(output.changes.length, 2, 'unsafe paths are not shown');
  assert.equal(output.changes[0].source, 'desktop');
  assert.equal(output.changes[1].source, 'agent');
  assert.equal(output.checks.find(check => check.runId === 'run-a').scopeStatus, 'sampled');
  assert.equal(output.checks.find(check => check.runId === 'run-b').scopeStatus, 'stale');
  assert.equal(output.checks.find(check => check.runId === 'run-c').scopeStatus, 'unverified');
});
