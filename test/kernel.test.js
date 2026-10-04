import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createConfig, createDecisionChain, createKernel, createSessionLog, KernelError, minimalTools, VERSION,
} from '../dist/index.js';

function makeTool(name, overrides = {}) {
  return {
    name,
    description: `the ${name} tool`,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async () => 'ok',
    ...overrides,
  };
}

function kernelWith(...names) {
  const kernel = createKernel();
  for (const name of names) kernel.register(makeTool(name));
  return kernel;
}

test('a fresh kernel provides no tools and an empty model-visible manifest', () => {
  const kernel = createKernel();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
});

test('register shows up in list and returns a dispose action', () => {
  const kernel = createKernel();
  const dispose = kernel.register(makeTool('read'));
  assert.deepEqual(kernel.list(), ['read']);
  dispose();
  assert.deepEqual(kernel.list(), []);
  assert.deepEqual(kernel.manifest(), []);
});

test('a duplicate name throws instead of dropping the second one silently', () => {
  const kernel = createKernel();
  kernel.register(makeTool('read'));
  assert.throws(
    () => kernel.register(makeTool('read')),
    (error) => error instanceof KernelError && error.code === 'tool_already_registered',
  );
  assert.deepEqual(kernel.list(), ['read']);
});

test('registration rejects a missing or empty required field with a code', () => {
  const kernel = createKernel();
  assert.throws(() => kernel.register(makeTool('')), (error) => error.code === 'tool_name_required');
  assert.throws(
    () => kernel.register(makeTool('read', { description: '' })),
    (error) => error.code === 'tool_description_required',
  );
  assert.throws(
    () => kernel.register(makeTool('read', { run: 'nope' })),
    (error) => error.code === 'tool_run_required',
  );
  assert.deepEqual(kernel.list(), []);
});

test('a parameter schema whose top level is a scalar fails at registration', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'string' } })),
    (error) => error.code === 'tool_parameters_type_not_object',
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: [] })),
    (error) => error.code === 'tool_parameters_must_be_object',
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: undefined })),
    (error) => error.code === 'tool_parameters_must_be_object',
  );
});

test('a parameter schema that cannot round-trip as JSON fails at registration', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'object', extra: () => 1 } })),
    (error) => error.code === 'tool_parameters_not_serializable',
  );
});

test('a parameter schema outside the supported subset fails at registration and lists every violation', () => {
  const kernel = createKernel();
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { path: { type: 'string', enum: ['a', 'b'] } } },
    })),
    (error) => error.code === 'tool_parameters_unsupported_construct' && error.detail.includes('path.enum'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: 'path' },
    })),
    (error) => error.detail.includes('required must be an array of strings'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', { parameters: { type: 'object', properties: {}, required: ['path'] } })),
    (error) => error.detail.includes('required names "path" which is not in properties'),
  );
  // 上下界只在数值类型上校验得了：写在字符串上就是一句内核不会兑现的承诺（D14）。
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { path: { type: 'string', minimum: 1 } } },
    })),
    (error) => error.code === 'tool_parameters_unsupported_construct' && error.detail.includes('path.minimum needs type integer or number'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { n: { type: 'number', maximum: Number.NaN } } },
    })),
    (error) => error.detail.includes('n.maximum must be a finite number'),
  );
  assert.throws(
    () => kernel.register(makeTool('read', {
      parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 10, maximum: 1 } } },
    })),
    (error) => error.detail.includes('n has minimum above maximum'),
  );
  assert.deepEqual(kernel.list(), []);
});

test('a numeric bound on a numeric parameter registers and is enforced per call', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', { parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['n'] } }));
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
  await assert.rejects(() => kernel.call('read', { n: 0 }), (error) => error.code === 'tool_args_invalid');
  await assert.rejects(() => kernel.call('read', { n: 4 }), (error) => error.code === 'tool_args_invalid');
  assert.equal(await kernel.call('read', { n: 2 }), 'ok');
});

