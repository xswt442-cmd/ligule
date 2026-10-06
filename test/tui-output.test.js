// 第 46 步的验收：导出的那一份 markdown、终端标题那一串、剪贴板那一段字节。
// 排版与编码都是纯计算；落盘那一条只写进临时目录；`/export` 那一条走真的 Ink 渲染路径喂按键。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exportMarkdown, titleEscape, titleText, writeExport } from '../dist/tui/output.js';
import { clipboardPayload, copyToClipboard, lastAnswer } from '../dist/tui/clipboard.js';
import { routeInput } from '../dist/tui/commands.js';
import { withTuiHost } from './helpers/tui-host.js';

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

test('the exported markdown preserves consecutive blank lines in the original body', () => {
  const text = exportMarkdown([{ seq: 8, kind: 'assistant', text: '第一段\n\n\n第二段' }], { id: 's-8' });
  assert.ok(text.includes('第一段\n\n\n第二段'));
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

test('/export writes real host and subagent records as markdown', options, async () => withTuiHost(async ({ client, sessionId, directory, config, requests }) => {
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

  const exportDirectory = join(directory, 'export');
  const projectDirectory = config.boundary;
  await mkdir(exportDirectory, { recursive: true });
  const path = join(exportDirectory, 'run.md');
  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true, stdout }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await delay(300);
    await client.request('mode.set', { sessionId, name: 'full' });
    let runFinished = false;
    const run = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'subagent', args: { task: '支线导出验证' } }) })
      .finally(() => { runFinished = true; });
    for (let attempt = 0; attempt < 40 && !runFinished && !painted.includes('要执行 subagent'); attempt += 1) await delay(100);
    if (painted.includes('要执行 subagent')) stdin.write('y');
    await run;
    const parentRead = await client.request('session.read', { sessionId, fullResults: true });
    const branchEvent = parentRead.events.find((event) => event.kind === 'tool' && event.tool === 'subagent');
    const branchId = branchEvent?.result?.content?.sessionId;
    assert.equal(typeof branchId, 'string', '支线 id 来自 Host 记录的真实 subagent 结果');
    const branchRead = await client.request('session.read', { sessionId: branchId, fullResults: true });
    assert.equal(branchRead.header.projectRoot, projectDirectory);
    assert.ok(branchRead.events.some((event) => event.kind === 'user' && event.text === '支线导出验证'));

    stdin.write(`/export ${path}`);
    await delay(100);
    stdin.write('\r');
    await delay(600);
    const branchPath = join(exportDirectory, `run.${branchId}.md`);
    assert.match(painted, /已写出 2 份文件/, '说清写了哪两份');
    const mainText = await readFile(path, 'utf8');
    const branchText = await readFile(branchPath, 'utf8');
    assert.match(mainText, new RegExp(`# ligule 会话 ${sessionId}`));
    assert.match(mainText, new RegExp(`- 项目根：${projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(mainText, /一次调用 · subagent/);
    assert.ok(mainText.includes('支线导出验证'));
    assert.match(branchText, new RegExp(`# ligule 会话 ${branchId}`));
    assert.match(branchText, new RegExp(`- 项目根：${projectDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(branchText.includes('Local response: 支线导出验证'));
    assert.ok(requests.some((request) => request.method === 'session.read' && request.params.sessionId === branchId && request.params.fullResults === true));
  } finally {
    instance.unmount();
  }
}));
