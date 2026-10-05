// 终端界面的行、输入与折叠（D33 的第二种客户端）。ink 与 react 是可选依赖，装不上时这一份整份跳过，
// 与那两条比较真实检索后端的检查同一个处理：不能假造一个后端来通过。
import test from 'node:test';
import assert from 'node:assert/strict';

let rows = {};
let missing = '';
try {
  rows = await import('../dist/tui/app.js');
} catch (error) {
  missing = error.code === 'ERR_MODULE_NOT_FOUND' ? 'the terminal UI dependencies are not installed' : error.message;
}

const options = { skip: missing === '' ? false : missing };
const { foldText, editDraft, projectRecord, buildStatusLine, contextSegment, findRecord, branchOf, detailTitle, helpLines, routeInput, candidatesOf, displayWidth, flowGroups, UI_COMMANDS, markdownLines, changeSummary, capabilityOf, queuedLine, sessionLines, resolveSessionId, SESSION_ROWS } = rows;

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

test('the app paints the session line and the input hint onto the terminal', options, async () => {
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

  const client = {
    onNotification() {},
    onRequest() {},
    request: async () => ({
      mode: 'minimal', modeLayer: 'shipped', pendingMode: null, policy: 'ask',
      tools: ['read'], eventCount: 0, running: false, denials: { consecutive: 0, total: 0 },
    }),
    reply() {},
  };
  const instance = render(
    createElement(App, { client, sessionId: 'abcdef01-2345-6789', info: { model: 'test-model' }, interactive: false }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  await delay(200);
  instance.unmount();

  assert.match(painted, /test-model · 会话 abcdef01/);
  assert.match(painted, /mode:minimal  policy:ask  tools:1/);
  assert.match(painted, /打 \/ 看清单/);
});

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
test('the approval box names the shell backend and its executable', options, async () => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = false;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = new PassThrough();
  stdin.isTTY = false;

  let deliver;
  const client = {
    onNotification() {},
    onRequest: (handler) => { deliver = handler; },
    request: async () => ({ mode: 'minimal', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['exec'], eventCount: 0, running: false, denials: { consecutive: 0, total: 0 } }),
    reply: (id, result) => result,
  };
  const instance = render(createElement(App, { client, sessionId: 'abcdef01-2345-6789', info: {}, interactive: false }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  await delay(200);
  await deliver({
    id: 'ask-1',
    method: 'approval.request',
    params: {
      sessionId: 'abcdef01-2345-6789',
      tool: 'exec',
      command: 'Get-Process | Stop-Process',
      shell: 'powershell',
      executable: 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe',
      reason: 'the powershell command is not fully understood: |',
    },
  });
  await delay(120);
  instance.unmount();

  assert.match(painted, /要执行 exec/);
  assert.match(painted, /Get-Process \| Stop-Process/);
  assert.match(painted, /后端 powershell/);
  assert.match(painted, /not fully understood/);
});

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

// 这一条是第 40 步那处缺陷的直接验证：在终端里敲模板命令，落出去的是原样那一行，不是「没有这条命令」。
// 假 stdin 带着 setRawMode，按键走 Ink 自己的解析，不需要真终端。
test('typing a template command completes it and sends the raw line to the host', options, async () => {
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

  const sent = [];
  const client = {
    onNotification() {},
    onRequest() {},
    request: async (method, params) => {
      sent.push({ method, input: params.input });
      return method === 'status.get'
        ? { sessionId: 's', running: false, mode: 'minimal', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['read'], eventCount: 0, denials: { consecutive: 0, total: 0 }, templates: [{ command: 'git:release:prepare', description: '准备一次发布', hint: '<序号>' }] }
        : {};
    },
    reply: () => {},
  };
  const instance = render(createElement(App, { client, sessionId: 's', info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await delay(300);
    stdin.write('/gi');
    await delay(200);
    assert.match(painted, /git:release:prepare/, '清单里看得见宿主交出来的那一条');
    stdin.write('\t');
    await delay(200);
    assert.match(painted, /› \/git:release:prepare/, 'Tab 把名字补全了');
    stdin.write('3');
    await delay(200);
    stdin.write('\r');
    await delay(300);
    const run = sent.find((call) => call.method === 'run.start');
    assert.equal(run.input, '/git:release:prepare 3', '交给宿主的是原样那一行，展开归宿主（D24、D81）');
  } finally {
    // 断言失败也要收掉这一具渲染：没 unmount 的 Ink 会留着输入与计时器把测试进程拖住。
    instance.unmount();
  }
});

// 助手那一段的结构看得见：围栏里的内容一行不动，标题与列表分出来，行内那几种写法只留文字（第 41 步）。
test('markdown text splits into the shapes a terminal can show', options, () => {
  assert.deepEqual(markdownLines('## 要做三件事\n- 读 `note.txt`\n- **改** 一处\n1. 跑一次\n'), [
    { kind: 'heading', text: '要做三件事' },
    { kind: 'list', text: '读 note.txt' },
    { kind: 'list', text: '改 一处' },
    { kind: 'list', text: '跑一次' },
  ]);
  // 围栏里的一行 `#` 是代码，不是标题；尾随空格也留着。
  assert.deepEqual(markdownLines('```sh\n# 注释   \nls -la\n```'), [{ kind: 'code', text: '# 注释   ' }, { kind: 'code', text: 'ls -la' }]);
  // 链接留下文字与地址；不成对的星号不动它。
  assert.deepEqual(markdownLines('看 [文档](https://example.com/a) 与 a*b*c'), [{ kind: 'text', text: '看 文档 (https://example.com/a) 与 a*b*c' }]);
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
test('an answer with markdown shapes paints a heading, a list and a code line', options, async () => {
  const { createElement } = await import('react');
  const { render } = await import('ink');
  const { PassThrough } = await import('node:stream');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { App } = await import('../dist/tui/app.js');

  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = false;
  let painted = '';
  stdout.on('data', (chunk) => { painted += chunk; });
  const stdin = new PassThrough();
  stdin.isTTY = false;

  let notify;
  const client = {
    onNotification: (handler) => { notify = handler; },
    onRequest() {},
    request: async () => ({ sessionId: 'abcdef01-2345', running: false, mode: 'minimal', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['read'], eventCount: 0, denials: { consecutive: 0, total: 0 }, templates: [] }),
    reply: () => {},
  };
  const instance = render(createElement(App, { client, sessionId: 'abcdef01-2345', info: {}, interactive: false }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  await delay(200);
  notify({
    sessionId: 'abcdef01-2345',
    notify: 'event',
    event: { kind: 'assistant', text: '## 两步\n- 先看\n```js\nconst a = 1\n```\n退出码那行是 **0**' },
  });
  await delay(150);
  instance.unmount();

  assert.match(painted, /两步/);
  assert.match(painted, /· 先看/);
  assert.match(painted, / {2}const a = 1/, '围栏里那一行带缩进画出来');
  assert.doesNotMatch(painted, /## 两步/, '井号不留在画面上');
  assert.doesNotMatch(painted, /\*\*0\*\*/, '加粗的星号也不留在画面上');
});

// 排队的短句只画前 64 字：这一格的作用是说「排了几条」，不是把整句话再印一遍。
test('a queued line is clipped to one row', options, () => {
  assert.equal(queuedLine('短的一句'), '短的一句');
  assert.equal(queuedLine('x'.repeat(70)).length, 65);
  assert.match(queuedLine('x'.repeat(70)), /…$/);
});

// 跑着的那一轮里回车不再吞话：排进来的按先后在本轮结束后发出，空草稿上按退格收回最后一条（D81 边界二）。
test('input typed while a round runs queues up and flushes in order', options, async () => {
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

  const started = [];
  const resolvers = [];
  const client = {
    onNotification() {},
    onRequest() {},
    request: async (method, params) => {
      if (method === 'run.start') {
        started.push(params.input);
        return new Promise((resolve) => resolvers.push(() => resolve({ iterations: 1, modelCalls: 1 })));
      }
      if (method === 'status.get') {
        return { sessionId: 'abcdef01-2345', running: false, mode: 'minimal', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['read'], eventCount: 0, denials: { consecutive: 0, total: 0 }, templates: [] };
      }
      return {};
    },
    reply: () => {},
  };
  const instance = render(createElement(App, { client, sessionId: 'abcdef01-2345', info: {}, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  // 文本与回车分两次写：一段中文后面紧跟 `\r` 时被同一个 chunk 吃掉，真键盘上是两次按键。
  const type = async (text) => { stdin.write(text); await delay(80); stdin.write('\r'); await delay(200); };
  // 只看最后一帧：Ink 把每一帧续写在同一个流里，取尾巴会连上一帧的内容一起读。
  const lastFrame = () => painted.split('\x1B[?2026h').pop();
  try {
    await delay(250);
    await type('第一条');
    assert.deepEqual(started, ['第一条'], '第一句直接进这一轮');
    await type('第二条');
    await type('第三条');
    assert.deepEqual(started, ['第一条'], '跑着的时候不再开第二轮');
    assert.match(lastFrame(), /排队 1 · 第二条/);
    assert.match(lastFrame(), /排队 2 · 第三条/);

    // 草稿空着时按退格：最后排进来的那一条回到草稿，队列少一条。
    stdin.write('\x7f');
    await delay(200);
    assert.match(lastFrame(), /第三条/, '收回来的那一句在草稿里');
    assert.equal((lastFrame().match(/排队 \d/g) ?? []).length, 1, '队列里少了一条');

    resolvers.shift()();
    await delay(300);
    assert.deepEqual(started, ['第一条', '第二条'], '本轮结束后按先后接上');
  } finally {
    // 断言失败也要收掉这一具渲染：没 unmount 的 Ink 会留着输入与计时器把测试进程拖住。
    instance.unmount();
  }
});

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

// 接上另一份记录时画面上换的是整份投影：那几行来自记录，不来自界面自己留着的东西（I5）。
// 这里先在当前会话上画一行，再换过去——少了 `Static` 上那个 key，短时的那一份一条都画不出来。
test('resuming a session repaints that record as the transcript', options, async () => {
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

  const resumed = '5f3c1234-aaaa-bbbb-cccc-dddddddddddd';
  const calls = [];
  let notify = () => {};
  const client = {
    onNotification: (handler) => { notify = handler; },
    onRequest() {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sessions.list') return { sessions: [{ id: resumed, updatedAt: '2026-10-05T09:12:34.567Z', events: 2, mode: { name: 'full' }, unanswered: 0 }] };
      if (method === 'session.open') return { sessionId: params.sessionId };
      if (method === 'session.read') return { sessionId: params.sessionId, events: [{ kind: 'user', text: '那一份里问过的事' }, { kind: 'assistant', text: '那一份里答过的话' }] };
      return { sessionId: params.sessionId, running: false, mode: 'full', modeLayer: 'shipped', pendingMode: null, policy: 'ask', tools: ['read'], eventCount: 2, denials: { consecutive: 0, total: 0 }, templates: [] };
    },
    reply: () => {},
  };
  const instance = render(createElement(App, { client, sessionId: 'current', info: { boundary: 'E:/work' }, interactive: true }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  try {
    await delay(300);
    notify({ notify: 'event', sessionId: 'current', event: { seq: 0, kind: 'user', text: '当前这一份里问过的事' } });
    notify({ notify: 'event', sessionId: 'current', event: { seq: 1, kind: 'assistant', text: '当前这一份里答过的话' } });
    await delay(300);

    stdin.write('/sessions');
    await delay(100);
    stdin.write('\r');
    await delay(300);
    assert.match(painted, new RegExp(resumed), '列表里看得见那一份的 id');
    assert.doesNotMatch(painted, /项目根下还没有跑过的会话/);

    stdin.write('/resume 5f3c');
    await delay(100);
    stdin.write('\r');
    await delay(500);
    const frame = painted.split('\x1B[?2026h').pop() ?? '';
    assert.equal(calls.find((call) => call.method === 'session.open')?.params.sessionId, resumed, '前缀在宿主列出来的那几份里对上了才打开');
    assert.match(frame, /那一份里答过的话/, '接上来的那一份记录整份重画在画面上');
    assert.doesNotMatch(frame, /当前这一份里答过的话/, '换过来之后画面上不再是上一份的投影');
    assert.match(frame, /会话 5f3c1234/, '状态行说的是现在这一份会话');
  } finally {
    instance.unmount();
  }
});
