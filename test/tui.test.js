// 终端界面的行、输入与折叠（D33 的第二种客户端）。ink 与 react 是可选依赖，装不上时这一份整份跳过，
// 与那两条比较真实检索后端的检查同一个处理：不能假造一个后端来通过。
// 每一具渲染都向 ink 传 `interactive: true`：环境里有 CI 那一个变量时 ink 自己走非交互那一条路，画面不再更新，
// 而这几条检查要验的正是交互那一档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { waitFor, withTuiHost } from './helpers/tui-host.js';
import { HISTORY_LIMIT, SEARCH_ROWS, historyPathOf, loadHistory, pushHistory, rememberHistory, searchHistory } from '../dist/tui/history.js';

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
const editorFixture = fileURLToPath(new URL('./fixtures/editor.mjs', import.meta.url));
const { foldText, editDraft, projectRecord, buildStatusLine, contextSegment, findRecord, branchOf, detailTitle, helpLines, routeInput, candidatesOf, displayWidth, flowGroups, UI_COMMANDS, markdownLines, changeSummary, capabilityOf, queuedLine, sessionLines, findLines, mentionToken, insertMention, resolveSessionId, SESSION_ROWS } = rows;
const quoted = (value) => `"${value.replaceAll('"', '\\"')}"`;
const plainOutput = (value) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

function assertInTestplace(path) {
  const root = resolve('testplace');
  const absolutePath = resolve(path);
  const relativePath = relative(root, absolutePath);
  assert.ok(relativePath !== '' && !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  return absolutePath;
}

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
  // 工具交回的是 { text, ...附带 }，界面画的是正文那一格，不是整层信封（第 41 步）。
  assert.equal(row.text, 'a body', '正文画正文');
});

test('a record kind the terminal does not draw yields no rows instead of guessing', options, () => {
  assert.deepEqual(projectRecord({ kind: 'something-new' }), []);
});

// 斜杠开头的输入先查界面那张表；表里没有的这一行要原样落到 run.start，宿主才展开得开提示模板（D24、D81）。
test('a slash line the UI table does not own goes to the host as one message', options, () => {
  assert.deepEqual(routeInput('  读一下 note.txt  ', false), { kind: 'run', text: '读一下 note.txt' });
  assert.deepEqual(routeInput('/tools', false), { kind: 'command', name: 'tools', argument: '' });
  assert.deepEqual(routeInput('/MODE now', false), { kind: 'command', name: 'mode', argument: 'now' });
  // 这一条就是第 40 步修掉的缺陷：模板命令在界面表里没有，但它不是「没有这条命令」。
  assert.deepEqual(routeInput('/git:release:prepare 3', false), { kind: 'run', text: '/git:release:prepare 3' });
  assert.deepEqual(routeInput('/', false), { kind: 'command', name: 'help', argument: '' });
  // 存在但这一轮跑着的时候不能用，说的话与「界面没有这一条」不一样。
  assert.deepEqual(routeInput('/new', true), { kind: 'blocked', usage: '/new' });
  assert.deepEqual(routeInput('/new', false), { kind: 'command', name: 'new', argument: '' });
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

test('the app paints the session line and the input hint onto the terminal', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.isTTY = false;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const status = await client.request('status.get', { sessionId });

  const instance = render(
    createElement(App, { client, sessionId, info: { model: 'test-model' }, interactive: false }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  // 这一具渲染走的就是非交互那一条路：收掉时才写一次，所以状态要先落定，等宿主收到界面自己发的那一次 `status.get`。
  await waitFor(() => requests.some((request) => request.method === 'status.get'), { read: () => painted });
  await delay(300);
  instance.unmount();
  await waitFor(() => /mode:minimal  policy:ask/.test(painted), { read: () => painted });

  assert.match(painted, new RegExp(`test-model · 会话 ${sessionId.slice(0, 8)}`));
  assert.match(painted, new RegExp(`mode:minimal  policy:ask .*tools:${status.tools.length}`));
  assert.match(painted, /打 \/ 看清单/);
}));

test('the status line names the mode and the decision level separately', options, () => {
  const status = { mode: 'minimal', pendingMode: null, policy: 'ask', tools: ['read', 'find'], eventCount: 3 };
  assert.equal(
    buildStatusLine({ head: '', sessionId: 'abcdef0123456789', status, running: false, seconds: 0, expanded: false }),
    '会话 abcdef01 · mode:minimal  policy:ask  tools:2 · 记录 3 条',
  );
  // 待生效写成 mode:a→b（D41）。
  assert.match(buildStatusLine({ head: '', sessionId: 'abcdef0123456789', status: { ...status, pendingMode: 'full' } }), /mode:minimal→full/);
  // 宽度不够先丢工具数：模式与档位才说得出这一轮能做什么（D40）。
  const narrow = buildStatusLine({ head: '', sessionId: 'abcdef0123456789', status, columns: 30 });
  assert.doesNotMatch(narrow, /tools:/);
  assert.match(narrow, /mode:minimal  policy:ask/);
});

test('a mode switch and an expanded template both reach the transcript', options, () => {
  assert.deepEqual(
    projectRecord({ kind: 'mode', name: 'full', layer: 'shipped', tools: ['read', 'skill'] }),
    [{ kind: 'meta', text: '模式 full（随包）生效：read、skill' }],
  );
  assert.deepEqual(
    projectRecord({ kind: 'user', text: 'Review src/a.ts\n', raw: '/review:security src/a.ts' }),
    [{ kind: 'question', text: '/review:security src/a.ts' }],
  );
});

test('/show takes the number from the record, not the row on screen', options, () => {
  const events = [{ seq: 0, kind: 'mode' }, { seq: 1, kind: 'user', text: 'hi' }];
  assert.deepEqual(findRecord(events, '1'), { record: events[1] });
  // 序号写错形状与写了一个没有的号是两类问题，说的话得不一样（空序号是另一个动作：收起，不走这里）。
  assert.equal(findRecord(events, 'third').code, 'tui_show_needs_a_number');
  assert.equal(findRecord(events, '-1').code, 'tui_show_needs_a_number');
  assert.equal(findRecord(events, '7').record, null);
});

// 支线入口用的序号就是父记录里那条派生结果的序号，而支线 id 从那条结果的内容里读（D71、D74）。
test('/sub reads the branch reference out of the delegation result', options, () => {
  assert.ok(UI_COMMANDS.some((command) => command.name === 'sub'), 'the command is listed in help');
  const branch = { kind: 'tool', tool: 'subagent', result: { failed: false, content: { sessionId: 'parent.sub-1', text: 'done' } } };
  assert.deepEqual(branchOf({ seq: 4, ...branch }), { sessionId: 'parent.sub-1' });
  assert.equal(branchOf({ seq: 4, kind: 'tool', tool: 'read', result: { content: { sessionId: 'x' } } }).code, 'tui_sub_needs_a_branch');
  assert.equal(branchOf({ seq: 4, kind: 'user', text: 'hi' }).code, 'tui_sub_needs_a_branch');
  // 结果内容超过注入上限时整段溢出到文件（I6），那一条记录里就没有 sessionId 这一格了。
  const spilled = { seq: 4, kind: 'tool', tool: 'subagent', result: { failed: false, content: 'a truncated string', spilled: 'result-1.json' } };
  assert.deepEqual(branchOf(spilled), { code: 'tui_sub_reference_spilled', spilled: 'result-1.json' });

  // 那一格的标题先说清在哪条线上：主干与支线各有一套序号；收起那一句跟着命令名走。
  assert.equal(detailTitle({ seq: 3, kind: 'assistant' }), '记录 3（assistant）的完整内容 · /show 收起');
  assert.match(detailTitle({ seq: 4, kind: 'subagent', branch: 'parent.sub-1' }), /^支线 parent\.sub-1，父记录第 4 那一次派生/);
  assert.match(detailTitle({ seq: 4, kind: 'subagent', branch: 'parent.sub-1' }), /支线自己的 · \/sub 收起$/);
});

// 审批框上要看得见答的是哪一种语法、跑起来会是哪一个可执行文件（D59）：同一条文本在两种后端下的结论可以相反。
test('the approval box names the shell backend and its executable', options, async () => withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
  const instance = render(createElement(App, { client, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const run = client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: { command: 'node --version | node --version' } }) });
    // 答复要在询问画出来之后给：那一句 'n' 早到一步就落进草稿，这一轮就没人结束了。
    await waitFor(() => /后端 (powershell|bash) · /.test(painted), { read: () => painted });
    stdin.write('n');
    await run;
  } finally {
    instance.unmount();
  }

  assert.match(painted, /要执行 exec/);
  assert.match(painted, /node --version \| node --version/);
  assert.match(painted, /后端 (powershell|bash) · /);
}));

