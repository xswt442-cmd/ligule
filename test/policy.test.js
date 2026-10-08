import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionChain, createKernel, KernelError } from '../dist/index.js';

// 判定这一格除了 decision、code、reason、segments 之外还带能力名、档位与走的那条路（D77）。
// 这一份检查比的是那条链的顺序与结论，那几栏单独在第 38 步那一条里比，这里先摘掉。
async function judged(chain, call) {
  const { capability, level, via, forced, rule, answer, ...rest } = await chain.evaluate(call);
  return rest;
}

function asked(...answers) {
  const calls = [];
  let next = 0;
  return {
    calls,
    ask: async (call) => {
      calls.push(call);
      return answers[next++] ?? false;
    },
  };
}

test('a denied call never reaches the user', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({
    rules: [{ tool: 'exec', decision: 'deny', match: 'rm *', reason: 'deleting through exec is not allowed' }],
    ask,
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'rm -rf /tmp/x' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'deleting through exec is not allowed',
  });
  assert.equal(calls.length, 0);
});

test('an asked call follows the answer, and a missing channel denies', async () => {
  const yes = asked(true);
  assert.deepEqual(await judged(createDecisionChain({ ask: yes.ask }), { tool: 'read', input: {} }), { decision: 'allow' });
  assert.deepEqual(yes.calls, [{ tool: 'read', input: {}, command: undefined, reason: undefined }]);

  const no = asked(false);
  assert.equal((await createDecisionChain({ ask: no.ask }).evaluate({ tool: 'read', input: {} })).code, 'ask_declined');
  assert.equal((await createDecisionChain({}).evaluate({ tool: 'read', input: {} })).code, 'ask_unavailable');
});

test('a later guard cannot undo an earlier denial', async () => {
  const chain = createDecisionChain({ ask: async () => true });
  chain.guard(() => 'first guard says no');
  chain.guard(() => undefined);
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls' } }), {
    decision: 'deny',
    code: 'guard_denied',
    reason: 'first guard says no',
  });
});

test('a deny rule wins over an allow rule written earlier in the table', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({
    rules: [
      { tool: 'exec', decision: 'allow', match: 'git *' },
      { tool: 'exec', decision: 'deny', match: 'git push *', reason: 'pushing is the host call' },
    ],
    ask,
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git push origin main' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'pushing is the host call',
  });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.equal(calls.length, 0);
});

test('every segment of a pipeline has to be covered before an asked call is allowed', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }], ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status | grep x' } }), { decision: 'allow', segments: ['git status', 'grep x'] });
  assert.equal(calls.length, 1, 'only the pipeline needed a decision');
  assert.equal(calls[0].command, 'git status | grep x');
  assert.equal(calls[0].reason, undefined);
});

test('a deny rule catches a segment hidden behind a pipe', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'deny', match: 'rm *' }], ask });
  assert.equal(
    (await chain.evaluate({ tool: 'exec', input: { command: 'git status | rm -rf /tmp/x' } })).code,
    'policy_denied',
  );
  assert.equal(calls.length, 0);
});

test('a command the parser cannot fully understand is asked about, with the reason', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls -la' } }), { decision: 'allow', segments: ['ls -la'] });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'echo $(whoami)' } })).decision, 'allow');
  assert.equal(calls.length, 1, 'the automatic mode does not approve what it cannot parse');
  assert.match(calls[0].reason, /command_substitution/);
});

test('content checks still deny in the low-risk automatic mode', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow' }] });
  chain.guard(({ command }) => (command?.includes('curl') ? 'network access is not allowed' : undefined));
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'curl example.com' } })).code, 'guard_denied');
  assert.equal(calls.length, 0);
});

test('the automatic mode lets an ordinary call through and still asks for an interpreter', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', ask, rules: [{ tool: 'exec', decision: 'allow', match: 'python *' }] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls -la' } }), { decision: 'allow', segments: ['ls -la'] });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'python run.py' } })).decision, 'allow');
  assert.deepEqual(calls.map((call) => call.command), ['python run.py']);
});

test('a prefix rule matches whole arguments only, a wildcard rule matches across the rest', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git status' }], ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status' } }), { decision: 'allow', segments: ['git status'] });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git statusfoo' } }), { decision: 'allow', segments: ['git statusfoo'] });
  assert.deepEqual(calls.map((call) => call.command), ['git statusfoo']);

  const wild = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }], ask: asked().ask });
  assert.deepEqual(await judged(wild, { tool: 'exec', input: { command: 'git commit -m x' } }), { decision: 'allow', segments: ['git commit -m x'] });
  assert.equal((await wild.evaluate({ tool: 'exec', input: { command: 'github push' } })).code, 'ask_declined');
});

test('consecutive denials fall back to asking every time', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 2, total: 99 }, ask });
  chain.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal(chain.mode, 'ask');
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'ls' } }), { decision: 'allow', segments: ['ls'] });
  assert.deepEqual(calls.map((call) => call.command), ['ls']);
});

