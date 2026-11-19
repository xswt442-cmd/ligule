import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchSession, createSessionLog, listSessions, searchSessions } from '../dist/index.js';
import { exportMarkdown } from '../dist/host/export.js';
import { SESSION_FORMAT_VERSION } from '../dist/session/format.js';

async function withDirectory<TResult>(run: (directory: string) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'legacy-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 旧记录的字段比当前格式少：这里手写一份真实的 v3 记录，而不是用当前写入器生成。
async function writeLegacy(directory: string, id: string, formatVersion: number): Promise<string> {
  const path = join(directory, `${id}.jsonl`);
  await mkdir(directory, { recursive: true });
  const lines = [
    { kind: 'session', formatVersion, sessionId: id, projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' },
    { seq: 0, kind: 'user', text: 'old request' },
    { seq: 1, kind: 'assistant', text: 'old answer' },
    // 旧版本不记录字节数与完整性：读取方必须按未知处理，不能推断。
    { seq: 2, kind: 'tool', tool: 'read', args: { path: 'a.txt' }, result: { kind: 'result', failed: false, content: 'old contents' } },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

test('a version 3 record reads, lists, searches and exports without inventing missing evidence', async () => {
  await withDirectory(async (directory) => {
    await writeLegacy(directory, 'legacy-3', 3);
    const session = createSessionLog({ directory, id: 'legacy-3' });
    const events = await session.read();
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.equal((await session.header())?.formatVersion, 3);
    assert.deepEqual(await session.modelView(), [
      { role: 'user', text: 'old request' },
      { role: 'assistant', text: 'old answer', toolCalls: undefined },
      { role: 'tool', id: undefined, tool: 'read', content: 'old contents', failed: false, code: undefined },
    ]);

    const listed = await listSessions(directory, { projectRoot: '/repo' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'legacy-3');
    assert.equal(listed[0]?.formatVersion, 3);

    const found = await searchSessions(directory, { query: 'old request' });
    assert.equal(found.length, 1);

    const markdown = exportMarkdown(events, { id: 'legacy-3', projectRoot: '/repo' });
    assert.match(markdown, /old request/u);
    assert.match(markdown, /old contents/u);
  });
});

test('branching an old record yields a readable current-format session', async () => {
  await withDirectory(async (directory) => {
    await writeLegacy(directory, 'legacy-branch', 4);
    const result = await branchSession(directory, 'legacy-branch', { projectRoot: '/repo' });
    const branched = createSessionLog({ directory, id: result.sessionId });
    const events = await branched.read();
    assert.equal((await branched.header())?.formatVersion, SESSION_FORMAT_VERSION);
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
  });
});

test('a record from a newer format is refused instead of being partially read', async () => {
  await withDirectory(async (directory) => {
    await writeLegacy(directory, 'future', SESSION_FORMAT_VERSION + 1);
    const session = createSessionLog({ directory, id: 'future' });
    await assert.rejects(session.read(), { code: 'session_version_unsupported' });
    // 列表不隐瞒坏记录：返回条目并带上错误码，而不是静默跳过。
    const listed = await listSessions(directory, {});
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.error?.code, 'session_version_unsupported');
  });
});

test('an old header cannot smuggle an event type introduced by a later format', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'smuggled.jsonl');
    const lines = [
      { kind: 'session', formatVersion: 4, sessionId: 'smuggled', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' },
      { seq: 0, kind: 'user', text: 'request' },
      // check 事件自格式 5 起才有；旧头里出现它必须被拒绝，而不是按未知字段放过。
      { seq: 1, kind: 'check', sessionId: 'smuggled', runId: 'run', callId: 'call', executionId: 'exec', at: '2026-01-01T00:00:01.000Z' },
    ];
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const session = createSessionLog({ directory, id: 'smuggled' });
    await assert.rejects(session.read(), { code: 'session_event_version_unsupported' });
  });
});