// 候选清单：界面那张表在前，宿主交出来的模板在后，都按前缀收窄（D81）。
test('the candidate list narrows on what is typed and appends host templates', options, () => {
  const templates = [{ command: 'git:release:prepare', description: '准备一次发布', hint: '<序号>' }];
  assert.deepEqual(candidatesOf('读一下', templates), []);
  // 光打一个斜杠就给整张表是噪音：等第一个字母。
  assert.deepEqual(candidatesOf('/', templates), []);
  // 已经在写参数了就不再压着清单。
  assert.deepEqual(candidatesOf('/mode ', templates), []);
  const [only] = candidatesOf('/mo', templates);
  assert.deepEqual([only.name, only.hint, only.source], ['mode', '[名字]', 'ui']);
  assert.deepEqual(
    candidatesOf('/git', templates).map((c) => [c.name, c.source, c.text]),
    [['git:release:prepare', 'template', '准备一次发布']],
  );
  // 前缀越短候选越多，但画出来的行数有上限。
  assert.ok(candidatesOf('/', [{ command: 'a' }, { command: 'b' }]).length <= 8);
});

// `/help` 那几行：放得下就并排，放不下整组往下一层，两种都不截字（D81）。
test('help groups flow side by side when there is room and stack when there is not', options, () => {
  const groups = [
    { title: 'A', entries: [{ key: '/aa', action: 'x' }] },
    { title: 'B', entries: [{ key: '/bb', action: 'yy' }, { key: '/ccc', action: 'z' }] },
  ];
  const wide = flowGroups(groups, 120);
  assert.equal(wide.length, 3, '行数是最高那一组的行数');
  assert.match(wide[0], /^A\s+B$/);
  assert.deepEqual(flowGroups(groups, 12), ['A', '/aa  x', '', 'B', '/bb   yy', '/ccc  z']);
});

// 中英混排那一列按终端里的列数对齐，不按字符数：一个汉字占两列。
test('padding counts the columns a character takes in the terminal', options, () => {
  assert.equal(displayWidth('a中'), 3);
  const rows2 = flowGroups([
    { title: '命令', entries: [{ key: '/a', action: '读' }] },
    { title: '按键', entries: [{ key: 'Ctrl+O', action: 'x' }] },
  ], 40);
  assert.equal(rows2[0], '命令      按键');
  assert.equal(rows2[1], '/a  读    Ctrl+O  x');
});

test('help lists the templates the host reports and says where they come from', options, () => {
  const painted = helpLines({ templates: [{ command: 'git:release:prepare', description: '准备一次发布', hint: '' }] }, 400).join('\n');
  assert.match(painted, /\/mode/);
  assert.match(painted, /git:release:prepare/);
  assert.match(painted, /Tab\s+补全/);
  assert.match(helpLines({ templates: [] }, 400).join('\n'), /在 \.ligule\/prompts/);
  assert.match(helpLines(null, 400).join('\n'), /命令/);
});

