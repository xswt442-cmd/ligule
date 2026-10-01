import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionChain, createKernel, KernelError } from '../src/index.js';

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
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'rm -rf /tmp/x' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'deleting through exec is not allowed',
  });
  assert.equal(calls.length, 0);
});

test('an asked call follows the answer, and a missing channel denies', async () => {
  const yes = asked(true);
  assert.deepEqual(await createDecisionChain({ ask: yes.ask }).evaluate({ tool: 'read', input: {} }), { decision: 'allow' });
  assert.deepEqual(yes.calls, [{ tool: 'read', input: {}, command: undefined }]);

  const no = asked(false);
  assert.equal((await createDecisionChain({ ask: no.ask }).evaluate({ tool: 'read', input: {} })).code, 'ask_declined');
  assert.equal((await createDecisionChain({}).evaluate({ tool: 'read', input: {} })).code, 'ask_unavailable');
});

test('a later guard cannot undo an earlier denial', async () => {
  const chain = createDecisionChain({ ask: async () => true });
  chain.guard(() => 'first guard says no');
  chain.guard(() => undefined);
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'ls' } }), {
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
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'git push origin main' } }), {
    decision: 'deny',
    code: 'policy_denied',
    reason: 'pushing is the host call',
  });
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'git status' } }), { decision: 'allow' });
  assert.equal(calls.length, 0);
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
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'ls -la' } }), { decision: 'allow' });
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'python run.py' } })).decision, 'allow');
  assert.deepEqual(calls.map((call) => call.command), ['python run.py']);
});

test('a prefix rule matches whole arguments only, a wildcard rule matches across the rest', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git status' }], ask });
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'git status' } }), { decision: 'allow' });
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'git statusfoo' } }), { decision: 'allow' });
  assert.deepEqual(calls.map((call) => call.command), ['git statusfoo']);

  const wild = createDecisionChain({ rules: [{ tool: 'exec', decision: 'allow', match: 'git *' }], ask: asked().ask });
  assert.deepEqual(await wild.evaluate({ tool: 'exec', input: { command: 'git commit -m x' } }), { decision: 'allow' });
  assert.equal((await wild.evaluate({ tool: 'exec', input: { command: 'github push' } })).code, 'ask_declined');
});

test('consecutive denials fall back to asking every time', async () => {
  const { calls, ask } = asked(true);
  const chain = createDecisionChain({ mode: 'auto', thresholds: { consecutive: 2, total: 99 }, ask });
  chain.guard(({ command }) => (command === 'rm' ? 'no' : undefined));
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal((await chain.evaluate({ tool: 'exec', input: { command: 'rm' } })).code, 'guard_denied');
  assert.equal(chain.mode, 'ask');
  assert.deepEqual(await chain.evaluate({ tool: 'exec', input: { command: 'ls' } }), { decision: 'allow' });
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
  assert.deepEqual(seen[0], { tool: 'exec', code: 'policy_denied', reason: 'exec is denied by policy' });
  assert.equal(await kernel.call('exec', { command: 'ls' }), 'ran');
});
