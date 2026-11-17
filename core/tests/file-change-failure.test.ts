import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createConfig } from '../dist/kernel/config.js';
import { createKernel } from '../dist/kernel/kernel.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { versionOf } from '../dist/kernel/observe.js';
import { createSessionLog } from '../dist/session/session.js';
import { readTool } from '../dist/tools/read-only.js';
import { createTool, withTestFileWriter, writeTool } from '../dist/tools/write.js';

test('a partial write failure records actual observed bytes and keeps the original baseline', { timeout: 15_000 }, async () => {
  const testRoot = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'file-change-failure-'));
  const projectRoot = join(directory, 'project');
  const sessions = join(directory, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(sessions)]);
  const sessionId = 'file-change-failure';
  const before = Buffer.from('original content\r\n', 'utf8');
  const expected = Buffer.from('replacement content', 'utf8');
  const target = join(projectRoot, 'partial.txt');
  await writeFile(target, before);
  const session = createSessionLog({ directory: sessions, id: sessionId, meta: { projectRoot } });
  try {
    const kernel = createKernel({
      config: createConfig({ user: { boundary: projectRoot } }),
      permission: createPermissionContext('full-access', 'unrestricted', {
        filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
      }),
      session,
    });
    kernel.register(readTool);
    kernel.register(withTestFileWriter(writeTool, async (path, content) => {
      await writeFile(path, content.slice(0, 3), 'utf8');
      throw Object.assign(new Error('injected partial write'), { code: 'EIO' });
    }));
    await kernel.call('read', { path: 'partial.txt' }, { sessionId, runId: 'run-1', callId: 'call-read' });
    await assert.rejects(kernel.call('write', { path: 'partial.txt', content: expected.toString('utf8') }, {
      sessionId, runId: 'run-1', callId: 'call-write',
    }), { code: 'write_outcome_unknown' });

    const events = await session.read();
    const write = events.find((event) => event.kind === 'tool' && event.callId === 'call-write');
    const change = (write?.fileChanges as Record<string, unknown>[] | undefined)?.[0];
    assert.equal(change?.outcome, 'unknown');
    assert.equal(change?.beforeVersion, versionOf(before));
    assert.equal(change?.expectedAfterVersion, versionOf(expected));
    assert.equal(change?.observedAfterVersion, versionOf(Buffer.from('rep')));
    assert.equal(change?.expectedMatchesObserved, false);
    assert.equal(change?.changedFromBaseline, true);
    const reference = change?.baselineRef as { name: string } | undefined;
    assert.ok(reference);
    assert.deepEqual(await readFile(join(sessions, reference.name)), before);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('change evidence does not read back a created file when filesystem read is unavailable', { timeout: 15_000 }, async () => {
  const testRoot = join(process.cwd(), 'testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'file-change-no-readback-'));
  const projectRoot = join(directory, 'project');
  const sessions = join(directory, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(sessions)]);
  const sessionId = 'file-change-no-readback';
  const content = 'authorized write only\n';
  const session = createSessionLog({ directory: sessions, id: sessionId, meta: { projectRoot } });
  try {
    const kernel = createKernel({
      config: createConfig({ user: { boundary: projectRoot } }),
      permission: createPermissionContext('workspace-write', 'disabled', {
        filesystemRead: 'unavailable', filesystemWrite: 'full', network: 'unavailable', process: 'unavailable',
      }),
      session,
    });
    kernel.register(createTool);
    await kernel.call('create', { path: 'write-only.txt', content }, { sessionId, runId: 'run-1', callId: 'call-create' });
    const events = await session.read();
    const created = events.find((event) => event.kind === 'tool' && event.callId === 'call-create');
    const change = (created?.fileChanges as Record<string, unknown>[] | undefined)?.[0];
    assert.equal(change?.outcome, 'written');
    assert.equal(change?.expectedAfterVersion, versionOf(Buffer.from(content)));
    assert.equal(change?.observedStatus, 'unavailable');
    assert.equal(change?.observedReason, 'readback_not_authorized');
    assert.equal(change?.observedAfterVersion, null);
    assert.equal(await readFile(join(projectRoot, 'write-only.txt'), 'utf8'), content,
      'the authorized create succeeds without the recorder adding a read');
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