// 这一条验证终端补全后由真实 Host 展开模板，并把结果送进本地 HTTP 模型端点。
test('typing a template command completes it and expands through the host', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
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

  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('/gi');
    await waitFor(() => /git:release:prepare/.test(plainOutput(painted)), { read: () => plainOutput(painted) });
    stdin.write('\t');
    await waitFor(() => /› \/git:release:prepare/.test(plainOutput(painted)), { read: () => plainOutput(painted) });
    stdin.write('3');
    await delay(200);
    stdin.write('\r');
    await waitFor(() => providerRequests.some((request) => request.messages.some((message) => message.role === 'user' && message.content === 'Prepare release 3.\n')), { read: () => plainOutput(painted) });
  } finally {
    // 断言失败也要收掉这一具渲染：没 unmount 的 Ink 会留着输入与计时器把测试进程拖住。
    instance.unmount();
  }
}, { setup: async ({ projectDirectory }) => {
  const promptDirectory = join(projectDirectory, '.ligule', 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  const templateDirectory = join(promptDirectory, 'git', 'release');
  await mkdir(templateDirectory, { recursive: true });
  await cp(fileURLToPath(new URL('./fixtures/git-release-prepare.md', import.meta.url)), join(templateDirectory, 'prepare.md'));
} }));

// 助手那一段的结构看得见：围栏里的内容一行不动，标题与列表分出来，行内那几种写法只留文字（第 41 步）。
test('markdown text splits into the shapes a terminal can show', options, () => {
  assert.deepEqual(markdownLines('## 要做三件事\n- 读 `note.txt`\n- **改** 一处\n1. 跑一次\n'), [
    { kind: 'heading', text: '要做三件事' },
    { kind: 'list', text: '· 读 note.txt' },
    { kind: 'list', text: '· 改 一处' },
    { kind: 'list', text: '1. 跑一次' },
  ]);
  // 围栏里的一行 `#` 是代码，不是标题；尾随空格也留着。
  const shellLines = markdownLines('```sh\n# 注释   \nls -la\n```');
  assert.deepEqual(shellLines.map(({ kind, text }) => ({ kind, text })), [{ kind: 'code', text: '# 注释   ' }, { kind: 'code', text: 'ls -la' }]);
  assert.ok(shellLines[0].spans.some((span) => span.scope?.startsWith('comment')), '代码注释带高亮范围');
  const jsLines = markdownLines('```js\nconst a = 1\n```');
  assert.equal(jsLines[0].text, 'const a = 1', '高亮不改变代码正文');
  assert.ok(jsLines[0].spans.some((span) => span.scope?.startsWith('keyword')), 'JavaScript 关键字带高亮范围');
  // 链接留下文字与地址；成对的星号只保留包住的文字。
  assert.deepEqual(markdownLines('看 [文档](https://example.com/a) 与 a*b*c'), [{ kind: 'text', text: '看 文档 (https://example.com/a) 与 abc' }]);
  assert.deepEqual(markdownLines('第一行\n\n第二行'), [{ kind: 'text', text: '第一行' }, { kind: 'text', text: '' }, { kind: 'text', text: '第二行' }]);
});

// 一次调用画出来的是判定链真正用的那串能力名，不是 `mcp.call` 那件工具的名字（D52、D77）。
test('an MCP call shows the capability it actually used', options, () => {
  assert.equal(capabilityOf('mcp.call', { server: 'fs', tool: 'read_file' }), 'mcp:fs/read_file');
  assert.equal(capabilityOf('mcp.call', { server: 'fs' }), 'mcp.call', '参数不完整时不拼一个半截的名字');
  assert.equal(capabilityOf('read', { path: 'a' }), 'read');
  const [call] = projectRecord({ kind: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'mcp.call', args: { server: 'fs', tool: 'read_file', args: {} } }] });
  assert.equal(call.tool, 'mcp:fs/read_file');
  const [done] = projectRecord({ kind: 'tool', tool: 'mcp.call', args: { server: 'fs', tool: 'read_file' }, result: { kind: 'result', failed: false, content: { text: 'a body', effectiveCapability: 'mcp:fs/read_file' } } });
  assert.deepEqual([done.tool, done.text], ['mcp:fs/read_file', 'a body']);
});

// 一次 exec 的退出码画在抬头那一行：一段非零码的输出与一段成功输出不该画得一样（D59 量过这个差别）。
test('an exec result names its exit code and a spilled one names its file', options, () => {
  const [ok] = projectRecord({ kind: 'tool', tool: 'exec', result: { kind: 'result', failed: false, content: { text: 'done', exitCode: 0 } } });
  assert.deepEqual([ok.tool, ok.text, ok.exitCode], ['exec', 'done', 0]);
  const [spilled] = projectRecord({ kind: 'tool', tool: 'read', result: { kind: 'result', failed: false, content: { text: 'a body' }, spilled: 'result-3.json' } });
  assert.equal(spilled.spilled, 'result-3.json');
  // 被拒的那一条没有 content 可画，理由就是那一行。
  const [refused] = projectRecord({ kind: 'tool', tool: 'write', result: { kind: 'refusal', failed: true, code: 'ask_declined', reason: 'the user declined', content: '' } });
  assert.deepEqual(refused, { kind: 'refusal', tool: 'write', text: 'the user declined', code: 'ask_declined' });
});

// 审批框那一格要说得出改的是什么，而不是把整份文件内容喷在屏幕上（第 41 步）。
test('the approval box sums the change instead of dumping the payload', options, () => {
  assert.equal(changeSummary('write', { path: 'note.txt', content: 'a\nb\nc' }), 'note.txt：3 行新内容');
  assert.equal(changeSummary('edit', { path: 'note.txt', anchor: 'a\nb', replacement: 'x' }), 'note.txt：换掉 2 行，换上 1 行');
  assert.equal(changeSummary('delete', { path: 'note.txt' }), '把 note.txt 移进回收站');
  assert.equal(changeSummary('exec', { command: 'ls' }), '', '命令那一行文本由 detail 那一条说，这里不重复');
});

