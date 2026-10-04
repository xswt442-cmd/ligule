import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConfig, createKernel, createLoop, createSessionLog, KernelError, KernelRuntimeError } from '../dist/index.js';

// 这里交进去的是按 D13 那个形状写的脚本化提供方：本文件测的是循环，不是任何一家端点。
function scriptedProvider(turns, fallback = [{ type: 'text', text: 'done' }]) {
  const requests = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      yield* (turns.shift() ?? fallback);
    },
  };
}

function tool(name, run, execution) {
  return { name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} }, execution, run };
}

function kernelWith(tools) {
  const kernel = createKernel();
  for (const entry of tools) kernel.register(entry);
  return kernel;
}

test('a turn without tool calls ends the run and the provider is asked once', async () => {
  const provider = scriptedProvider([[{ type: 'text', text: 'the answer' }]]);
  const result = await createLoop({ kernel: kernelWith([]), provider }).run('question');
  assert.deepEqual(result, { text: 'the answer', iterations: 1, modelCalls: 1 });
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(provider.requests[0].messages, [{ role: 'user', text: 'question' }]);
});

test('the iteration limit and the model call budget each stop the run with their own code', async () => {
  const always = [[{ type: 'tool-call', name: 'noop' }]];
  const provider = scriptedProvider([...always, ...always, ...always, ...always]);
  const kernel = kernelWith([tool('noop', async () => ({ text: 'ok' }))]);
  await assert.rejects(
    () => createLoop({ kernel, provider, limits: { iterations: 3, modelCalls: 99 } }).run('go'),
    (error) => error instanceof KernelError && error.code === 'loop_iteration_limit',
  );
  assert.equal(provider.requests.length, 3);

  const tight = scriptedProvider([], [{ type: 'tool-call', name: 'noop' }]);
  await assert.rejects(
    () => createLoop({ kernel, provider: tight, limits: { iterations: 99, modelCalls: 1 } }).run('go'),
    (error) => error.code === 'loop_model_budget_exhausted',
  );
  assert.equal(tight.requests.length, 1);
});

test('adjacent parallel calls overlap and a serial call forms a boundary', async () => {
  const log = [];
  const slow = (name) => tool(name, async () => {
    log.push(`${name}-start`);
    await sleep(10);
    log.push(`${name}-end`);
    return { text: name };
  }, 'parallel');
  const kernel = kernelWith([slow('a'), slow('b'), tool('c', async () => {
    log.push('c-start');
    await sleep(10);
    log.push('c-end');
    return { text: 'c' };
  })]);
  const provider = scriptedProvider([
    [
      { type: 'tool-call', name: 'a' },
      { type: 'tool-call', name: 'b' },
      { type: 'tool-call', name: 'c' },
      { type: 'tool-call', name: 'a' },
    ],
    [{ type: 'text', text: 'finished' }],
  ]);
  assert.deepEqual((await createLoop({ kernel, provider }).run('go')).text, 'finished');
  assert.ok(log.indexOf('b-start') < log.indexOf('a-end'), 'a and b must be in flight at the same time');
  assert.ok(log.indexOf('c-start') > log.indexOf('b-end'), 'the serial call waits for the parallel group');
  assert.equal(log.indexOf('a-start'), 0);
  assert.deepEqual(log.slice(-2), ['a-start', 'a-end'], 'the call after a serial one starts its own group');
});

test('a tool the host marked as completing the run stops it without another model call', async () => {
  const provider = scriptedProvider([[{ type: 'tool-call', name: 'finish' }]]);
  const kernel = kernelWith([tool('finish', async () => ({ text: 'done' }))]);
  const result = await createLoop({ kernel, provider, completesRun: ['finish'] }).run('go');
  assert.deepEqual(result, { text: '', completedBy: 'finish', iterations: 1, modelCalls: 1 });
  assert.equal(provider.requests.length, 1);
});