test('a call whose arguments do not match the schema fails before the decision chain and is recorded', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'args' });
    const asked = [];
    const kernel = createKernel({
      policy: createDecisionChain({ ask: async (call) => { asked.push(call); return true; } }),
      session,
    });
    kernel.register(makeTool('read'));
    await assert.rejects(kernel.call('read', { path: 7 }), (error) => error.code === 'tool_args_invalid');
    await assert.rejects(kernel.call('read', {}), (error) => error.code === 'tool_args_invalid');
    assert.equal(asked.length, 0, 'a malformed call never reaches the user');
    const events = await session.read();
    assert.deepEqual(events.map((event) => [event.result.kind, event.result.code]), [
      ['failure', 'tool_args_invalid'],
      ['failure', 'tool_args_invalid'],
    ]);
    assert.deepEqual(events.map((event) => event.result.content), [
      '"path" must be a string',
      'missing required property "path"',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a numeric bound in the schema is enforced on every call', async () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', {
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offsetBytes: { type: 'integer', minimum: 0 } },
      required: ['path'],
    },
  }));
  assert.equal(await kernel.call('read', { path: 'note.txt', offsetBytes: 0 }), 'ok');
  await assert.rejects(
    kernel.call('read', { path: 'note.txt', offsetBytes: -1 }),
    (error) => error.code === 'tool_args_invalid' && error.detail === '"offsetBytes" must be at least 0',
  );
});