// 助手那一段画到屏幕上时结构要看得见：这一条走的是真的渲染路径，不是只看纯函数的返回值。
test('an answer with markdown shapes paints a heading, a list and highlighted code from the host', options, async () => withTuiHost(async ({ client, sessionId }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
  const instance = render(createElement(App, { client, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('请原样保留这些内容：\n## 两步\n- 先看\n```js\nconst a = 1\n```\n退出码那行是 **0**');
    await delay(80);
    stdin.write('\r');
    await waitFor(() => /\x1B\[35mconst\x1B\[39m/.test(painted), { read: () => painted });
  } finally {
    instance.unmount();
  }

  const plain = painted.replace(/\x1B\[[0-9;]*m/g, '');
  const response = plain.split('Local response:').at(-1) ?? '';
  assert.match(response, /两步/);
  assert.match(response, /· 先看/);
  assert.match(response, / {2}const a = 1/, '围栏里那一行带缩进画出来');
  assert.doesNotMatch(response, /## 两步/, '井号不留在助手画面上');
  assert.doesNotMatch(response, /\*\*0\*\*/, '加粗的星号也不留在助手画面上');
  assert.match(painted, /\x1B\[35mconst\x1B\[39m/, '代码关键字通过高亮颜色呈现');
}));

// 排队的短句只画前 64 字：这一格的作用是说「排了几条」，不是把整句话再印一遍。
test('a queued line is clipped to one row', options, () => {
  assert.equal(queuedLine('短的一句'), '短的一句');
  assert.equal(queuedLine('x'.repeat(70)).length, 65);
  assert.match(queuedLine('x'.repeat(70)), /…$/);
});

// 跑着的那一轮里回车不会丢掉那一句：排进来的按先后在本轮结束后发出，空草稿上按退格收回最后一条（D81 边界二）。
test('input typed while a round runs queues up and flushes in order', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const instance = render(createElement(App, { client, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  // 文本与回车分两次写：一段中文后面紧跟 `\r` 时被同一个 chunk 吃掉，真键盘上是两次按键。
  const type = async (text) => { stdin.write(text); await delay(80); stdin.write('\r'); await delay(200); };
  // 只看最后一帧：Ink 把每一帧续写在同一个流里，取尾巴会连上一帧的内容一起读。
  const lastFrame = () => painted.split('\x1B[?2026h').pop();
  try {
    await waitFor(() => painted.includes('要模型做的事'), { read: () => painted });
    await type('第一条');
    const started = () => requests.filter((request) => request.method === 'run.start').map((request) => request.params.input);
    await waitFor(() => started().length === 1, { read: () => painted });
    assert.deepEqual(started(), ['第一条'], '第一句直接进这一轮');
    await type('第二条');
    await type('第三条');
    await waitFor(() => /排队 2 · 第三条/.test(lastFrame()), { read: () => lastFrame() });
    assert.deepEqual(started(), ['第一条'], '跑着的时候不再开第二轮');

    // 草稿空着时按退格：最后排进来的那一条回到草稿，队列少一条。
    stdin.write('\x7f');
    await waitFor(() => /第三条/.test(lastFrame()) && (lastFrame().match(/排队 \d/g) ?? []).length === 1, { read: () => lastFrame() });

    await waitFor(() => started().length === 2, { within: 20_000, read: () => painted });
    assert.deepEqual(started(), ['第一条', '第二条'], '本轮结束后按先后接上');
  } finally {
    // 断言失败也要收掉这一具渲染：没 unmount 的 Ink 会留着输入与计时器把测试进程拖住。
    instance.unmount();
  }
}, { delayMs: 1_800 }));

// 状态行上那一段上下文压力（D82、第 43 步）：没写窗口时整段不出现，不是写一个 0 上去。
test('the status line reports context pressure only when a window is written', options, () => {
  assert.equal(contextSegment(null), '');
  assert.equal(contextSegment(undefined), '');
  assert.equal(contextSegment({ window: 200_000, threshold: 160_000, estimated: 42_000 }), 'ctx:~42000/200000');
  assert.equal(contextSegment({ window: 200_000, threshold: 160_000, estimated: 168_000 }), 'ctx:~168000/200000 越线');

  const status = {
    mode: 'full', pendingMode: null, policy: 'ask', tools: ['a', 'b'], eventCount: 4,
    denials: { consecutive: 0, total: 0 }, usage: { window: 200_000, threshold: 160_000, estimated: 42_000 },
  };
  const draw = (columns) => buildStatusLine({ head: '', sessionId: 'x', status, running: false, seconds: 0, expanded: false, columns });
  assert.match(draw(200), /ctx:~42000\/200000/);
  // 挤的时候先丢工具数，再丢上下文那一段：那两段都从别处读得出来，模式与档位留着。
  assert.doesNotMatch(draw(64), /tools:/);
  assert.match(draw(64), /ctx:~/);
  assert.doesNotMatch(draw(40), /ctx:/);
  assert.ok(UI_COMMANDS.some((command) => command.name === 'compact'), '/compact 在命令表里');
});

// 第 44 步：`/sessions` 画的那几行与 `/resume` 认的那个 id。列表来自宿主，界面不去开盘（D81 边界一）。
test('the session listing is one row per record and an id prefix resolves to one of them', options, () => {
  const listed = [
    { id: '5f3c1234-aaaa-bbbb-cccc-dddddddddddd', updatedAt: '2026-10-05T09:12:34.567Z', events: 12, mode: { name: 'full' }, unanswered: 0 },
    { id: '5f3d9999-aaaa-bbbb-cccc-dddddddddddd', updatedAt: '2026-10-04T08:00:00.000Z', events: 3, mode: null, unanswered: 2 },
  ];
  assert.deepEqual(sessionLines(listed, '5f3d9999-aaaa-bbbb-cccc-dddddddddddd'), [
    '2026-10-05 09:12:34  5f3c1234-aaaa-bbbb-cccc-dddddddddddd  12 条  mode:full',
    '2026-10-04 08:00:00  5f3d9999-aaaa-bbbb-cccc-dddddddddddd  3 条  mode:-  未收尾 2 次派发  ← 正在这一份上',
  ], '时间只到秒、id 整串写出来、没收尾的那几处都画在这一行上');
  assert.deepEqual(sessionLines([]), ['这个项目根下还没有跑过的会话']);
  assert.equal(SESSION_ROWS > 0, true);

  assert.equal(resolveSessionId('5f3c', listed).id, listed[0].id, '前缀唯一对上就用那一份');
  assert.equal(resolveSessionId('5F3C1234-AAAA-bbbb-cccc-dddddddddddd', listed).id, listed[0].id, '整串照抄也对得上，大小写不分');
  assert.equal(resolveSessionId('5f3', listed).code, 'tui_session_ambiguous', '对上两份就不猜，让人多写几段');
  assert.equal(resolveSessionId('nope', listed).code, 'tui_session_not_listed');
  assert.equal(resolveSessionId('', listed).code, 'tui_session_ambiguous', '空的那一段对上的是一份都对不上，而不是随便挑一份');

  // 换会话把人从正在跑的那一轮带走，那一轮落下来的事件从此没人看；只读的那一条不受影响。
  assert.equal(routeInput('/resume 5f3c', true).kind, 'blocked');
  assert.equal(routeInput('/new', true).kind, 'blocked');
  assert.equal(routeInput('/sessions', true).kind, 'command');
});

// 第 76 步：查回来的是「哪一份会话的第几条」，那一行要同时说清这两个值（方案 4.2）。
test('a search hit line names the session and the event to open', options, () => {
  assert.deepEqual(findLines([
    { sessionId: '5f3c1234-aaaa-bbbb-cccc-dddddddddddd', seq: 7, kind: 'tool', text: 'npm run 读数 跑完了', name: '读数那一份', spilled: 'result-7-abcdef12.json' },
    { sessionId: '5f3d9999-aaaa-bbbb-cccc-dddddddddddd', seq: 0, kind: 'label', text: '读数那一份', name: '读数那一份' },
  ], '5f3d9999-aaaa-bbbb-cccc-dddddddddddd'), [
    '5f3c1234  「读数那一份」  工具 第 7 条  npm run 读数 跑完了  整段在 result-7-abcdef12.json',
    '5f3d9999  「读数那一份」  名字 第 0 条  读数那一份  ← 正在这一份上',
  ], '会话编号写开头八段交给 `/resume`，序号整串写出来交给 `/show`');
  assert.deepEqual(findLines([{ sessionId: 'aaaa1111', seq: 3, kind: 'world', text: 'x' }]), ['aaaa1111  world 第 3 条  x'],
    '认不出的种类原样画出来，不猜它是什么');
  assert.equal(routeInput('/find 读数', true).kind, 'command', '查一份读过的记录不改任何东西，跑着的时候也能查');
});

// 接上另一份记录时画面上换的是整份投影：那几行来自记录，不来自界面自己留着的东西（I5）。
// 这里先在当前会话上画一行，再换过去——少了 `Static` 上那个 key，短时的那一份一条都画不出来。
test('resuming a session repaints that record as the transcript', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const resumedSession = await client.request('session.create', {});
  const resumed = resumedSession.sessionId;
  await client.request('run.start', { sessionId: resumed, input: '那一份里问过的事' });
  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    await client.request('run.start', { sessionId, input: '当前这一份里问过的事' });
    await waitFor(() => painted.includes('当前这一份里问过的事'), { read: () => painted });

    stdin.write('/sessions');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => painted.includes(resumed), { read: () => painted });
    assert.doesNotMatch(painted, /项目根下还没有跑过的会话/);

    const beforeResume = painted.length;
    stdin.write(`/resume ${resumed.slice(0, 8)}`);
    await delay(100);
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(beforeResume));
    await waitFor(() => shown().includes('Local response: 那一份里问过的事'), { read: shown });
    const frame = shown();
    assert.equal(requests.find((request) => request.method === 'session.open')?.params.sessionId, resumed, '前缀在宿主列出来的那几份里对上了才打开');
    assert.match(frame, /Local response: 那一份里问过的事/, '接上来的那一份记录整份重画在画面上');
    assert.doesNotMatch(frame, /当前这一份里答过的话/, '换过来之后画面上不再是上一份的投影');
    assert.match(frame, new RegExp(`会话 ${resumed.slice(0, 8)}`), '状态行说的是现在这一份会话');
    assert.ok(requests.some((request) => request.method === 'session.close' && request.params.sessionId === sessionId),
      '换走的那一份会话在宿主里收了，装配与记录锁交回去');
  } finally {
    instance.unmount();
  }
}));

// `/find` 的那一次查询交给宿主：界面不开记录目录，画面上那一行说的是哪一份会话的第几条（D81 边界一）。
test('finding a phrase shows which session each hit is in', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const other = (await client.request('session.create', {})).sessionId;
  await client.request('run.start', { sessionId: other, input: '另一份里问过的事' });
  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const before = painted.length;
    stdin.write('/find 问过');
    await delay(100);
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes(other.slice(0, 8)), { read: shown });
    assert.ok(requests.some((request) => request.method === 'sessions.search' && request.params.query === '问过'
      && request.params.projectRoot === projectDirectory), '查的是这一个项目根跑过的那几份记录');
    assert.ok(requests.some((request) => request.method === 'sessions.search' && request.params.sessionId === sessionId),
      '当前这一份另问一次，指名之后连溢出在文件里的那一段一起读');
    assert.match(shown(), /其他会话：/, '两组分开说：这一份与其他');
    assert.match(shown(), /问 第 \d+ 条  另一份里问过的事/, '那一行说出种类、序号与命中那一段');

    const empty = painted.length;
    stdin.write('/find 没有这段文字');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(empty)).includes('没有含「没有这段文字」的'), { read: () => plainOutput(painted.slice(empty)) });
  } finally {
    instance.unmount();
  }
}));

