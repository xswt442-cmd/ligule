// 终端界面的行投影（D33 的第二种客户端）。ink 与 react 是可选依赖，装不上时这一条整份跳过，
// 与那两条比较真实检索后端的检查同一个处理：不能假造一个后端来通过。
import test from 'node:test';
import assert from 'node:assert/strict';

let projectRecord;
let missing = '';
try {
  ({ projectRecord } = await import('../src/tui/app.js'));
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
}

const options = { skip: missing === '' ? false : missing };

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
  const rows = projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'exec', args: {} }] });
  assert.deepEqual(rows, [{ kind: 'call', tool: 'exec', text: '{}' }]);
});

test('a tool that did not finish is a failure row carrying its code, and the refusal reason wins over content', options, () => {
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { failed: true, code: 'exec_timeout', content: '', reason: undefined } }),
    [{ kind: 'failure', tool: 'exec', text: '', code: 'exec_timeout' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'exec', result: { failed: true, code: 'ask_declined', content: '', reason: '客户端没有允许' } }),
    [{ kind: 'failure', tool: 'exec', text: '客户端没有允许', code: 'ask_declined' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'tool', tool: 'read', result: { failed: false, content: 'the body' } }),
    [{ kind: 'result', tool: 'read', text: 'the body', code: undefined }],
  );
});

test('a record kind the terminal does not draw yields no rows instead of guessing', options, () => {
  assert.deepEqual(projectRecord({ kind: 'something-new' }), []);
});

// 组件那一头也跑一次：把 App 画到一个假标准输出上，确认行与提示真的到了屏幕上。
// 真终端里的按键与重画不在这里验，那一条要人站在终端前看。
test('the app paints the session line and the input hint onto the terminal', { skip: missing === '' ? false : missing }, async () => {
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
    request: async () => ({ mode: 'ask', tools: ['read'], eventCount: 0, running: false }),
    reply() {},
  };
  const instance = render(createElement(App, { client, sessionId: 'abcdef01-2345-6789', interactive: false }), { stdout, stdin, exitOnCtrlC: false });
  await delay(200);
  instance.unmount();

  assert.match(painted, /会话 abcdef01/);
  assert.match(painted, /档位 ask · 工具 1 件/);
  assert.match(painted, /Enter 发送/);
});
