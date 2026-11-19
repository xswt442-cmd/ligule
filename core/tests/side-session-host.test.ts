import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { withTuiHost } from './helpers/tui-host.ts';

test('a trusted UI creates a read-only side Session from a verified bounded selection without a Provider call', async () => {
  let releaseParentProvider = () => {};
  let markParentProviderStarted = () => {};
  const parentProviderStarted = new Promise<void>(resolve => { markParentProviderStarted = resolve; });
  const parentProviderGate = new Promise<void>(resolve => { releaseParentProvider = resolve; });
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    const sourceText = 'Review this value: alpha-beta-42. Keep the main task running.';
    const parentRun = client.request('run.start', { sessionId, input: sourceText });
    try {
      await parentProviderStarted;
    const source = await client.request('session.read', { sessionId, fullResults: true }) as {
      events: { kind?: string; seq?: number; text?: string; run?: { runId?: string } }[];
    };
    const sourceEvent = source.events.find(event => event.kind === 'user' && event.text === sourceText);
    assert.ok(sourceEvent?.seq);
    const sourceRunId = sourceEvent.run?.runId;
    assert.ok(sourceRunId);
    const providerCallsBeforeCreate = providerRequests.length;

    const created = await client.request('session.side.create', {
      sessionId,
      sourceRunId,
      sourceKind: 'event',
      sourceEventSeq: sourceEvent.seq,
      selection: 'alpha-beta-42',
    }) as { sessionId: string; sourceSessionId: string; sourceRunId: string; selectionBytes: number };

    assert.ok(created.sessionId);
    assert.notEqual(created.sessionId, sessionId);
    assert.equal(created.sourceSessionId, sessionId);
    assert.equal(created.sourceRunId, sourceRunId);
    assert.equal(created.selectionBytes, Buffer.byteLength('alpha-beta-42'));
    assert.equal(providerRequests.length, providerCallsBeforeCreate, 'creating a side Session does not call the Provider');

    const sideStatus = await client.request('status.get', { sessionId: created.sessionId }) as {
      permission: { profile?: string; network?: string };
      running: boolean;
      activeRunId: string | null;
    };
    assert.equal(sideStatus.permission.profile, 'read-only');
    assert.equal(sideStatus.permission.network, 'disabled');
    assert.equal(sideStatus.running, false);
    assert.equal(sideStatus.activeRunId, null);
    const mainStatus = await client.request('status.get', { sessionId }) as { running: boolean; activeRunId: string | null };
    assert.equal(mainStatus.running, true, 'creating a side Session does not cancel the source Run');
    assert.equal(mainStatus.activeRunId, sourceRunId);

    const sourceAfter = await client.request('session.read', { sessionId, fullResults: true }) as {
      events: { kind?: string; sideSessionId?: string; sourceRunId?: string; sourceEventSeq?: number; selectionBytes?: number }[];
    };
    assert.ok(sourceAfter.events.some(event => event.kind === 'sideSessionStarted'
      && event.sideSessionId === created.sessionId && event.sourceRunId === sourceRunId
      && event.sourceEventSeq === sourceEvent.seq && event.selectionBytes === Buffer.byteLength('alpha-beta-42')));

    const sideRecord = await client.request('session.read', { sessionId: created.sessionId, fullResults: true }) as {
      events: { kind?: string; originSessionId?: string; originRunId?: string; selectionSha256?: string }[];
    };
    const origin = sideRecord.events.find(event => event.kind === 'sideSessionOrigin');
    assert.equal(origin?.originSessionId, sessionId);
    assert.equal(origin?.originRunId, sourceRunId);
    assert.match(origin?.selectionSha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(sideRecord.events.some(event => event.kind === 'user' || event.kind === 'assistant'), false,
      'the side Session waits for the user to review and send the prepared question');
    assert.equal(providerRequests.length, providerCallsBeforeCreate);

    await assert.rejects(client.request('session.side.create', {
      sessionId,
      sourceRunId,
      sourceKind: 'event',
      sourceEventSeq: sourceEvent.seq,
      selection: 'text that is not present in the selected event',
    }), { code: 'side_context_unverified' });
    assert.equal(providerRequests.length, providerCallsBeforeCreate);
    } finally {
      releaseParentProvider();
      await parentRun.catch(() => undefined);
    }
  }, {
    permissionControl: true,
    providerReply: async () => {
      markParentProviderStarted();
      await parentProviderGate;
      return { text: 'Parent task completed.' };
    },
  });
});