// 分支的两个入口落在终端的同一条命令上：不带序号复制到此刻的末端，带序号复制到那一轮完整结束那一条（方案 4.3）。
test('branching copies the record and switches onto the new session', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  assert.ok(UI_COMMANDS.some((command) => command.name === 'branch'), '/branch 在命令表里');
  assert.equal(routeInput('/branch', true).kind, 'blocked', '分支会把人从跑着的这一轮带走，那一轮落下来的事件就没人在看');
  await client.request('run.start', { sessionId, input: '先问过一句' });
  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const before = painted.length;
    stdin.write('/branch');
    await delay(100);
    stdin.write('\r');
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes('复制成一份新的会话'), { read: shown });
    // 接上去走的是 `/resume` 那一条路，它自己会说一句；等这一句而不是等毫秒，两条都在同一帧序列里落下。
    await waitFor(() => shown().includes('接上会话'), { read: shown });
    const branched = requests.filter((request) => request.method === 'session.branch');
    assert.equal(branched.length, 1);
    assert.equal(branched[0].params.at, undefined, '不带序号不发 `at`：复制到哪儿由宿主固定那一刻的末端');
    const opened = requests.filter((request) => request.method === 'session.open').at(-1);
    assert.notEqual(opened.params.sessionId, sessionId, '接上去的是复制出来的那一份，不是原来那一份');
    assert.match(shown(), new RegExp(`会话 ${opened.params.sessionId.slice(0, 8)}`), '状态行说的是现在这一份会话');

    const unreadable = painted.length;
    stdin.write('/branch 第三');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(unreadable)).includes('不是序号'), { read: () => plainOutput(painted.slice(unreadable)) });
    const unavailable = painted.length;
    stdin.write('/branch 0');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => plainOutput(painted.slice(unavailable)).includes('session_branch_point_unavailable'),
      { read: () => plainOutput(painted.slice(unavailable)) });
    assert.equal(requests.filter((request) => request.method === 'session.branch').length, 2, '读不出序号那一次没发给宿主');
  } finally {
    instance.unmount();
  }
}));