test('a cancelled run leaves complete records only', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({
      config: createConfig({ user: { boundary: root } }),
      session,
    });
    const controller = new AbortController();
    kernel.register(tool('long', async (args, context) => {
      await sleep(20);
      if (context.signal.aborted) throw new KernelError('exec_cancelled');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([
      [{ type: 'tool-call', name: 'long' }],
      [{ type: 'text', text: 'not reached' }],
    ]);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go', { signal: controller.signal }),
      (error) => error.code === 'loop_cancelled',
    );
    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['user', 'assistant', 'tool']);
    assert.deepEqual(events[2].result, { kind: 'failure', failed: true, code: 'exec_cancelled', content: '' });
    assert.equal(provider.requests.length, 1, 'the cancelled run does not ask the model again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 取消落在两组之间：后面那一组的调用已经在助手那一条里许出去了。不能执行——用户按的就是停；
// 也不能没人回答——请求体里每个调用都要有一条结果顶着，少一条之后每一轮都拼不出合法请求。
test('a cancellation between two groups answers the call that never ran', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'between' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const controller = new AbortController();
    const ran = [];
    kernel.register(tool('stop_now', async () => {
      ran.push('stop_now');
      controller.abort();
      return { text: 'ok' };
    }));
    kernel.register(tool('later', async () => {
      ran.push('later');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([[
      { type: 'tool-call', id: 'call_1', name: 'stop_now', args: {} },
      { type: 'tool-call', id: 'call_2', name: 'later', args: {} },
    ]]);
    await assert.rejects(
      () => createLoop({ kernel, provider, session }).run('go', { signal: controller.signal }),
      (error) => error.code === 'loop_cancelled',
    );
    assert.deepEqual(ran, ['stop_now'], 'a call queued behind a cancelled run does not execute');
    assert.deepEqual(await session.modelView(), [
      { role: 'user', text: 'go' },
      {
        role: 'assistant', text: '', toolCalls: [
          { id: 'call_1', name: 'stop_now', args: {} },
          { id: 'call_2', name: 'later', args: {} },
        ],
      },
      { role: 'tool', id: 'call_1', tool: 'stop_now', content: { text: 'ok' }, failed: false, code: undefined },
      {
        role: 'tool', id: 'call_2', tool: 'later', content: 'the run was cancelled before this call ran',
        failed: true, code: 'tool_skipped',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 算完成本轮的那一件工具之后还有别的调用：那些也许出去了，同样只留一条不执行的结果。
test('the tool that ends the round answers the calls behind it', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'completes' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    const ran = [];
    kernel.register(tool('finish', async () => ({ text: 'done' })));
    kernel.register(tool('behind', async () => {
      ran.push('behind');
      return { text: 'never' };
    }));
    const provider = scriptedProvider([[
      { type: 'tool-call', id: 'call_1', name: 'finish', args: {} },
      { type: 'tool-call', id: 'call_2', name: 'behind', args: {} },
    ]]);
    const result = await createLoop({ kernel, provider, session, completesRun: ['finish'] }).run('go');
    assert.equal(result.completedBy, 'finish');
    assert.deepEqual(ran, [], 'the round ends without running what came after it');
    const view = await session.modelView();
    assert.deepEqual(view.at(-1), {
      role: 'tool', id: 'call_2', tool: 'behind', content: 'finish ended this round before this call ran',
      failed: true, code: 'tool_skipped',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tool that throws an unwrapped error does not stop the run', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'half-baked' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('broken', async () => {
      throw new TypeError('cannot read properties of undefined');
    }));
    const provider = scriptedProvider([
      [{ type: 'tool-call', id: 'call_1', name: 'broken' }],
      [{ type: 'text', text: 'recovered' }],
    ]);
    assert.deepEqual((await createLoop({ kernel, provider, session }).run('go')).text, 'recovered');
    // 模型下一轮看得见这次失败，包括它自己那句消息，否则它只会把同一个调用再发一遍。
    assert.deepEqual(provider.requests[1].messages, [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'broken', args: {} }] },
      {
        role: 'tool',
        id: 'call_1',
        tool: 'broken',
        content: 'cannot read properties of undefined',
        failed: true,
        code: 'tool_failed',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failure inside the kernel stops the run instead of asking the model again', async () => {
  const provider = scriptedProvider([
    [{ type: 'tool-call', name: 'broken' }],
    [{ type: 'text', text: 'not reached' }],
  ]);
  // 这里用一个工具交出内核自身的故障，代替「记录写不下去」那一种：两者的类别相同，
  // 循环要停住，因为它已经不能保证模型看见的东西与记录一致。
  const kernel = kernelWith([tool('broken', async () => {
    throw new KernelRuntimeError('session_write_failed');
  })]);
  await assert.rejects(
    () => createLoop({ kernel, provider }).run('go'),
    (error) => error instanceof KernelRuntimeError && error.code === 'session_write_failed',
  );
  assert.equal(provider.requests.length, 1);
});

test('what the model is shown next is rebuilt from the session log', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('read', async () => ({ text: 'file body' })));
    const provider = scriptedProvider([
      [{ type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } }],
      [{ type: 'text', text: 'thanks' }],
    ]);
    await createLoop({ kernel, provider, session }).run('go');
    assert.deepEqual(provider.requests[1].messages, [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
      { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'file body' }, failed: false, code: undefined },
    ]);
    assert.deepEqual(provider.requests[1].tools.map((entry) => entry.name), ['read']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 推理段进记录、不进投影（D32）：界面与重开时要能看见它，而下一轮的请求体里没有它的位置。
test('reasoning is recorded and kept out of what the model is asked next', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'loop-'));
  try {
    const session = createSessionLog({ directory: root, id: 'run' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    kernel.register(tool('peek', async () => ({ text: 'one line' })));
    const provider = scriptedProvider([
      [{ type: 'reasoning', text: 'the file is short' }, { type: 'tool-call', id: 'c1', name: 'peek', args: {} }],
      [{ type: 'text', text: 'it says one line' }],
    ]);
    await createLoop({ kernel, provider, session }).run('read it');

    const events = await session.read();
    assert.deepEqual(events.map((event) => event.kind), ['user', 'reasoning', 'assistant', 'tool', 'assistant']);
    assert.equal(events[1].text, 'the file is short');
    assert.deepEqual(provider.requests[1].messages.map((entry) => entry.role), ['user', 'assistant', 'tool']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
