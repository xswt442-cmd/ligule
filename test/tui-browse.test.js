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
