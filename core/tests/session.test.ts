import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog, execTool, readTool, refusalOf,
} from '../dist/index.js';
import { createRunAcceptance } from '../dist/session/run.js';
import type { KernelOptions } from '../dist/kernel/kernel.js';
import { projectModelView } from '../dist/session/session.js';
import type { SessionLog } from '../dist/session/session.js';
import type { SessionEvent } from '../dist/session/format.js';
import { hasCode } from './helpers/assertions.ts';

type ToolEvent = {
  kind?: string;
  tool?: string;
  result: { kind?: string; code?: string; reason?: string; content: string; spilled?: string };
};

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

async function withDirectory<TResult>(run: (directory: string) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'session-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 首行保存会话元信息，不属于事件；以下测试检查后续事件记录。
async function eventLines(path: string): Promise<{ kind?: string }[]> {
  const bytes = await readFile(path, 'utf8');
  return bytes.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind?: string }).filter((event) => event.kind !== 'session');
}

async function eventBytes(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  const cut = bytes.indexOf(0x0a);
  return bytes.subarray(cut + 1);
}

function kernelWith(session: SessionLog, extra: { config?: Record<string, unknown>; kernel?: Omit<KernelOptions, 'config' | 'session'> } = {}) {
  return createKernel({
    config: createConfig({ user: { boundary: process.cwd(), limits: { resultBytes: 200 }, ...extra.config } }),
    session,
    ...extra.kernel,
  });
}

test('what the model sees is rebuildable from the log, byte for byte', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-1' });
    const written = await session.append({ kind: 'tool', tool: 'read', args: { path: 'note.txt' }, result: { content: 'kept exactly' } });
    assert.equal(written.seq, 0);
    // 首行记录格式版本，后续事件内容按原始字节写入文件。
    assert.deepEqual(await eventLines(session.path), [written]);
    assert.equal((await eventBytes(session.path)).toString('utf8'), `${JSON.stringify(written)}\n`);

    const reopened = createSessionLog({ directory, id: 'run-1' });
    assert.deepEqual(await reopened.modelView(), [
      { role: 'tool', id: undefined, tool: 'read', content: 'kept exactly', failed: undefined, code: undefined },
    ]);
    const second = await reopened.append({ kind: 'tool', tool: 'exec', args: {}, result: { content: 'next' } });
    assert.equal(second.seq, 1, 'a reopened log continues the sequence');
  });
});

test('nested extension tool results stay in the Session but out of the parent model conversation', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'nested-model-view' });
    await session.append({ kind: 'user', text: 'run the extension' });
    await session.append({ kind: 'assistant', text: '', toolCalls: [
      { id: 'outer-call', name: 'extension_nested_exec', args: {} },
    ] });
    await session.append({ kind: 'tool', tool: 'exec', callId: 'inner-call', parentCallId: 'outer-call', runId: 'run-1',
      args: { command: 'node nested-child.mjs' }, result: { kind: 'result', failed: false, content: 'inner result' } });
    await session.append({ kind: 'tool', tool: 'extension_nested_exec', callId: 'outer-call', args: {},
      result: { kind: 'result', failed: false, content: 'outer result' } });

    const view = await session.modelView() as { role: string; id?: string; content?: string }[];
    assert.deepEqual(view.filter((message) => message.role === 'tool').map((message) => [message.id, message.content]), [
      ['outer-call', 'outer result'],
    ]);
    assert.ok((await session.read()).some((event) => event.kind === 'tool' && event.callId === 'inner-call'),
      'the nested call remains available in the authoritative Session record');
  });
});

test("a child Session includes tool results linked to its parent's call in its own model view", async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'child-model-view' });
    const run = createRunAcceptance('child-model-view', 'create the requested file', null, 'controller:subagent', undefined, undefined,
      { sessionId: 'parent-session', runId: '00000000-0000-4000-8000-000000000001', subrunId: 'child-model-view', callId: 'parent-call' });
    await session.append({ kind: 'user', text: 'create the requested file', run });
    await session.append({ kind: 'assistant', text: '', toolCalls: [
      { id: 'child-call', name: 'create', args: { path: 'result.txt' } },
    ] });
    await session.append({ kind: 'tool', tool: 'create', callId: 'child-call', parentCallId: 'parent-call',
      result: { kind: 'result', failed: false, content: 'created' } });

    const view = await session.modelView() as { role: string; id?: string; content?: string }[];
    assert.deepEqual(view.filter((message) => message.role === 'tool').map((message) => [message.id, message.content]), [
      ['child-call', 'created'],
    ]);
  });
});

