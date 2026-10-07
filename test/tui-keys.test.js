// 个人键位那一份表的检查（方案 6.1、第 87 步）。这几条会换模块级的那一份当前键位，所以单独一份文件：
// 同一个文件里的顶层检查是并发调度的，把 `send` 改走会波及同文件里别的喂按键的检查——那类检查跑的是默认那一份表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitFor, withTuiHost } from './helpers/tui-host.js';

let rows = {};
let missing = '';
const previousForceColor = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = '1';
try {
  rows = await import('../dist/tui/app.js');
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
} finally {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
}

const options = { skip: missing === '' ? false : missing };
const { KEYMAP, CURRENT, applyOverrides, conflictsIn, defaultSpecs, formatKeys, hit, keyHint, parseSpec, specOf } = rows;

test('the key table is the one place both the dispatch and the names on screen read', () => {
  assert.equal(specOf('', { return: true }), 'enter');
  assert.equal(specOf('', { return: true, shift: true }), 'shift+enter');
  assert.equal(specOf('r', { ctrl: true }), 'ctrl+r');
  assert.equal(specOf('Y', {}), 'y', '大写的 Y 与 y 是同一记键');
  assert.equal(specOf('', { upArrow: true, shift: true }), 'shift+arrowup');
  assert.equal(specOf('Control', {}), null, '光按住修饰键不是一记绑定');
  assert.equal(hit('send', '', { return: true }), true);
  assert.equal(hit('pick-path', '', { return: true }), true, 'Enter 在两个范围各有各的落：这一处只问那一个动作');
  assert.equal(hit('send', '', { return: true, shift: true }), false, '带 Shift 的那一记不是发送');
  assert.equal(formatKeys('pageup'), 'PageUp');
  assert.equal(keyHint('list-up', 'list-down'), '↑/↓', '提示里那一串键名也从同一份表拼出来');
  // 默认那一份表里同一个范围不撞：撞了就说明界面写着的那一记键与按下落的事对不上。
  for (const view of [...new Set(Object.values(KEYMAP).map((binding) => binding.view))]) {
    assert.deepEqual(conflictsIn(view, CURRENT), [], `${view} 里那几记键不撞`);
  }
  for (const [action, binding] of Object.entries(KEYMAP)) {
    assert.ok(binding.label !== '' && binding.view !== '', `${action} 要说得出做什么与落在哪一个范围`);
    assert.equal(CURRENT[action], binding.spec, `${action} 的默认键读得回来`);
  }
});

test('a personal key binding is read, applied, or refused by name', () => {
  assert.equal(parseSpec('Ctrl+Shift+K'), 'ctrl+shift+k');
  assert.equal(parseSpec('  enter '), 'enter');
  assert.equal(parseSpec('up'), 'arrowup');
  assert.equal(parseSpec('ctrl+'), null, '缺一记键名不算一记键');
  assert.equal(parseSpec('hyper+k'), null, '表里没有的那一个修饰键不猜');
  assert.equal(parseSpec('Control'), null, '光按住修饰键不是一记绑定');
  const outcome = applyOverrides({ send: 'ctrl+x', 表里没有: 'ctrl+y' });
  assert.deepEqual(outcome.applied, ['send']);
  assert.deepEqual(outcome.refused, ['表里没有（表里没有这一个动作）'], '名字对不上就说出来，不悄悄丢掉');
  assert.equal(hit('send', 'x', { ctrl: true }), true, '改过之后那一记键落的是发送');
  assert.equal(hit('send', '', { return: true }), false, '原先那一记键不再落发送');
  assert.equal(keyHint('send'), 'Ctrl+X', '画面说的那串字跟着换');
  applyOverrides(defaultSpecs());
  assert.equal(keyHint('send'), 'Enter', '回到默认那一份');
});

test('the key file keeps only bindings it can read and names what it dropped', async () => {
  const { readKeys, writeKeys } = await import('../dist/tui/key-store.js');
  const directory = await mkdtemp(join(tmpdir(), 'ligule-keys-'));
  const path = join(directory, 'tui-keys.json');
  try {
    await writeKeys(path, { send: 'ctrl+x', editor: 'bogus+1' });
    const loaded = await readKeys(path);
    assert.deepEqual(loaded.overrides, { send: 'ctrl+x' }, '读不懂的那一格不落下');
    assert.deepEqual(loaded.refused, ['editor=bogus+1'], '哪一格没落下要说得出');
    const absent = await readKeys(join(directory, 'nope.json'));
    assert.deepEqual(absent, { overrides: {}, refused: [] }, '那份文件不在就是没有覆盖，不报一次错');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('/bind changes what a key does and what the screen says about it', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
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
  const written = [];
  const started = () => requests.filter((request) => request.method === 'run.start').length;
  const instance = render(createElement(App, {
    client, sessionId, info: { boundary: projectDirectory }, interactive: true,
    keys: { read: async () => ({ overrides: {}, refused: [] }), write: async (next) => { written.push(next); } },
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => painted.split('\x1B[?2026h').pop();
  // 说出来的那几句是提交过的行：`Static` 只打一次，读它要看整段流，不能只看最后一帧。
  const spoken = (text) => painted.includes(text);
  try {
    await waitFor(() => lastFrame().includes('要模型做的事'), { read: lastFrame });
    stdin.write('/bind newline ctrl+x');
    await delay(40);
    stdin.write('\r');
    await waitFor(() => spoken('newline 现在是 Ctrl+X（输入）'), { read: () => painted });
    assert.match(lastFrame(), /Ctrl\+X 换行/, '输入行那句说明跟着换：说的那串字与按键落的事是同一处来的');
    assert.deepEqual(written.at(-1), { newline: 'ctrl+x' }, '那一条覆盖写进本机那一格');

    // 同一范围里那一记键已经落在别的事上：这一条拒，且说得出撞在哪两件事上，也不写进本机那一格。
    stdin.write('/bind send ctrl+x');
    await delay(40);
    stdin.write('\r');
    await waitFor(() => spoken('已经落在'), { read: () => painted });
    assert.match(painted, /send 与 newline/, '说的是那两条动作');
    assert.equal(written.length, 1, '撞着的那一次没写进本机那一格');

    stdin.write('/bind reset newline');
    await delay(40);
    stdin.write('\r');
    await waitFor(() => spoken('newline 回到 Shift+Enter'), { read: () => painted });
    assert.deepEqual(written.at(-1), {}, '取消那一条覆盖之后，本机那一格是空的');

    // 那一记键空出来了：把它派给发送，按下它就走发送，Enter 反倒不再发。
    stdin.write('/bind send ctrl+x');
    await delay(40);
    stdin.write('\r');
    await waitFor(() => spoken('send 现在是 Ctrl+X（输入）'), { read: () => painted });
    stdin.write('甲');
    await delay(40);
    stdin.write('\x18');
    await waitFor(() => started() === 1, { read: () => requests });
    stdin.write('乙');
    await delay(40);
    stdin.write('\r');
    await delay(120);
    assert.equal(started(), 1, 'Enter 已经不是发送那一条了，第二次按它不发');
  } finally {
    applyOverrides(defaultSpecs());
    instance.unmount();
  }
}));
