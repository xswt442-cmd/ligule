// 子 Run 登记表只有一个所有者：会话 ID 分配、登记/查找、淘汰与内存投影都由 `subrun-store` 决定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubrunRegistry, referenceOf, viewOf, type SubrunRecord } from '../dist/tools/subrun-store.js';

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-subrun-store-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function recordOf(subrunId: string, overrides: Partial<SubrunRecord> = {}): SubrunRecord {
  return {
    subrunId,
    controller: new AbortController(),
    state: 'completed',
    phase: null,
    pendingApprovals: 0,
    pendingQuestions: 0,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test('the registry resumes the child session counter from the directory', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'main.sub-7.jsonl'), '');
    await writeFile(join(directory, 'main.sub-notes.jsonl'), '');
    const registry = new SubrunRegistry(directory, 'main');
    assert.equal(await registry.nextSessionId(), 'main.sub-8');
    assert.equal(await registry.nextSessionId(), 'main.sub-9');
    const other = new SubrunRegistry(directory, 'other');
    assert.equal(await other.nextSessionId(), 'other.sub-1');
  });
});

test('a full registry drops the oldest finished record and refuses while every run is active', () => {
  const registry = new SubrunRegistry('/unused', 'main');
  registry.add(recordOf('main.sub-1'));
  registry.add(recordOf('main.sub-2', { state: 'running' }));
  registry.prune(2);
  assert.equal(registry.has('main.sub-1'), false);
  assert.equal(registry.has('main.sub-2'), true);
  registry.add(recordOf('main.sub-3', { state: 'running' }));
  assert.throws(() => registry.prune(2), (error: unknown) =>
    (error as { code?: string }).code === 'subagent_operation_limit');
});

test('the memory projection carries only what the record knows', () => {
  const pending = recordOf('main.sub-1', { state: 'running', sessionId: 'main.sub-1', runId: 'run-1', parentRunId: 'parent-1' });
  assert.throws(() => referenceOf(recordOf('main.sub-2')));
  assert.deepEqual(referenceOf(pending), {
    subrunId: 'main.sub-1', sessionId: 'main.sub-1', runId: 'run-1', parentRunId: 'parent-1',
  });
  const view = viewOf(pending, { iterations: 2, modelCalls: 3 } as never);
  assert.equal(view.state, 'running');
  assert.equal(view.task === null, false);
  assert.equal(view.pendingInteractions.approvals, 0);
  assert.equal(view.result, undefined);
});