test('an applied steering input joins its current Run model view only after application', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'steering-model-view' });
    const run = createRunAcceptance('steering-model-view', 'start the task', null, 'human');
    await session.append({ kind: 'user', text: 'start the task', run });
    await session.append({ kind: 'runInput', mode: 'steer', state: 'accepted', inputId: 'steer-1', runId: run.runId,
      source: 'human', text: 'keep the existing route', acceptedAt: '2026-11-15T00:00:00.000Z' });
    assert.deepEqual(await session.modelView(), [{ role: 'user', text: 'start the task' }],
      'accepted text must not reach the model before the Loop applies it');
    await session.append({ kind: 'runInput', mode: 'steer', state: 'applied', inputId: 'steer-1', runId: run.runId,
      appliedAt: '2026-11-15T00:00:01.000Z' });
    assert.deepEqual(await session.modelView(), [
      { role: 'user', text: 'start the task' },
      { role: 'user', text: 'keep the existing route' },
    ]);
  });
});

test('applied steering remains visible when compaction covers only its accepted event', () => {
  const run = createRunAcceptance('steering-compaction-view', 'start the task', null, 'human');
  const events = [
    { seq: 0, kind: 'user', text: 'start the task', run },
    { seq: 1, kind: 'runInput', mode: 'steer', state: 'accepted', inputId: 'steer-compact', runId: run.runId,
      source: 'human', text: 'preserve the public route', acceptedAt: '2026-11-15T00:00:00.000Z' },
    { seq: 2, kind: 'runInput', mode: 'steer', state: 'applied', inputId: 'steer-compact', runId: run.runId,
      appliedAt: '2026-11-15T00:00:01.000Z' },
  ] as unknown as SessionEvent[];
  assert.deepEqual(projectModelView(events, [{ fromSeq: 1, toSeq: 1, text: 'earlier context' }]), [
    { role: 'user', text: 'start the task' },
    { role: 'user', text: 'earlier context' },
    { role: 'user', text: 'preserve the public route' },
  ]);
});

test('session policy snapshots are retained in the log but excluded from the model view', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'policy-state' });
    await session.append({ kind: 'user', text: 'keep this input' });
    const before = await session.modelView();
    await session.append({
      kind: 'sessionPolicy', ignorable: true, override: 'ask', consecutive: 1, total: 1, forcedToAsk: true,
    });
    assert.deepEqual(await session.modelView(), before);
    assert.equal((await session.read()).at(-1)!.kind, 'sessionPolicy');
    await session.close();
  });
});

// 并发工具调用共享同一份会话记录，写入操作必须按顺序完成。
test('appends that arrive at the same time still take turns on the sequence', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-7' });
    const letters = ['a', 'b', 'c', 'd', 'e'];
    const written = await Promise.all(
      letters.map((letter) => session.append({ kind: 'tool', tool: letter, args: {}, result: { content: letter.repeat(2_000) } })),
    );
    assert.deepEqual(written.map((event) => event.seq), [0, 1, 2, 3, 4], 'no two events share a sequence number');
    assert.deepEqual((await session.read()).map((event) => event.tool), letters, 'the log holds them in the order they queued in');
    const after = await session.append({ kind: 'tool', tool: 'f', args: {}, result: { content: 'f' } });
    assert.equal(after.seq, 5, 'the queue keeps working after a burst');
  });
});

test('reading a crash tail preserves the file and the next append repairs it', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-2' });
    await session.append({ kind: 'tool', tool: 'read', args: {}, result: { content: 'one' } });
    await writeFile(session.path, '{"seq":1,"kind":"tool","too', { flag: 'a' });

    const beforeRead = await readFile(session.path);
    const events = await session.read();
    assert.equal(events.length, 1);
    assert.deepEqual(await readFile(session.path), beforeRead, '只读入口不修改文件');
    const next = await session.append({ kind: 'tool', tool: 'read', args: {}, result: { content: 'two' } });
    assert.equal(next.seq, 1, 'the discarded half line does not burn a sequence number');
    assert.deepEqual((await session.read()).map((event) => event.seq), [0, 1]);
  });
});

test('a half line ending in an incomplete multi-byte sequence is cut on the byte boundary', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-6' });
    await session.append({ kind: 'tool', tool: 'read', args: {}, result: { content: '中文内容' } });
    const kept = await eventBytes(session.path);
    const whole = (await readFile(session.path)).length;
    // 崩溃时写了一半：那半截以一个三字节字符的第二个字节结尾，解码成字符串会得到一个替换符。
    await writeFile(session.path, Buffer.concat([Buffer.from('{"seq":1,"c":"', 'utf8'), Buffer.from([0xe5, 0x8d])]), { flag: 'a' });

    const events = await session.read();
    assert.deepEqual(events, [JSON.parse(kept.toString('utf8'))]);
    assert.equal(events[0].seq, 0, '首行不占事件的序号');
    assert.ok((await readFile(session.path)).length > whole, '读取保留未完成尾行');
    await session.append({ kind: 'user', text: '继续读取' });
    assert.deepEqual((await session.read()).map((event) => event.seq), [0, 1], '写入时按字节边界修复尾行');
  });
});