test('the total count falls back even when allowed calls reset the consecutive one', async () => {
  const chain = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 99, total: 3 }, ask: async () => true });
  chain.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'ls' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  await chain.evaluate({ tool: 'exec', input: { command: 'ls' } });
  assert.deepEqual(chain.denials(), { consecutive: 0, total: 2 });
  await chain.evaluate({ tool: 'exec', input: { command: 'rm' } });
  assert.deepEqual(chain.denials(), { consecutive: 1, total: 3 });
  assert.equal(chain.mode, 'ask');
});

test('an unknown mode or a threshold below one fails at once', () => {
  assert.throws(() => createDecisionChain({ mode: 'yolo' }), (error) => error.code === 'policy_mode_unknown');
  assert.throws(
    () => createDecisionChain({ thresholds: { consecutive: 0, total: 5 } }),
    (error) => error instanceof KernelError && error.code === 'policy_thresholds_required',
  );
});

test('the kernel runs every call through the decision chain and reports the code', async () => {
  const seen = [];
  const kernel = createKernel({
    policy: createDecisionChain({
      rules: [
        { tool: 'exec', decision: 'deny', match: 'rm *' },
        { tool: 'exec', decision: 'allow', match: 'ls' },
      ],
    }),
    logger: { debug: () => {}, log: (message, fields) => seen.push(fields), error: () => {} },
  });
  kernel.register({
    name: 'exec',
    description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    run: async () => 'ran',
  });
  await assert.rejects(
    () => kernel.call('exec', { command: 'rm -rf /tmp/x' }),
    (error) => error.code === 'policy_denied',
  );
  assert.deepEqual(seen[0], { tool: 'exec', code: 'policy_denied', reason: 'exec 被规则表拒绝' });
  assert.equal(await kernel.call('exec', { command: 'ls' }), 'ran');
});

// 判定读哪一种语法由 Host 的那一份选择决定（D59）：同一行文本在两个后端下可以得出不同结论。
const POWERSHELL = { kind: 'powershell', executable: 'pwsh.exe', prefix: ['-Command'], tail: '' };

test('the PowerShell backend judges only its own narrow subset', async () => {
  const { calls, ask } = asked(true, true);
  const chain = createDecisionChain({ mode: 'auto', ask });
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'Get-ChildItem -Force' }, shell: POWERSHELL }), {
    decision: 'allow',
    segments: ['Get-ChildItem -Force'],
  });

  // 管道在 bash 那一档是可以逐段判的连接符，在 PowerShell 这一档不是：管道里过去的是对象，类型只有运行时知道。
  assert.deepEqual(await judged(chain, { tool: 'exec', input: { command: 'git status | grep x' } }), {
    decision: 'allow',
    segments: ['git status', 'grep x'],
  });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'git status | grep x' }, shell: POWERSHELL })).decision, 'allow');
  assert.deepEqual(calls.map((call) => call.command), ['git status | grep x']);
  assert.match(calls[0].reason, /powershell 的这一条命令没能完整读下来: |/);
  // 答复那一次要多看一眼的东西：答的是哪一种语法下的这条文本、跑起来会是哪一个可执行文件。
  assert.equal(calls[0].shell, 'powershell');
  assert.equal(calls[0].executable, 'pwsh.exe');

  // 以脚本解释器开头这一段两边都不放（D17 第三条），换后端不把它放宽。
  assert.equal(
    (await chain.evaluate({ tool: 'exec', input: { command: 'python -c "print(1)"' }, shell: POWERSHELL })).decision,
    'allow',
  );
  assert.deepEqual(calls.map((call) => call.command), ['git status | grep x', 'python -c "print(1)"']);
});

// 档位的两件来源与规则表可以整张换掉（D100、D101）。
test('the tier has two sources and the rule table can be replaced in place', async () => {
  const chain = createDecisionChain({ mode: 'ask', rules: [], ask: async () => true });
  assert.equal(chain.mode, 'ask');
  assert.equal(chain.modeSource, 'config');
  chain.setMode('auto');
  assert.equal(chain.mode, 'auto', '会话覆盖的那一份现在生效');
  assert.equal(chain.modeSource, 'session');
  chain.setConfiguredMode('ask');
  assert.equal(chain.mode, 'auto', '配置默认改了，会话自己覆盖过的那一份不动');
  assert.equal(chain.configuredMode(), 'ask');
  chain.resetMode();
  assert.equal(chain.mode, 'ask', '退回的就是配置那一份');
  assert.equal(chain.modeSource, 'config');
  assert.throws(() => chain.setMode('sometimes'), (error) => error.code === 'policy_mode_unknown');
  chain.setRules([{ tool: 'exec', decision: 'deny', match: 'rm' }]);
  const denied = await chain.evaluate({ tool: 'exec', input: { command: 'rm something' } });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.via, 'rule', '新表里那一条现在就在判');
});