test('an unwrapped error from a tool becomes a stable code, keeps its cause, and is recorded as a failure', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'raw' });
    const kernel = createKernel({ session });
    const original = new TypeError('cannot read properties of undefined');
    kernel.register(makeTool('half-baked', {
      parameters: { type: 'object', properties: {} },
      run: async () => {
        throw original;
      },
    }));
    await assert.rejects(
      kernel.call('half-baked', {}),
      (error) => error instanceof KernelError && error.code === 'tool_failed' && error.cause === original,
    );
    const [event] = await session.read();
    assert.deepEqual([event.result.kind, event.result.code, event.result.content], [
      'failure',
      'tool_failed',
      'cannot read properties of undefined',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the manifest carries exactly the three model-visible fields', () => {
  const kernel = createKernel();
  kernel.register(makeTool('read', { timeoutMs: 5000, output: { render: () => '' } }));
  assert.deepEqual(kernel.manifest(), [
    {
      name: 'read',
      description: 'the read tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ]);
});

test('the manifest is detached from the object the plugin registered', () => {
  const kernel = createKernel();
  const parameters = { type: 'object', properties: {} };
  kernel.register(makeTool('read', { parameters }));
  parameters.properties.suffix = { type: 'string' };
  assert.deepEqual(kernel.manifest()[0].parameters.properties, {});
  kernel.manifest()[0].description = 'edited by the caller';
  assert.equal(kernel.manifest()[0].description, 'the read tool');
});

test('a restricted tool leaves the manifest but stays registered, and calling it is denied', async () => {
  const kernel = kernelWith('read', 'search');
  const lift = kernel.restrict(['read']);
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['search']);
  assert.deepEqual(kernel.list(), ['read', 'search']);
  await assert.rejects(
    kernel.call('read', {}),
    (error) => error.code === 'tool_denied',
  );
  lift();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read', 'search']);
});

test('a restriction applies by name, including to a tool registered after it', () => {
  const kernel = kernelWith('read');
  kernel.restrict(['web_fetch']);
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
  kernel.register(makeTool('web_fetch'));
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
});

test('disposing one restriction leaves an overlapping one in force', () => {
  const kernel = kernelWith('read');
  const first = kernel.restrict(['read']);
  const second = kernel.restrict(['read', 'search']);
  first();
  assert.deepEqual(kernel.manifest(), []);
  second();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['read']);
});

test('a stale dispose action leaves a tool registered again under the same name', () => {
  const kernel = createKernel();
  const first = kernel.register(makeTool('read'));
  first();
  kernel.register(makeTool('read'));
  first();
  assert.deepEqual(kernel.list(), ['read']);
});

test('calling a restriction disposer twice does not lift another restriction', () => {
  const kernel = kernelWith('read', 'search');
  kernel.restrict(['read']);
  const liftSearch = kernel.restrict(['search']);
  liftSearch();
  liftSearch();
  assert.deepEqual(kernel.manifest().map((tool) => tool.name), ['search']);
});

test('calling an unregistered tool rejects with a code', async () => {
  await assert.rejects(
    createKernel().call('nope'),
    (error) => error.code === 'tool_not_found',
  );
});

// 助手那一轮已经带着这次调用，记录里必须有一条结果跟它的 id 对上，否则下一次请求体里那个调用悬空。
// 错误码是给宿主分支的，`content` 才是模型看见的那一份：一个空的失败结果等于什么也没告诉它。
test('every tool failure leaves the model a sentence to act on', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    await writeFile(join(root, 'note.txt'), 'seed content\n');
    const session = createSessionLog({ directory: root, id: 'messages' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), session });
    for (const tool of minimalTools) kernel.register(tool);
    const failures = [
      ['read', { path: 'missing.txt' }],
      ['find', { pattern: '*', path: 'missing.txt' }],
      ['search', { pattern: 'x', path: 'missing.txt' }],
      ['create', { path: 'note.txt', content: 'a' }],
      ['write', { path: 'note.txt', content: 'b' }],
      ['edit', { path: 'note.txt', anchor: '   ', replacement: 'x' }],
      ['edit', { path: 'note.txt', anchor: 'absent anchor', replacement: 'x' }],
      ['delete', { path: '.' }],
      ['exec', { command: '   ' }],
    ];
    for (const [name, args] of failures) {
      await assert.rejects(() => kernel.call(name, args), `${name} should have refused ${JSON.stringify(args)}`);
    }
    const refused = (await session.read()).filter((event) => event.result?.failed);
    assert.equal(refused.length, failures.length, 'each refusal left exactly one failure event');
    for (const event of refused) {
      assert.ok(typeof event.result.content === 'string' && event.result.content !== '', `${event.tool} / ${event.result.code} says nothing to the model`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a call naming a tool that is not registered is recorded against its call id', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'kernel-'));
  try {
    const session = createSessionLog({ directory: root, id: 'missing' });
    const kernel = createKernel({ session });
    await assert.rejects(kernel.call('nope', {}, { callId: 'call_9' }), (error) => error.code === 'tool_not_found');
    const events = await session.read();
    assert.deepEqual(events.map((event) => [event.kind, event.callId, event.result.kind, event.result.code]), [
      ['tool', 'call_9', 'failure', 'tool_not_found'],
    ]);
    assert.deepEqual(await session.modelView(), [
      { role: 'tool', id: 'call_9', tool: 'nope', content: 'no tool named "nope" is registered for this run', failed: true, code: 'tool_not_found' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tool reads the configuration snapshot and the logger from the context it is called with', async () => {
  const seen = [];
  const kernel = createKernel({
    config: createConfig({ user: { sandbox: { network: 'on' } } }),
    logger: {
      debug: () => {},
      log: (message) => seen.push(message),
    },
  });
  kernel.register(makeTool('read', {
    run: async (args, context) => {
      context.logger.log('reading');
      return context.config.sandbox.network;
    },
  }));
  assert.equal(await kernel.call('read', { path: 'note.txt' }), 'on');
  assert.deepEqual(seen, ['reading']);
});

test('a fresh kernel hands tools an empty read-only snapshot and a silent logger', async () => {
  let snapshot;
  let logger;
  const kernel = createKernel();
  kernel.register(makeTool('read', {
    run: async (args, context) => {
      snapshot = context.config;
      logger = context.logger;
      return 'ok';
    },
  }));
  await kernel.call('read', { path: 'note.txt' });
  assert.deepEqual(snapshot, {});
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(Object.keys(logger).sort(), ['debug', 'error', 'log']);
});

test('a configuration object that is not a folded snapshot is rejected', () => {
  assert.throws(
    () => createKernel({ config: { mode: 'x' } }),
    (error) => error.code === 'config_snapshot_must_be_frozen',
  );
});

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
