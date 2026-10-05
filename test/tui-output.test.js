// 第 46 步的验收：导出的那一份 markdown、终端标题那一串、剪贴板那一段字节。
// 排版与编码都是纯计算；落盘那一条只写进临时目录；`/export` 那一条走真的 Ink 渲染路径喂按键。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportMarkdown, titleEscape, titleText, writeExport } from '../dist/tui/output.js';
import { clipboardPayload, copyToClipboard, lastAnswer } from '../dist/tui/clipboard.js';
import { routeInput } from '../dist/tui/commands.js';

let missing = '';
try {
  await import('../dist/tui/app.js');
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
}

const options = { skip: missing === '' ? false : missing };

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

test('the terminal title drops the characters that could end its own escape', () => {
  assert.equal(titleText({ model: 'test-model', boundary: '/work', sessionId: '0123456789' }), 'test-model · /work · 01234567');
  assert.equal(titleText({ model: 'm\u001B]0;pwn\u0007', boundary: '/w\nork', sessionId: 'abc' }), 'm]0;pwn · /work · abc');
  assert.equal(titleText({ model: 'x'.repeat(200), boundary: '/work', sessionId: 'abc' }).length, 120, '再长也只写到那么宽');
  const ESC = String.fromCharCode(27);
  assert.equal(titleEscape('abc'), ESC + ']0;abc' + ESC + String.fromCharCode(92), '开头与收尾都是那一个转义引导符，不留 BEL');
});

test('the clipboard payload is the encoding the local program reads back', async () => {
  assert.equal(clipboardPayload('阶段', 'win32').toString('utf16le'), '阶段');
  assert.deepEqual([...clipboardPayload('ab', 'win32')], [0x61, 0x00, 0x62, 0x00], '不带 BOM：那两个字节会留在剪贴板开头');
  assert.equal(clipboardPayload('阶段', 'darwin').toString('utf8'), '阶段');
  assert.deepEqual(await copyToClipboard('这一串不交给任何程序', 'freebsd'), { code: 'tui_clipboard_unavailable' }, '本机没有那一条路就说出来');

  assert.equal(lastAnswer([{ seq: 0, kind: 'assistant', text: '第一段' }, { seq: 1, kind: 'tool' }, { seq: 2, kind: 'assistant', text: '' }, { seq: 3, kind: 'assistant', text: '最新的一段' }]), '最新的一段',
    '取记录里最后那条有正文的回答，流式那半截不在记录里');
  assert.equal(lastAnswer([{ seq: 0, kind: 'user', text: '只有问的' }]), '');

  assert.equal(routeInput('/copy', true).kind, 'command', '复制与导出都不改动这一轮，跑着的时候能用');
  assert.equal(routeInput('/export 笔记/这次运行.md', true).kind, 'command');
});

test('/export writes this record as markdown and one file per branch', options, async () => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const root = await mkdtemp(join(tmpdir(), 'ligule-export-'));
  const path = join(root, 'notes', 'run.md');
  const branchEvents = [{ seq: 0, kind: 'user', text: '支线里问的那一句' }];
  const parent = [...events, { seq: 6, kind: 'tool', tool: 'subagent', callId: 'c9', result: { content: { sessionId: 's-1.sub-1', text: '支线答完的话' } } }];
  const client = {
    onNotification() {},
    onRequest() {},
    request: async (method, params) => {
      if (method === 'session.read') return { sessionId: params.sessionId, events: params.sessionId === 's-1' ? parent : branchEvents };
      return { sessionId: 's-1', running: false, mode: 'full', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['read'], eventCount: 0, denials: { consecutive: 0, total: 0 }, templates: [], usage: null };
    },
    reply: () => {},
  };
  const instance = render(createElement(App, { client, sessionId: 's-1', info: {}, interactive: true, stdout }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await delay(300);
    stdin.write(`/export ${path}`);
    await delay(100);
    stdin.write('\r');
    await delay(600);
    const written = [path, join(root, 'notes', 'run.s-1.sub-1.md')];
    assert.match(painted, /已写出 2 份文件/, '说清写了哪两份');
    assert.match(await readFile(path, 'utf8'), /第 2 条 · read 的结果/);
    assert.match(await readFile(written[1], 'utf8'), /支线里问的那一句/, '派生支线另写一份，内容它那一条线自己的');
  } finally {
    instance.unmount();
    await rm(root, { recursive: true, force: true });
  }
});
