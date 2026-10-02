// 终端界面的行、输入与折叠（D33 的第二种客户端）。ink 与 react 是可选依赖，装不上时这一份整份跳过，
// 与那两条比较真实检索后端的检查同一个处理：不能假造一个后端来通过。
import test from 'node:test';
import assert from 'node:assert/strict';

let rows = {};
let missing = '';
try {
  rows = await import('../src/tui/app.js');
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
}

const options = { skip: missing === '' ? false : missing };
const { foldText, parseInput, editDraft, projectRecord } = rows;

test('a record becomes the rows the terminal shows, one line each', options, () => {
  assert.deepEqual(projectRecord({ kind: 'user', text: '读一下' }), [{ kind: 'question', text: '读一下' }]);
  assert.deepEqual(projectRecord({ kind: 'reasoning', text: '先看' }), [{ kind: 'reasoning', text: '先看' }]);
  assert.deepEqual(
    projectRecord({ kind: 'assistant', text: '我来读', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'note.txt' } }] }),
    [
      { kind: 'answer', text: '我来读' },
      { kind: 'call', tool: 'read', text: '{"path":"note.txt"}' },
    ],
  );
});

test('an assistant record with only tool calls leaves no empty answer line', options, () => {
  assert.deepEqual(projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'exec', args: {} }] }),
    [{ kind: 'call', tool: 'exec', text: '{}' }]);
});

test('a refusal reads as a refusal, a failure as a failure, and structured content is drawn as text', options, () => {
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'the user declined', content: '' } }),
    [{ kind: 'refusal', tool: 'exec', text: 'the user declined', code: 'ask_declined' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'failure', failed: true, code: 'exec_timeout', reason: undefined, content: '' } }),
    [{ kind: 'failure', tool: 'exec', text: '', code: 'exec_timeout' }],
  );
  const [row] = projectRecord({ kind: 'tool', tool: 'read', result: { kind: 'result', failed: false, code: undefined, content: { text: 'a body' } } });
  assert.equal(row.kind, 'result');
  assert.match(row.text, /"text": "a body"/);
});

test('a record kind the terminal does not draw yields no rows instead of guessing', options, () => {
  assert.deepEqual(projectRecord({ kind: 'something-new' }), []);
});

test('input starting with a slash is a command, anything else is the user message', options, () => {
  assert.deepEqual(parseInput('  读一下 note.txt  '), { kind: 'text', text: '读一下 note.txt' });
  assert.deepEqual(parseInput('/tools'), { kind: 'command', name: 'tools', argument: '' });
  assert.deepEqual(parseInput('/MODE now'), { kind: 'command', name: 'mode', argument: 'now' });
});

test('the draft edits around a caret instead of only appending', options, () => {
  assert.deepEqual(editDraft('abc', 3, 'd', {}), { draft: 'abcd', caret: 4 });
  assert.deepEqual(editDraft('abcd', 4, '', { leftArrow: true }), { draft: 'abcd', caret: 3 });
  assert.deepEqual(editDraft('abcd', 3, '', { backspace: true }), { draft: 'abd', caret: 2 });
  assert.deepEqual(editDraft('abcd', 4, '', { home: true }), { draft: 'abcd', caret: 0 });
  assert.deepEqual(editDraft('abcd', 0, '', { end: true }), { draft: 'abcd', caret: 4 });
  assert.deepEqual(editDraft('rm -rf  ', 8, 'w', { ctrl: true }), { draft: 'rm ', caret: 3 });
  assert.deepEqual(editDraft('oops', 4, 'u', { ctrl: true }), { draft: '', caret: 0 });
  // 粘贴一次交回一整段：所有字符都进草稿，光标落在末尾。
  assert.deepEqual(editDraft('> ', 2, 'a\nb', {}), { draft: '> a\nb', caret: 5 });
});

test('long content folds to a few lines and counts what is hidden', options, () => {
  const six = ['1', '2', '3', '4', '5', '6'].join('\n');
  assert.deepEqual(foldText(six, false), { shown: '1\n2\n3', hidden: 6 });
  assert.deepEqual(foldText(six, true), { shown: six, hidden: 0 });
  assert.deepEqual(foldText('one\n two', false, 1), { shown: 'one', hidden: 5 });
  // 一整段没有换行的 JSON 也要折得住，否则一块长文本就把屏幕压掉了。
  const long = 'x'.repeat(500);
  assert.deepEqual(foldText(long, false, 3, 400), { shown: 'x'.repeat(400), hidden: 100 });
  // 结构化的一段内容按文本折，不出现 [object Object]。
  assert.equal(foldText({ text: 'a body' }, false).shown.includes('[object Object]'), false);
});

test('the app paints the session line and the input hint onto the terminal', options, async () => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../src/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.isTTY = false;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = new PassThrough();
  stdin.isTTY = false;

  const client = {
    onNotification() {},
    onRequest() {},
    request: async () => ({ mode: 'ask', tools: ['read'], eventCount: 0, running: false, denials: { consecutive: 0, total: 0 } }),
    reply() {},
  };
  const instance = render(
    createElement(App, { client, sessionId: 'abcdef01-2345-6789', info: { model: 'test-model' }, interactive: false }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  await delay(200);
  instance.unmount();

  assert.match(painted, /test-model · 会话 abcdef01/);
  assert.match(painted, /档位 ask · 工具 1 件/);
  assert.match(painted, /\/help 看命令/);
});
