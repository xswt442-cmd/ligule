// 方案 6A 的验收：一份记录排成 markdown、落到人选定的那个位置，这件事只有宿主这一份实现。
// 排版是纯计算；那一次写出走真的协议与真的临时目录，落点由调用方给。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchSessionId, exportMarkdown } from '../dist/host/export.js';
import { waitFor, withTuiHost } from './helpers/tui-host.js';

const events = [
  { kind: 'session', formatVersion: 1, sessionId: 's-1', projectRoot: '/work', createdAt: '2026-10-05T00:00:00.000Z' },
  { seq: 0, kind: 'user', text: '看一眼 note.txt', raw: '/看看 note' },
  { seq: 1, kind: 'assistant', text: '第一段回答', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'note.txt' } }] },
  { seq: 2, kind: 'tool', tool: 'read', callId: 'c1', result: { content: '第一行原文' } },
  { seq: 3, kind: 'tool', tool: 'exec', callId: 'c2', result: { content: '没了', failed: true, code: 'exec_exit_1' } },
  { seq: 4, kind: 'mode', name: 'full', layer: 'shipped', tools: ['*'] },
  { seq: 5, kind: 'usage', input: 8351, output: 39, estimated: 13 },
];

test('the exported markdown gives each call and each result its own section', () => {
  const text = exportMarkdown(events, { id: 's-1', projectRoot: '/work', createdAt: '2026-10-05T00:00:00.000Z' });
  assert.match(text, /^# ligule 会话 s-1$/m);
  assert.match(text, /- 项目根：\/work/);
  assert.match(text, /第 0 条 · 你说\n\n\/看看 note/, '写出去的是人原本打的那一行（D54）');
  assert.match(text, /第 1 条的一次调用 · read/);
  assert.match(text, /第 2 条 · read 的结果\n\n第一行原文/);
  assert.match(text, /（这一次没做成）/, '没做成的那一次在段子里说得出来');
  assert.match(text, /第 4 条：模式 full（shipped）生效/);
  assert.doesNotMatch(text, /8351/, '用量那一条不是对话的一段，不写出去');
  assert.equal(text.split('\n## ').length - 1, 2, '问的那一条与答的那一条各成一段');
  assert.equal(text.split('\n### ').length - 1, 3, '那一次调用与两次结果各自一段');
});

test('the exported markdown preserves consecutive blank lines in the original body', () => {
  const text = exportMarkdown([{ seq: 8, kind: 'assistant', text: '第一段\n\n\n第二段' }], { id: 's-8' });
  assert.ok(text.includes('第一段\n\n\n第二段'));
});

test('the branch id comes from that derived result and nothing else', () => {
  assert.equal(branchSessionId({ kind: 'tool', tool: 'subagent', result: { content: { sessionId: 'b-1' } } }), 'b-1');
  assert.equal(branchSessionId({ kind: 'tool', tool: 'read', result: { content: { sessionId: 'b-1' } } }), undefined, '别的工具结果里同名的那一格不算支线');
  assert.equal(branchSessionId({ kind: 'tool', tool: 'subagent', result: { content: '整段溢出了', spilled: 's-1-3.json' } }), undefined,
    '结果内容溢出到文件时记录里就没有这一格');
});

test('session.export writes the record to the path the caller names', async () => withTuiHost(async ({ client, sessionId, directory, requests }) => {
  await client.request('run.start', { sessionId, input: '说一句就好' });
  const path = join(directory, 'note', '这一轮.md');
  const done = await client.request('session.export', { sessionId, path });
  assert.deepEqual(done.skipped, [], '没有派生支线就没有漏写的那一份');
  assert.deepEqual(done.written, [path], '交回的是写出去的那一条路径');
  const text = await readFile(path, 'utf8');
  assert.match(text, new RegExp(`# ligule 会话 ${sessionId}`));
  assert.match(text, /说一句就好/);
  assert.match(text, /Local response: 说一句就好/, '模型那一条也在同一份文件里');
  assert.doesNotMatch(text, /还在跑/, '那一轮已经跑完，这份文件就不是半截的读数');
  assert.ok(requests.some((request) => request.method === 'session.export' && request.params.path === path),
    '界面只交出一个目的地，排版与落盘都在宿主那一侧');
}));

test('exporting while the round is still running says the tail is unfinished', async () => withTuiHost(async ({ client, sessionId, directory, notifications }) => {
  // 模型服务故意等两秒（`delayMs`）：那一段时间里这一轮还在往下写，导出读到的是中途的末端。
  const round = client.request('run.start', { sessionId, input: '说一句就好' });
  await waitFor(
    () => notifications.some((message) => message.notify === 'event' && message.event.kind === 'user'),
    { read: () => JSON.stringify(notifications) },
  );
  const path = join(directory, 'half.md');
  await client.request('session.export', { sessionId, path });
  assert.match(await readFile(path, 'utf8'), /^> 导出这一刻这一份会话还在跑/m,
    '那一份文件在开头就说出后面还会写，不让人把中途的末端当成整轮');
  await round;
}, { delayMs: 2_000 }));

test('session.export reports a stable code when the destination cannot be written', async () => withTuiHost(async ({ client, sessionId, directory }) => {
  await client.request('run.start', { sessionId, input: '说一句就好' });
  const blocker = join(directory, 'blocked');
  await writeFile(blocker, '这是一个文件，不是一处目录');
  await assert.rejects(
    client.request('session.export', { sessionId, path: join(blocker, 'run.md') }),
    (error) => error.code === 'host_export_write_failed',
    '对话框返回路径不等于文件已经写成',
  );
}));

test('session.export needs both a session and a destination', async () => withTuiHost(async ({ client, sessionId }) => {
  await assert.rejects(
    client.request('session.export', { sessionId }),
    (error) => error.code === 'protocol_args_invalid',
    '目的地说不出就落到调用之前，不去猜一个位置');
}));
