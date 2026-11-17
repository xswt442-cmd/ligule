import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { versionOf } from '../dist/kernel/observe.js';
import { withTuiHost } from './helpers/tui-host.ts';

test('Host records the raw bounded baseline and observed write for the exact tool call', { timeout: 20_000 }, async () => {
  let step = 0;
  const before = Buffer.from('\uFEFFfirst\r\nsecond\r\n', 'utf8');
  const after = Buffer.from('rewritten\ntext\n', 'utf8');
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory }) => {
    await writeFile(join(projectDirectory, 'bom-crlf.txt'), before);
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'read then replace one bounded UTF-8 file' });
    const session = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; fileChanges?: Record<string, unknown>[] }[];
    };
    const writes = session.events.filter((event) => event.kind === 'tool' && event.tool === 'write');
    assert.equal(writes.length, 1);
    const write = writes[0]!;
    assert.equal(typeof write.callId, 'string');
    assert.equal(typeof write.runId, 'string');
    assert.equal(Array.isArray(write.fileChanges), true, 'the write result must carry direct change facts');
    const change = write.fileChanges![0]!;
    assert.equal(change.path, 'bom-crlf.txt');
    assert.equal(change.operation, 'write');
    assert.equal(change.outcome, 'written');
    assert.equal(change.beforeVersion, versionOf(before));
    assert.equal(change.expectedAfterVersion, versionOf(after));
    assert.equal(change.observedAfterVersion, versionOf(after));
    assert.equal(change.baselineStatus, 'available');
    assert.equal(change.observedStatus, 'available');
    assert.equal(change.changedFromBaseline, true);
    assert.equal(change.expectedMatchesObserved, true);
    const reference = change.baselineRef as { name: string; bytes: number; sha256: string };
    assert.equal(reference.bytes, before.length);
    assert.equal(reference.sha256, createHash('sha256').update(before).digest('hex'));
    assert.deepEqual(await readFile(join(sessionDirectory, reference.name)), before,
      'baseline sidecar preserves BOM and CRLF bytes exactly');
    assert.deepEqual(await readFile(join(projectDirectory, 'bom-crlf.txt')), after);
    assert.equal(session.events.filter((event) => event.kind === 'tool' && event.callId === write.callId).length, 1,
      'change facts do not create a second model tool result');

    const result = await client.request('tool.result', {
      sessionId, runId: write.runId, callId: write.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.deepEqual(result.fileChanges, write.fileChanges,
      'the bounded result query exposes the same Session fact');
  }, {
    providerReply: () => {
      step += 1;
      if (step === 1) return { toolCalls: [{ tool: 'read', args: { path: 'bom-crlf.txt' } }] };
      if (step === 2) return { toolCalls: [{ tool: 'write', args: { path: 'bom-crlf.txt', content: 'rewritten\ntext\n' } }] };
      return { text: 'file updated' };
    },
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }),
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 4, modelCalls: 4 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('Host records a multi-edit baseline from its call-time read without requiring a prior read tool call', { timeout: 20_000 }, async () => {
  let step = 0;
  const before = Buffer.from('\uFEFFconst first = 1;\r\nconst second = 2;\r\n', 'utf8');
  const after = Buffer.from('\uFEFFconst first = 10;\r\nconst second = 20;\r\n', 'utf8');
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory }) => {
    await writeFile(join(projectDirectory, 'edit-me.ts'), before);
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'make two exact edits without reading first' });
    const session = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; fileChanges?: Record<string, unknown>[] }[];
    };
    assert.equal(session.events.some((event) => event.kind === 'tool' && event.tool === 'read'), false,
      'multi-edit remains call-time read and does not gain a pre-read requirement');
    const edit = session.events.find((event) => event.kind === 'tool' && event.tool === 'edit');
    assert.ok(typeof edit?.callId === 'string' && typeof edit.runId === 'string');
    const change = edit.fileChanges?.[0];
    assert.equal(change?.beforeVersion, versionOf(before));
    assert.equal(change?.expectedAfterVersion, versionOf(after));
    assert.equal(change?.observedAfterVersion, versionOf(after));
    assert.equal(change?.changedFromBaseline, true);
    const baseline = change?.baselineRef as { name: string } | undefined;
    assert.ok(baseline);
    assert.deepEqual(await readFile(join(sessionDirectory, baseline.name)), before);
    assert.deepEqual(await readFile(join(projectDirectory, 'edit-me.ts')), after);
  }, {
    providerReply: () => {
      step += 1;
      if (step === 1) return { toolCalls: [{ tool: 'edit', args: {
        path: 'edit-me.ts', changes: [
          { oldText: 'const first = 1;', newText: 'const first = 10;' },
          { oldText: 'const second = 2;', newText: 'const second = 20;' },
        ],
      } }] };
      return { text: 'two exact edits completed' };
    },
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }),
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('Host records creation from a confirmed absent path without inventing a prior file body', { timeout: 20_000 }, async () => {
  let step = 0;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'create a new file and record the change' });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; fileChanges?: Record<string, unknown>[] }[];
    };
    const created = history.events.find((event) => event.kind === 'tool' && event.tool === 'create');
    const change = created?.fileChanges?.[0];
    assert.equal(change?.path, 'created-by-agent.txt');
    assert.equal(change?.operation, 'create');
    assert.equal(change?.baselineStatus, 'available');
    assert.equal(change?.baselineExists, false);
    assert.equal(change?.beforeVersion, null);
    assert.equal(change?.baselineRef, undefined);
    assert.equal(change?.expectedAfterVersion, versionOf(Buffer.from('created\n')));
    assert.equal(change?.observedAfterVersion, versionOf(Buffer.from('created\n')));
    assert.equal(change?.changedFromBaseline, true);
    assert.equal(await readFile(join(projectDirectory, 'created-by-agent.txt'), 'utf8'), 'created\n');
  }, {
    providerReply: () => step++ === 0
      ? { toolCalls: [{ tool: 'create', args: { path: 'created-by-agent.txt', content: 'created\n' } }] }
      : { text: 'created' },
    permission: createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }),
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});