test('a log that cannot be written reports a code and leaves nothing behind', async () => {
  await withDirectory(async (directory) => {
    // 会话目录路径指向普通文件时，读取应立即失败且不能写入任何内容。
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, 'not a directory');
    const session = createSessionLog({ directory: blocked, id: 'run' });
    await assert.rejects(
      () => session.append({ kind: 'tool', tool: 'read', args: {}, result: { content: 'x' } }),
      (error) => hasCode(error, 'session_lock_failed'),
    );
    assert.equal(await readFile(blocked, 'utf8'), 'not a directory');
  });
});

test('an oversized result in a session directory that does not exist yet still spills and records', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'write-'));
  try {
    const directory = join(root, 'sessions', 'nested');
    const session = createSessionLog({ directory, id: 'first' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root, limits: { resultBytes: 100 } } }), session });
    kernel.register({
      name: 'chatty',
      description: 'returns more than the result limit',
      access: 'read',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ text: 'z'.repeat(400) }),
    });
    await kernel.call('chatty', {});
    const [event] = await session.read() as unknown as ToolEvent[];
    assert.match(event.result.content, /omitted/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, event.result.spilled!), 'utf8')), { text: 'z'.repeat(400) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refusal and a failure each carry their own code into the log', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-3' });
    const kernel = kernelWith(session, {
      kernel: {
        permission: fullAccess,
        policy: createDecisionChain({ mode: 'auto', rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'no deleting' }] }),
      },
    });
    kernel.register(execTool);
    await assert.rejects(() => kernel.call('exec', { command: 'rm -rf /tmp/nowhere' }), (error) => hasCode(error, 'policy_denied'));
    await assert.rejects(() => kernel.call('exec', { command: '   ' }), (error) => hasCode(error, 'exec_command_required'));

    const events = await session.read() as unknown as ToolEvent[];
    assert.deepEqual(events.filter((event) => event.kind === 'tool').map((event) => [event.tool, event.result.kind, event.result.code]), [
      ['exec', 'refusal', 'policy_denied'],
      ['exec', 'failure', 'exec_command_required'],
    ]);
    assert.equal(events[0].result.reason, 'no deleting');
  });
});

test('an oversized result keeps a retrievable reference instead of the whole text', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-4' });
    const kernel = kernelWith(session);
    kernel.register({
      name: 'chatty',
      description: 'returns more than the result limit',
      access: 'read',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ text: 'y'.repeat(500) }),
    });
    await kernel.call('chatty', {});
    const [event] = await session.read() as unknown as ToolEvent[];
    assert.match(event.result.content, /\[omitted: full output is \d+ bytes, kept in result-\d+-[0-9a-f]{8}\.json]/);
    assert.doesNotMatch(event.result.content, /read via compact/, 'do not advertise a tool that is not registered');
    assert.ok(Buffer.byteLength(event.result.content, 'utf8') <= 200);
    const spilled = await readFile(join(directory, event.result.spilled!), 'utf8');
    assert.equal(spilled, JSON.stringify({ text: 'y'.repeat(500) }));
  });
});

test('a read result reaches the session log with its content intact', async () => {
  await withDirectory(async (directory) => {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'the file content');
    const session = createSessionLog({ directory, id: 'run-5' });
    const kernel = createKernel({
      config: createConfig({ user: { boundary: workspace } }),
      session,
    });
    kernel.register(readTool);
    assert.deepEqual(await kernel.call('read', { path: 'note.txt' }), { text: 'the file content' });
    assert.deepEqual(await session.modelView(), [
      { role: 'tool', id: undefined, tool: 'read', content: { text: 'the file content' }, failed: false, code: undefined },
    ]);
  });
});

test('a refusal reaches the model as a sentence instead of an empty result', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-9' });
    const call = { id: 'call_1', name: 'exec', args: { command: 'npm test' } };
    await session.append({ kind: 'assistant', text: '', toolCalls: [call] });
    await session.append({ kind: 'tool', tool: 'exec', callId: call.id, args: call.args, result: refusalOf('ask_declined', 'the user declined') });
    assert.deepEqual(await session.modelView(), [
      { role: 'assistant', text: '', toolCalls: [call] },
      { role: 'tool', id: 'call_1', tool: 'exec', content: 'ask_declined: the user declined', failed: true, code: 'ask_declined' },
    ]);
  });
});

test('reading an unchanged session reuses its parse and an append replaces it', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-cache' });
    await session.append({ kind: 'user', text: 'first' });
    await session.append({ kind: 'assistant', text: 'second' });
    const first = await session.read();
    assert.equal(first.length, 2);
    // 命中缓存时仍返回独立数组：读取方就地删减不能影响下一次读取。
    first.pop();
    assert.equal((await session.read()).length, 2);
    const third = await session.append({ kind: 'user', text: 'third' });
    const after = await session.read();
    assert.deepEqual(after.map((event) => event.seq), [0, 1, third.seq]);
    assert.equal(after.at(-1)?.kind, 'user');
  });
});