// 输入历史跨会话留住（第 45 步）：那一份文件与翻它的两条动作。这一层不依赖 ink，所以不跟着界面那几条一起跳过。
test('the history keeps the newest sentence first and one place per sentence', () => {
  assert.deepEqual(pushHistory([], '  把 note.txt 读一遍 '), ['把 note.txt 读一遍'], '首尾空白不算内容');
  assert.deepEqual(pushHistory(['a', 'b'], 'a'), ['a', 'b'], '同一句再说一次不占两个位置');
  assert.deepEqual(pushHistory(['a', 'b'], '   '), ['a', 'b'], '空的那一句不进历史');
  const long = pushHistory(Array.from({ length: HISTORY_LIMIT }, (_, index) => `第 ${index} 条`), '最新的一条');
  assert.deepEqual([long[0], long.length, long.at(-1)], ['最新的一条', HISTORY_LIMIT, '第 198 条'], '攒到上限就把最旧的那几条挤出去');

  assert.deepEqual(searchHistory(['改 README 的第一段', '改 note.txt', '改 README 的第二段'], 'readme'), ['改 README 的第一段', '改 README 的第二段'],
    '从新到旧，大小写不分');
  assert.deepEqual(searchHistory(['a'], ''), [], '空的查询串不猜一份');
  assert.deepEqual(searchHistory(['ab', 'cd', 'ab'], 'a'), ['ab'], '同一句只报一次');
  assert.equal(searchHistory(Array.from({ length: 40 }, (_, index) => `第 ${index} 条`), '第').length, SEARCH_ROWS, '一次最多报那么几条');
  assert.deepEqual(searchHistory(['a', 'b'], 'zzz'), []);
});

test('the history file reads valid entries and reports a malformed line', async () => {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const root = await mkdtemp(join(testplace, 'tui-history-'));
  const absoluteRoot = assertInTestplace(root);
  const path = historyPathOf(root);
  try {
    assert.deepEqual(await loadHistory(path), [], '还没有过任何一次输入不是错误');
    await rememberHistory(path, ['最新的一条', '旧的一条']);
    assert.deepEqual(await loadHistory(path), ['最新的一条', '旧的一条'], '先后与文件里一致，最新的排在第一个');
    await appendFile(path, '这一行不是 JSON\n');
    await assert.rejects(loadHistory(path), (error) => error.code === 'tui_history_invalid' && error.line === 3);
  } finally {
    await rm(assertInTestplace(absoluteRoot), { recursive: true, force: true });
  }
});

// 上下键翻的是那一份跨会话的历史，Ctrl+R 从里面找；两处都只改草稿，发出去的仍是 `run.start`。
test('the arrow keys recall the last sentence and Ctrl+R searches the history', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
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

  const remembered = [];
  const instance = render(createElement(App, {
    client,
    sessionId,
    info: {},
    interactive: true,
    stdout,
    history: { entries: ['改 note.txt 的第一行', '上一次会话里说过的话'], remember: async (text) => { remembered.push(text); } },
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => plainOutput(painted.split('\x1B[?2026h').pop() ?? '');
  try {
    stdin.write('把这条记进历史');
    await delay(100);
    stdin.write('\r');
    await waitFor(() => remembered.length === 1, { read: () => painted });
    assert.deepEqual(requests.filter((request) => request.method === 'run.start').map((request) => request.params.input), ['把这条记进历史']);
    assert.deepEqual(remembered, ['把这条记进历史'], '发出去的那一句才交给那一份文件');

    // 上下键往上翻：第一条就是刚发出去的那一句，因为它排到了历史最前面。
    stdin.write('\x1B[A');
    await waitFor(() => lastFrame().includes('把这条记进历史'), { read: lastFrame });

    stdin.write('\x12');
    await delay(200);
    stdin.write('note');
    await waitFor(() => lastFrame().includes('反查 note') && lastFrame().includes('改 note.txt 的第一行'), { read: lastFrame });

    stdin.write('\r');
    await waitFor(() => lastFrame().includes('› 改 note.txt 的第一行'), { read: lastFrame });
    assert.doesNotMatch(lastFrame(), /反查 note/, '选完就退出反查');
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 1, '反查本身不发任何东西');
  } finally {
    instance.unmount();
  }
}));

