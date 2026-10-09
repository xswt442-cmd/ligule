import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { completeFrame } from './helpers/frames.js';
import { App } from '../dist/tui/app.js';
import { waitFor, withTuiHost } from './helpers/tui-host.js';

async function withApp(context, run) {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const frame = () => completeFrame(painted);
  const output = () => painted.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const instance = render(createElement(App, { client: context.client, sessionId: context.sessionId, stdout, info: { boundary: context.config.boundary } }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, interactive: true });
  const wait = (condition) => waitFor(condition, { read: frame });
  const type = async (text) => { stdin.write(text); await delay(50); stdin.write('\r'); };
  try {
    await wait(() => frame().includes('policy:ask'));
    await run({ frame, output, stdin, type, wait, stdout });
  } finally {
    instance.unmount();
  }
}

test('complete history opens in a bounded viewport and keyboard navigation reaches both ends', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    const text = Array.from({ length: 60 }, (_, index) => `历史行 ${index}`).join('\n');
    await type(text);
    await wait(() => context.notifications.some((notice) => notice.event?.kind === 'assistant'));
    await delay(80);
    stdin.write('\x0f');
    await wait(() => frame().includes('会话完整历史'));
    await delay(100);
    stdin.write('\x1b[H');
    await wait(() => frame().includes('第 1/'));
    assert.ok(frame().split('\n').length <= 24, '动态历史视图受终端高度约束');
    stdin.write('\x1b[6~');
    await wait(() => !frame().includes('第 1/'));
    stdin.write('\x1b[F');
    await wait(() => frame().includes('历史行 59'));
    stdin.write('\x1b');
    await wait(() => !frame().includes('会话完整历史'));
  }));
});

test('an approval exposes its entire change through pages and Escape cancels without writing', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    const content = Array.from({ length: 40 }, (_, index) => `待审批内容 ${index}`).join('\n');
    await type(JSON.stringify({ tool: 'create', args: { path: 'approval.md', content } }));
    await wait(() => frame().includes('要执行 create'));
    stdin.write('\x0f');
    await wait(() => frame().includes('要换上的那一段:'));
    await wait(() => /改动第 1\/\d+ 行/.test(frame()));
    stdin.write('\x1b[F');
    await wait(() => frame().includes('待审批内容 39'));
    stdin.write('\x1b');
    await wait(() => output().includes('这一轮已被打断'));
    await assert.rejects(access(join(context.config.boundary, 'approval.md')), (error) => error.code === 'ENOENT');
    assert.ok(context.requests.some((request) => request.method === 'run.cancel'));
  }));
});

// 模型的提问（D107）：一次一到四道题，逐题作答，最后一题回车才把整份答复交回去。
// 编号命中选项就算选中，其余文本原样作为自由回答——这条走的是真按键，不是直接调那一个回调。
const askFrame = () => JSON.stringify({
  tool: 'ask_user_question',
  args: {
    questions: JSON.stringify([
      { question: '要装哪一份依赖管理器？', header: '依赖', options: [{ label: 'npm' }, { label: 'pnpm', description: '装得更快' }] },
      { question: '还有别的要一起改吗？', multiSelect: true },
    ]),
  },
});

test('a question answers one item per Enter, lets an unsubmitted answer be changed and sends them together', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, stdin, type, wait }) => {
    await type(askFrame());
    await wait(() => frame().includes('模型在问 2 道题，现在答第 1 道'));
    assert.ok(frame().includes('2. pnpm —— 装得更快'), '题面画出那几条选项与它们的说明');
    assert.ok(frame().includes('这一格没有回答时限'), '画面上说的是这一格会不会自己走掉');

    await type('2');
    await wait(() => frame().includes('现在答第 2 道'));
    await wait(() => frame().includes('第 1 道已记下：pnpm'));

    // 上一题还没交出去，要能改：草稿空着时按 ← 退回那一题，刚才写的原文回到草稿里，删掉重写就是改过的那一份。
    stdin.write('\x1b[D');
    await wait(() => frame().includes('现在答第 1 道'));
    stdin.write('\x7f');
    // 退格与下一个字之间要留一拍：连着写时假终端把两串字节交在同一次投递里，那一记退格就没落到画面上。
    await delay(150);
    await type('1');
    await wait(() => frame().includes('第 1 道已记下：npm'), '改过的那一份才是要交出去的');

    await type('顺手把 README 也改一下');
    await wait(() => output().includes('本轮结束'));
    const sent = JSON.stringify(context.providerRequests.at(-1));
    assert.ok(sent.includes('答：npm'), '交回模型的是改过那一份，不是第一次写的');
    assert.ok(sent.includes('答：顺手把 README 也改一下'));
  }), { interactive: true });
});

// 取消是这一格唯一能走掉的路：打断这一轮之后画面不再留着那道没人答的题。
test('interrupting the round takes the pending question away with it', async () => {
  await withTuiHost(async (context) => withApp(context, async ({ frame, output, type, wait }) => {
    await type(askFrame());
    await wait(() => frame().includes('模型在问 2 道题，现在答第 1 道'));
    await context.client.request('run.cancel', { sessionId: context.sessionId });
    await wait(() => output().includes('这一轮已被打断'));
    await delay(120);
    assert.ok(!frame().includes('模型在问'), '打断之后这一格收掉了');
    const { events } = await context.client.request('session.read', { sessionId: context.sessionId });
    assert.ok(events.some((event) => event.result?.code === 'ask_user_cancelled'), '记录里说的是这一题被取消，不是超时');
  }), { interactive: true });
});