test('a file side chat validates the current file version and keeps the reference path inside the source Session', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    const path = join(projectDirectory, 'src', 'note.md');
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    await writeFile(path, 'Initial finding: the parser accepts exact text.\n');
    const first = await client.request('project.file.read', { sessionId, path: 'src/note.md' }) as { version: string | null };
    assert.ok(first.version);
    await writeFile(path, 'Changed finding: the parser accepts exact text.\n');
    await assert.rejects(client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: 'src/note.md', sourceVersion: first.version,
      selection: 'the parser accepts exact text',
    }), { code: 'side_context_version_stale' });

    const current = await client.request('project.file.read', { sessionId, path: 'src/note.md' }) as { version: string | null };
    assert.ok(current.version);
    const created = await client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: 'src/note.md', sourceVersion: current.version,
      selection: 'the parser accepts exact text',
    }) as { sessionId: string };
    const side = await client.request('session.read', { sessionId: created.sessionId }) as {
      events: { kind?: string; sourceKind?: string; sourcePath?: string; sourceVersion?: string }[];
    };
    assert.ok(side.events.some(event => event.kind === 'sideSessionOrigin' && event.sourceKind === 'file'
      && event.sourcePath === 'src/note.md' && event.sourceVersion === current.version));
    assert.equal(providerRequests.length, 0, 'side Session creation does not run an Agent');

    // 上限按 UTF-8 字节计：8400 字节的中文被拒绝，8192 字节的 ASCII 只是没过引用校验，说明边界本身是包含的。
    await assert.rejects(client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: 'src/note.md', sourceVersion: current.version,
      selection: '汉'.repeat(2800),
    }), { code: 'side_context_limit_exceeded' });
    await assert.rejects(client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: 'src/note.md', sourceVersion: current.version,
      selection: 'a'.repeat(8_192),
    }), { code: 'side_context_unverified' });

    await assert.rejects(client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: '../outside.txt', sourceVersion: current.version,
      selection: 'the parser accepts exact text',
    }), { code: 'project_file_path_invalid' });
  }, { permissionControl: true });
});

test('a file side chat verifies a selection that starts on a later page of a bounded snapshot', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    // 让选中内容跨过第一页 64_000 字节的边界：单读 offset=0 一定看不到完整选择。
    const marker = '跨页选择的内容 — a cross-page selection spanning two pages';
    const text = 'a'.repeat(63_990) + marker + 'b'.repeat(70_000) + '\r\n结尾 CRLF\r\n\uFEFF尾部';
    await writeFile(join(projectDirectory, 'src', 'long.txt'), text);
    const bytes = Buffer.from(text, 'utf8');
    assert.ok(bytes.length > 128_000, 'the fixture is larger than two 64_000-byte pages');

    const first = await client.request('project.file.read', { sessionId, path: 'src/long.txt' }) as {
      version: string | null; text?: string; nextOffsetBytes?: number | null;
    };
    assert.ok(first.version);
    assert.equal(typeof first.nextOffsetBytes, 'number');
    assert.equal(first.text?.includes(marker), false, 'the first page alone does not contain the whole selection');

    const second = await client.request('project.file.read', {
      sessionId, path: 'src/long.txt', offsetBytes: first.nextOffsetBytes,
    }) as { text?: string };
    assert.equal(second.text?.includes(marker), false, 'the second page alone does not contain the whole selection either');

    const created = await client.request('session.side.create', {
      sessionId, sourceKind: 'file', sourcePath: 'src/long.txt', sourceVersion: first.version,
      selection: marker,
    }) as { sessionId: string; selectionBytes: number };
    assert.equal(created.selectionBytes, Buffer.byteLength(marker, 'utf8'));
    const side = await client.request('session.read', { sessionId: created.sessionId }) as {
      events: { kind?: string; sourceKind?: string; sourceVersion?: string }[];
    };
    assert.ok(side.events.some(event => event.kind === 'sideSessionOrigin'
      && event.sourceKind === 'file' && event.sourceVersion === first.version));
    assert.equal(providerRequests.length, 0);

  }, { permissionControl: true });
});

test('an untrusted controller cannot create a side Session', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(client.request('session.side.create', {
      sessionId, sourceKind: 'event', sourceEventSeq: 1, selection: 'untrusted request',
    }), { code: 'side_session_trusted_ui_required' });
  });
});