// Ctrl+G 把草稿交给外部编辑器：真实子进程修改临时草稿后，界面读回该内容。
test('Ctrl+G hands the draft to the editor and reads back what it wrote', options, async () => withTuiHost(async ({ client, sessionId }) => {
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

  const editor = `${quoted(process.execPath)} ${quoted(editorFixture)} append-crlf - - -`;
  const instance = render(createElement(App, {
    client, sessionId, info: { editor }, interactive: true, stdout,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => painted.split('\x1B[?2026h').pop() ?? '';
  try {
    stdin.write('草稿里的一半');
    await delay(200);
    stdin.write('\x07');
    // 编辑器是一个真子进程：等它写回的那一份回到草稿最上面那一帧，再判这一帧。
    await waitFor(() => /草稿里的一半 edited/.test(lastFrame()), { read: lastFrame });
    const frame = lastFrame();
    assert.match(frame, /草稿里的一半 edited/, '编辑器写回的那一份回到草稿里');
    assert.doesNotMatch(frame, /编辑没成/);
  } finally {
    instance.unmount();
  }
}));

test('Ctrl+G says the editor is not configured instead of guessing one', options, async () => withTuiHost(async ({ client, sessionId }) => {
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

  const instance = render(createElement(App, { client, sessionId, info: {}, interactive: true, stdout }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    stdin.write('\x07');
    await waitFor(() => /没有 EDITOR 这一格/.test(painted), { read: () => painted });
  } finally {
    instance.unmount();
  }
}));

// 外部编辑器那一条的失败路径也要把临时目录收掉：那一份草稿里可能是刚写的一半代码。
test('a failed editor run leaves no temporary directory behind', async () => {
  const { editInExternalEditor } = await import('../dist/tui/editor.js');
  const leftovers = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('ligule-editor-'));
  const before = await leftovers();
  const failed = await editInExternalEditor(`${quoted(process.execPath)} ${quoted(join(resolve('test'), 'fixtures', 'editor.mjs'))} exit - - 17`, '草稿的一半');
  assert.equal(failed.code, 'tui_editor_failed');
  assert.match(failed.detail, /17/);
  assert.deepEqual(await leftovers(), before, '退出码不是 0 那一条路径上临时目录也删掉了');
  const empty = await editInExternalEditor('   ', '草稿的一半');
  assert.deepEqual(empty, { code: 'tui_editor_command_invalid', detail: 'EDITOR must contain a program name' });
  assert.deepEqual(await leftovers(), before, '命令名为空时连目录都不建');
});

// 整段粘贴走的是另一条通道：那一段文本进草稿，里面的换行不发起一轮（方案 5.1）。
test('a pasted block lands in the draft without sending it', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const instance = render(createElement(App, { client, sessionId, info: { boundary: projectDirectory }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    const esc = String.fromCharCode(27);
    const line = String.fromCharCode(10);
    const before = painted.length;
    // bracketed paste 的那一串：首尾是标记，中间带着换行。没有这一对标记时，那些换行就是一记记 Enter。
    stdin.write(`${esc}[200~把这段读一遍${line}注意第三行${esc}[201~`);
    const shown = () => plainOutput(painted.slice(before));
    await waitFor(() => shown().includes('注意第三行'), { read: shown });
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 0, '粘进来的那一段不发起一轮');
    stdin.write('\r');
    await waitFor(() => requests.some((request) => request.method === 'run.start'), { read: shown });
    const sent = requests.find((request) => request.method === 'run.start').params.input;
    assert.equal(sent, `把这段读一遍${line}注意第三行`, '两条都在草稿里：按 Enter 发出去的就是这一整段');
  } finally {
    instance.unmount();
  }
}));

// 取消这一轮之后队列是停着的：剩下的那几条不自己发，收回来或接着走都由人再说一次（方案 5.2）。
test('cancelling a round leaves the queued sentences paused', options, async () => withTuiHost(async ({ client, sessionId, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const instance = render(createElement(App, { client, sessionId, info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const type = async (text) => { stdin.write(text); await delay(80); stdin.write('\r'); await delay(200); };
  const lastFrame = () => painted.split('\x1B[?2026h').pop();
  const started = () => requests.filter((request) => request.method === 'run.start').map((request) => request.params.input);
  try {
    await waitFor(() => painted.includes('要模型做的事'), { read: () => painted });
    await type('第一条');
    await waitFor(() => started().length === 1, { read: () => painted });
    await type('第二条');
    await type('第三条');
    await waitFor(() => /排队 2 · 第三条/.test(lastFrame()), { read: lastFrame });

    stdin.write('\x1b');
    await waitFor(() => /队列停下/.test(painted), { read: () => painted });
    // 被打断的那一轮收自己的尾：等这一句出来，而不是等一个固定的毫秒数。
    await waitFor(() => /这一轮已被打断/.test(painted), { read: () => painted });
    assert.deepEqual(started(), ['第一条'], '暂停中的队列在这一轮结束后不自己发');

    await type('/queue drop 2');
    await waitFor(() => /第 2 条收回草稿/.test(painted), { read: () => painted });
    assert.match(lastFrame(), /排队 1 · 第二条/, '剩下那一条还排着');
    assert.match(lastFrame(), /第三条/, '收回的那一条在草稿上，没丢');

    // 收回来的一句照常再发一次：暂停只管排着的那几条。这一轮自己收尾时也不把暂停中的那条带出去。
    stdin.write('\r');
    await waitFor(() => started().includes('第三条'), { read: () => painted });
    await waitFor(() => /本轮结束/.test(painted), { read: () => painted });
    assert.deepEqual(started(), ['第一条', '第三条'], '暂停留着：这一轮结束不替人发还排着的那条');

    await type('/queue continue');
    await waitFor(() => started().length === 3, { within: 20_000, read: () => painted });
    assert.deepEqual(started(), ['第一条', '第三条', '第二条'], '单独一次继续才把还排着的那条发出去');
  } finally {
    instance.unmount();
  }
}, { delayMs: 1_800 }));

// 草稿与排着的几句跨退出留住：一行一份会话，同一份再写换掉旧的那一行，两句都没了就不留这一行。
test('the input file keeps one line per session and drops emptied ones', async () => {
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { parseInputs, readInput, rememberInput } = await import('../dist/tui/input-store.js');

  await mkdir(resolve('testplace'), { recursive: true });
  const directory = await mkdtemp(join(resolve('testplace'), 'input-store-'));
  const path = join(directory, 'tui-input.jsonl');
  try {
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'one', draft: '第一份的半句', queued: ['排着的那句'] });
    await rememberInput(path, { projectRoot: 'E:/b', sessionId: 'one', draft: '另一个项目里的同号', queued: [] });
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'two', draft: '', queued: ['第二份排着的'] });
    assert.deepEqual(await readInput(path, 'E:/a', 'one'), { projectRoot: 'E:/a', sessionId: 'one', draft: '第一份的半句', queued: ['排着的那句'] },
      '同一个编号在不同项目根下是两份会话');
    assert.deepEqual(await readInput(path, 'E:/a', 'never'), { projectRoot: 'E:/a', sessionId: 'never', draft: '', queued: [] }, '没留过就是空的');
    assert.deepEqual(parseInputs('不是 JSON\n{"sessionId":"ok","draft":"坏行旁边那句还在"}\n').map((item) => item.sessionId), ['ok'],
      '读不懂的一行跳过，不带走整份，也不让会话开不了');
    await rememberInput(path, { projectRoot: 'E:/a', sessionId: 'one', draft: '', queued: [] });
    assert.deepEqual(await readInput(path, 'E:/a', 'one'), { projectRoot: 'E:/a', sessionId: 'one', draft: '', queued: [] },
      '两句都收回来了就不留这一行');
    assert.deepEqual(await readInput(path, 'E:/b', 'one'), { projectRoot: 'E:/b', sessionId: 'one', draft: '另一个项目里的同号', queued: [] },
      '另一项目根下的同号不受影响');
    assert.deepEqual(parseInputs(await readFile(path, 'utf8')).map((item) => item.projectRoot).sort(), ['E:/a', 'E:/b']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 界面读回来的是那一份会话自己的那一句：排着的几句恢复成暂停，不替人发（方案 5.1、5.2）。
test('a reopened session takes back its own draft and a paused queue', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
  const saved = new Map([[sessionId, { draft: '上次没写完的那一句', queued: ['上次排着的那一句'] }]]);
  const written = [];
  const inputs = {
    read: async (projectRoot, own) => saved.get(own) ?? { projectRoot, sessionId: own, draft: '', queued: [] },
    write: async (projectRoot, own, draft, queued) => { written.push({ projectRoot, sessionId: own, draft, queued }); },
  };

  const instance = render(createElement(App, {
    client, sessionId, info: { boundary: projectDirectory }, interactive: true, inputs, stdout,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  try {
    await waitFor(() => plainOutput(painted).includes('上次没写完的那一句'), { read: () => plainOutput(painted) });
    const frame = plainOutput(painted);
    assert.match(frame, /上次排着的那一句/, '排着的那一句跟着回来');
    assert.match(frame, /队列暂停中/, '恢复时是暂停的：那几句当时还没发出去');
    assert.equal(requests.filter((request) => request.method === 'run.start').length, 0, '恢复不自己发');
    await waitFor(() => written.length > 0, { read: () => JSON.stringify(written) });
    assert.deepEqual(written.at(-1), { projectRoot: projectDirectory, sessionId, draft: '上次没写完的那一句', queued: ['上次排着的那一句'] },
      '写回去的是那一份会话自己的两格');
  } finally {
    instance.unmount();
  }
}));

// `@` 那一段的识别与插入：句首或空白之后的 `@` 才算，选中之后落笔处在那一段之后。
test('an @ fragment is recognised at a word boundary and inserts a path', () => {
  assert.deepEqual(mentionToken('看一下 @notes/rea', 14), { start: 4, text: 'notes/rea' });
  assert.deepEqual(mentionToken('@a', 2), { start: 0, text: 'a' }, '句首的 @ 也算');
  assert.equal(mentionToken('邮箱是me@li', 9), null, '紧贴在字后面的 @ 不是路径引用');
  assert.equal(mentionToken('@notes/rea 后面还有字', 8), null, '笔落在一段中间时不替换：那会截断人已写好的那一段');
  assert.deepEqual(insertMention('看一下 @rea', 8, 4, 'notes/readings-3.md'),
    { draft: '看一下 @notes/readings-3.md ', caret: 25 }, '换掉那一段并留一个空格，后面的字不动');
});

// 候选由宿主列出来：界面不开目录；清单开着时 Enter 是选中，不是发送（方案 5.3）。
test('an @ fragment asks the host for project files and Enter picks one', options, async () => withTuiHost(async ({ client, sessionId, projectDirectory, requests }) => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  await mkdir(join(projectDirectory, 'notes'), { recursive: true });
  await appendFile(join(projectDirectory, 'notes', 'readings-3.md'), '一段读数');

  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.isTTY = true;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });

  const instance = render(createElement(App, {
    client, sessionId, info: { boundary: projectDirectory }, interactive: true,
  }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  const lastFrame = () => painted.split('\x1B[?2026h').pop();
  const started = () => requests.filter((request) => request.method === 'run.start').length;
  try {
    await waitFor(() => painted.includes('要模型做的事'), { read: () => painted });
    stdin.write('先看 @readings');
    await waitFor(() => lastFrame().includes('notes/readings-3.md'), { read: lastFrame });
    assert.ok(lastFrame().includes(`项目 ${projectDirectory}`), '清单说清这些候选出自哪一个项目');
    const asked = requests.filter((request) => request.method === 'paths.list');
    assert.equal(asked.length, 1, '这一段问一次，不是每个字问一次');
    assert.deepEqual(asked[0].params, { projectRoot: projectDirectory, query: 'readings', limit: 8 }, '问的是那一个项目根里含这一段文字的文件');
    assert.equal(started(), 0, '清单开着不发送');

    stdin.write('\r');
    await waitFor(() => lastFrame().includes('@notes/readings-3.md'), { read: lastFrame });
    assert.equal(started(), 0, 'Enter 选中的是那一条候选，不是把这一句发出去');
    assert.doesNotMatch(lastFrame(), /Tab 或 Enter 选中/, '选中之后清单收起');

    stdin.write(' 还有 @notes');
    await waitFor(() => lastFrame().includes('Esc 收起'), { read: lastFrame });
    const askedAgain = requests.filter((request) => request.method === 'paths.list');
    assert.equal(askedAgain.length, 2, '改了这个词就重新问一次');
    assert.equal(askedAgain.at(-1).params.query, 'notes', '问的是新那一段文字');

    stdin.write('\x1b');
    await waitFor(() => !lastFrame().includes('Esc 收起'), { read: lastFrame });

    // 那一次查询还没回来时 Enter 什么都不做：不选一条没选过的候选，也不把这一句发出去。
    stdin.write(' @x');
    await delay(60);
    stdin.write('\r');
    await delay(120);
    assert.equal(started(), 0, '查询在路上时 Enter 既不选中也不发送');
    assert.match(lastFrame(), /@x/, '那一句还在草稿上');
  } finally {
    instance.unmount();
  }
}));
