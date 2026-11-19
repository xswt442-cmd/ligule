// 每种作用域都必须同时收回两类进程资源；漏掉任何一侧都会留下孤儿进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessOwnership } from '../dist/host/process-ownership.js';

type Calls = string[];

function fakes() {
  const calls: Calls = [];
  const finite = {
    async stopRun(sessionId: string, runId: string, reason: string) { calls.push(`finite.stopRun:${sessionId}:${runId}:${reason}`); },
    async stopSession(sessionId: string) { calls.push(`finite.stopSession:${sessionId}`); },
    async stopProject(identity: string) { calls.push(`finite.stopProject:${identity}`); },
    async stopGrant(grantId: string) { calls.push(`finite.stopGrant:${grantId}`); },
  };
  const managed = (id: string) => ({
    async stopAll() { calls.push(`managed.stopAll:${id}`); },
    async stopWorkspaceTrusted() { calls.push(`managed.stopWorkspaceTrusted:${id}`); },
    async close() { calls.push(`managed.close:${id}`); },
  });
  return { calls, finite, managed };
}

test('stopping a Run stops its finite commands and the session processes', async () => {
  const { calls, finite, managed } = fakes();
  const ownership = createProcessOwnership(finite as never);
  await ownership.stopRun({ id: 's1', activeRunId: 'r1', managedProcesses: managed('s1') as never }, 'run_cancel');
  assert.deepEqual(calls, ['finite.stopRun:s1:r1:run_cancel', 'managed.stopAll:s1']);
});

test('a permission change stops managed processes and every derived operation session', async () => {
  const { calls, finite, managed } = fakes();
  const ownership = createProcessOwnership(finite as never);
  await ownership.stopAfterPermissionChange({ id: 's1', managedProcesses: managed('s1') as never }, ['s2', 's3']);
  assert.deepEqual(calls, ['managed.stopAll:s1', 'finite.stopSession:s2', 'finite.stopSession:s3']);
});

test('trust and grant revocation cover the project and each affected session', async () => {
  const { calls, finite, managed } = fakes();
  const ownership = createProcessOwnership(finite as never);
  await ownership.stopAfterTrustChange('/p', [{ id: 's1', managedProcesses: managed('s1') as never }]);
  await ownership.stopAfterGrantRevocation('g1', [
    { id: 's1', managedProcesses: managed('s1') as never },
    { id: 's2', managedProcesses: managed('s2') as never },
  ]);
  assert.deepEqual(calls.sort(), [
    'finite.stopGrant:g1',
    'finite.stopProject:/p',
    'managed.stopAll:s1',
    'managed.stopAll:s2',
    'managed.stopWorkspaceTrusted:s1',
  ]);
});
