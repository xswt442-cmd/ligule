import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { Box } from 'ink';
import { MessageRow } from '../dist/tui/message-view.js';
import { foldText, foldTextForColumns, toolCallSummary } from '../dist/tui/message-format.js';
import { wrapLine } from '../dist/tui/viewport.js';
import { projectRecord } from '../dist/tui/transcript.js';

const stripAnsi = (value) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

async function paint(rows, columns, expanded = false) {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 30, isTTY: true });
  let output = '';
  stdout.on('data', (chunk) => { output += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref() {}, unref() {} });
  const { render } = await import('ink');
  const instance = render(createElement(Box, { flexDirection: 'column' }, ...rows.map((row, index) => createElement(MessageRow, {
    key: index, row, expanded, columns,
  }))), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  return output;
}

test('folding preserves original content when expanded and bounds previews otherwise', () => {
  const value = `${'路径😀'.repeat(30)}\nsecond\nthird\nfourth`;
  const preview = foldText(value, false, 3, 80);
  assert.ok(preview.shown.length <= 80);
  assert.equal(preview.hidden, value.length - preview.shown.length);
  assert.deepEqual(foldText(value, true), { shown: value, hidden: 0 });
  assert.deepEqual(toolCallSummary(JSON.stringify({ path: '工作区/很长的目录/文件.ts', command: 'node script.js', token: 'private' })), {
    summary: 'path: 工作区/很长的目录/文件.ts · command: node script.js · +1 other field', hasDetails: true,
  });
  assert.equal(toolCallSummary('{invalid').hasDetails, true);
  const narrow = foldTextForColumns(`${'超长路径😀'.repeat(40)}\n尾行`, false, 24, 3);
  assert.ok(wrapLine(narrow.shown, 24).length <= 3, 'preview budget follows terminal display columns, including wide glyphs');
  assert.equal(narrow.hidden, `${'超长路径😀'.repeat(40)}\n尾行`.length - narrow.shown.length);
});

test('real session-event projections retain text, tool identity, result state and error codes at narrow and wide widths', async () => {
  const userText = '请检查 中文路径😀/目录/超长文件名.ts 并保留原文';
  const assistantText = '回答正文有自然换行。\n\n代码路径 `src/目录/very-long-file-name.ts` 保持原样。';
  const longResult = `输出开始\n${'结果行😀 '.repeat(80)}\n输出结束 marker`;
  const events = [
    { seq: 1, kind: 'user', raw: userText },
    { seq: 2, kind: 'assistant', text: assistantText, toolCalls: [{ name: 'exec', args: { command: 'node script.js', cwd: '工作区/项目', secret: '保持完整参数' } }, { name: 'custom', args: { private: '保留详情' } }, { name: 'read', args: { path: '路径\u001b[31m\u202eevil.txt' } }] },
    { seq: 3, kind: 'tool', tool: 'exec', args: { command: 'node script.js', cwd: '工作区/项目' }, result: { content: { text: longResult, exitCode: 0 }, failed: false } },
    { seq: 4, kind: 'tool', tool: 'write', args: { path: '中文/文件.ts' }, result: { kind: 'refusal', failed: true, code: 'policy_write_denied', reason: '审批规则拒绝了此写入。'.repeat(30), content: '' } },
    { seq: 5, kind: 'tool', tool: 'exec', args: {}, result: { kind: 'failure', failed: true, code: 'exec_cancelled', reason: '由用户取消' } },
    { seq: 6, kind: 'tool', tool: 'read', args: {}, result: { kind: 'failure', failed: true, code: 'file_read_failed', reason: '实际失败信息' } },
    { seq: 7, kind: 'tool', tool: 'provider', args: {}, result: { kind: 'failure', failed: true, code: 'provider_unavailable', reason: '服务不可用' } },
  ];
  const rows = events.flatMap((event) => projectRecord(event));
  for (const columns of [120, 24]) {
    const preview = stripAnsi(await paint(rows, columns));
    const compact = preview.replace(/\s/g, '');
    assert.ok(compact.includes(userText.replace(/\s/g, '')), `user content remains at ${columns} columns: ${preview}`);
    assert.ok(compact.includes('exec'), 'call preview names the real tool');
    if (columns === 120) assert.ok(compact.includes('command:nodescript.js·cwd:工作区/项目'), 'wide call summary names useful target fields');
    assert.ok(preview.includes('Ctrl+O'), 'folded details point to the existing transcript/detail view');
    assert.ok(!preview.includes('保持完整参数'), 'call preview does not dump every argument');
    assert.ok(preview.includes('policy_write_denied'), 'refusal keeps its state code');
    assert.ok(preview.includes('拒绝请求'), 'policy refusal is not described as the user refusing');
    assert.ok(preview.includes('exec_cancelled') && preview.includes('已取消'), 'explicit cancellation keeps its code and status');
    assert.ok(preview.includes('file_read_failed') && preview.includes('失败'), 'failure keeps its code and status');
    assert.ok(preview.includes('provider_unavailable') && preview.includes('不可用'), 'unavailable has its own status');
    assert.ok(preview.includes('输出开始') && !preview.includes('输出结束 marker'), 'long output is bounded by a preview');
    if (columns === 120) assert.ok(preview.includes('\\u001b') && preview.includes('\\u202e'), 'decoded control and bidi characters are escaped in the summary');
    assert.ok(!preview.includes('审批规则拒绝了此写入。'.repeat(10)), 'refusal reason is a bounded preview');
    assert.ok(preview.includes('完整参数'), 'unknown argument fields advertise full detail access');
  }
  const expanded = stripAnsi(await paint(rows, 24, true));
  assert.ok(expanded.includes('保持完整参数'), 'expanded call shows the original complete arguments');
  assert.ok(expanded.includes('保留详情'), 'expanded call shows fields omitted from its summary');
  assert.ok(expanded.includes('输出结束 marker'), 'expanded result shows the original complete output');
  assert.ok(expanded.replace(/\s/g, '').includes('src/目录/very-long-file-name.ts'), `assistant markdown remains readable at narrow width: ${expanded}`);
});

test('NO_COLOR keeps tool outcome symbols and labels readable without color SGR', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const rows = [
      ...projectRecord({ seq: 1, kind: 'tool', tool: 'write', args: {}, result: { kind: 'refusal', failed: true, code: 'policy_write_denied', content: '' } }),
      ...projectRecord({ seq: 2, kind: 'tool', tool: 'exec', args: {}, result: { kind: 'failure', failed: true, code: 'exec_cancelled', reason: 'cancelled' } }),
      ...projectRecord({ seq: 3, kind: 'tool', tool: 'read', args: {}, result: { kind: 'failure', failed: true, code: 'file_read_failed', reason: 'failed' } }),
      ...projectRecord({ seq: 4, kind: 'tool', tool: 'provider', args: {}, result: { kind: 'failure', failed: true, code: 'provider_unavailable', reason: 'unavailable' } }),
    ];
    const output = await paint(rows, 80);
    assert.doesNotMatch(output, /\x1B\[[0-9;]*m/, 'NO_COLOR suppresses ANSI color sequences');
    const plain = stripAnsi(output);
    assert.ok(plain.includes('⚑') && plain.includes('拒绝请求'));
    assert.ok(plain.includes('↷') && plain.includes('已取消'));
    assert.ok(plain.includes('✗') && plain.includes('失败'));
    assert.ok(plain.includes('◌') && plain.includes('不可用'));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
