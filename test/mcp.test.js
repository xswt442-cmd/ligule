// 第 30 步的验收（D52、D60）：配置形状、按声明校验参数、披露与摘要、真实 stdio 服务器一条往返。
// 协议层用的是官方 SDK，服务器用的是官方那个文件系统参考服务器；摘要与陈旧那两条读的是我们自己那一段逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createConfig, createDecisionChain, createKernel, createMcpPlugin, createMcpRegistry, createMcpTools, loadAssembly,
  mcpServerConfigs, validateToolArguments,
} from '../dist/index.js';

const serverEntry = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', import.meta.url));

test('the server config takes a plain command and only ${NAME} credential references', () => {
  const configs = mcpServerConfigs({
    mcp: {
      servers: {
        fs: { command: process.execPath, args: [serverEntry, '/tmp'], env: { TOKEN: '${MCP_TEST_TOKEN}' } },
      },
    },
  }, { MCP_TEST_TOKEN: 'a-secret' });
  assert.deepEqual(configs, [{ name: 'fs', command: process.execPath, args: [serverEntry, '/tmp'], env: { TOKEN: 'a-secret' }, cwd: undefined }]);
  // 变量没设时不把字面量 `${NAME}` 传下去：那看着像一个凭据，其实是配置没填。
  assert.deepEqual(mcpServerConfigs(configsToConfig({ TOKEN: '${MCP_TEST_TOKEN}' }), {}).map((entry) => entry.env), [{}]);
  assert.throws(
    () => mcpServerConfigs(configsToConfig({ TOKEN: 'a-secret' })),
    (error) => error.code === 'mcp_env_unsupported',
  );
  assert.throws(() => mcpServerConfigs(configsToConfig(undefined, { command: 'node /x.js' })), (error) => error.code === 'mcp_command_invalid');
});

function configsToConfig(env, tools = { command: 'node' }) {
  return { mcp: { servers: { fs: { ...tools, ...(env === undefined ? {} : { env }) } } } };
}

test('arguments are checked against the definition the server declared', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, lines: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['path'],
    additionalProperties: false,
  };
  assert.deepEqual(validateToolArguments({ path: 'a.txt', lines: 3, tags: ['x'] }, schema), []);
  assert.match(validateToolArguments({}, schema).join('; '), /path is required/);
  assert.match(validateToolArguments({ path: 3 }, schema).join('; '), /must be string/);
  assert.match(validateToolArguments({ path: 'a', tags: [1] }, schema).join('; '), /tags\[0] must be string/);
  assert.match(validateToolArguments({ path: 'a', other: 1 }, schema).join('; '), /other is not declared/);
});

// 一台假的服务器，只用来把「定义换了」这一件事演出来：真实协议的那一段在下面那几条里跑。
function fakeRegistry(digest = 'aaaa') {
  const definition = { name: 'read_file', description: 'read one file', digest, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: { readOnlyHint: true } };
  const calls = [];
  return {
    calls,
    servers: () => ['fs'],
    toolsOf: async () => [definition],
    definition: async () => definition,
    call: async (server, tool, args) => {
      calls.push([server, tool, args]);
      return { content: [{ type: 'text', text: 'the body' }] };
    },
  };
}

test('a call needs a disclosure, and a moved definition has to be inspected again', async () => {
  const registry = fakeRegistry('aaaa');
  const disclosed = { seen: new Set() };
  const { inspectTool, callTool } = createMcpTools(registry, disclosed);
  const seen = await inspectTool.run({ server: 'fs', tool: 'read_file' });
  assert.equal(seen.schemaDigest, 'aaaa');

  // 没见过的那一版：先让它去看。
  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'bbbb' }),
    (error) => error.code === 'mcp_not_disclosed',
  );
  // 看过 aaaa 而服务器现在是 cccc：按一份没在看的形状发起调用要挡住，并要求重新 inspect。
  const moved = { registry: fakeRegistry('cccc'), disclosed: { seen: new Set(['fs/read_file@aaaa']) } };
  const second = createMcpTools(moved.registry, moved.disclosed);
  await assert.rejects(
    () => second.callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' }),
    (error) => error.code === 'mcp_definition_stale' && /now at cccc/.test(error.detail),
  );

  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"nope":1}', schemaDigest: 'aaaa' }),
    (error) => error.code === 'mcp_arguments_invalid',
  );
  await assert.rejects(
    () => callTool.run({ server: 'fs', tool: 'read_file', arguments: 'not json', schemaDigest: 'aaaa' }),
    (error) => error.code === 'mcp_arguments_invalid_json',
  );
  const result = await callTool.run({ server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' });
  assert.equal(result.text, 'the body');
  assert.equal(result.effectiveCapability, 'mcp:fs/read_file');
  assert.deepEqual(registry.calls, [['fs', 'read_file', { path: 'a.txt' }]]);
});

test('the decision chain judges the effective capability, not mcp.call', async () => {
  const registry = fakeRegistry();
  const disclosed = { seen: new Set(['fs/read_file@aaaa']) };
  const { callTool } = createMcpTools(registry, disclosed);
  const asked = [];
  const chain = createDecisionChain({
    mode: 'auto',
    rules: [{ tool: 'mcp:fs/edit_file', decision: 'deny', reason: 'editing through MCP is not allowed' }],
    ask: async (call) => {
      asked.push(call);
      return false;
    },
  });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: chain,
  });
  kernel.register(callTool);
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fs', tool: 'edit_file', arguments: '{}', schemaDigest: 'aaaa' }),
    (error) => error.code === 'policy_denied',
  );
  const seenByGuard = [];
  chain.guard(({ tool }) => {
    seenByGuard.push(tool);
    return undefined;
  });
  await kernel.call('mcp.call', { server: 'fs', tool: 'read_file', arguments: '{"path":"a.txt"}', schemaDigest: 'aaaa' });
  assert.deepEqual(seenByGuard, ['mcp:fs/read_file'], '守卫与规则表看见的都是那一条能力名');
});

test('nothing is registered when no server is configured', () => {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  const undo = createMcpPlugin({ servers: () => [], toolsOf: async () => [], definition: async () => ({}), call: async () => ({}) }).setup(kernel);
  assert.deepEqual(kernel.list(), [], '两件固定工具不登记：没人用的工具会改掉每次请求的前缀字节（D12）');
  undo();
});

test('a real stdio server answers inspect and call through the registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-'));
  await writeFile(join(root, 'note.txt'), 'hello from the server');
  const configs = mcpServerConfigs({
    mcp: { servers: { fs: { command: process.execPath, args: [serverEntry, root] } } },
  });
  const { createMcpRegistry } = await import('../dist/index.js');
  const registry = createMcpRegistry(configs);
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd() } }),
    policy: createDecisionChain({ mode: 'auto' }),
  });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  try {
  assert.deepEqual(kernel.list(), ['mcp.call', 'mcp.inspect']);
  const listed = await kernel.call('mcp.inspect', {});
  assert.equal(listed.text, 'fs');
  const tools = await kernel.call('mcp.inspect', { server: 'fs' });
  assert.match(tools.text, /read_text_file\t[0-9a-f]{12}/);
  const one = await kernel.call('mcp.inspect', { server: 'fs', tool: 'read_text_file' });
  assert.equal(one.schemaDigest.length, 12);
  const read = await kernel.call('mcp.call', {
    server: 'fs',
    tool: 'read_text_file',
    arguments: JSON.stringify({ path: join(root, 'note.txt') }),
    schemaDigest: one.schemaDigest,
  });
  assert.match(read.text, /hello from the server/);
  await assert.rejects(
    () => kernel.call('mcp.inspect', { server: 'gone' }),
    (error) => error.code === 'mcp_server_unknown',
  );
  } finally {
    await registry.close();
  }
});

// 一台不动的服务器，定义换了：摘要跟着换，旧摘要的调用被挡住，重新 inspect 之后才放行（D52）。
test('a server that moved its definition is caught over the real protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-mcp-fixture-'));
  const schema = join(root, 'schema.json');
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }));
  const registry = createMcpRegistry(mcpServerConfigs({
    mcp: { servers: { fx: { command: process.execPath, args: [fileURLToPath(new URL('fixtures/mcp-minimal.mjs', import.meta.url)), schema] } } },
  }));
  const kernel = createKernel({ config: createConfig({ user: { boundary: root } }), policy: createDecisionChain({ mode: 'auto' }) });
  loadAssembly(kernel, [createMcpPlugin(registry)]);
  try {
  const first = await kernel.call('mcp.inspect', { server: 'fx', tool: 'echo' });
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }));
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":"x"}', schemaDigest: first.schemaDigest }),
    (error) => error.code === 'mcp_definition_stale',
  );
  const second = await kernel.call('mcp.inspect', { server: 'fx', tool: 'echo' });
  assert.notEqual(second.schemaDigest, first.schemaDigest, 'the digest follows the definition');
  // 新的那一份声明要的是数字：按新形状递才通得过，这一句同时说明校验读的是当前定义而不是旧的。
  const called = await kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":7}', schemaDigest: second.schemaDigest });
  assert.match(called.text, /echo: 7/);
  assert.equal(called.effectiveCapability, 'mcp:fx/echo');
  await assert.rejects(
    () => kernel.call('mcp.call', { server: 'fx', tool: 'echo', arguments: '{"value":"x"}', schemaDigest: second.schemaDigest }),
    (error) => error.code === 'mcp_arguments_invalid',
  );
  } finally {
    await registry.close();
  }
});

// 两件固定工具是披露入口：模式藏不掉它们，也挑不动它们（D63 同一条规则，MCP 这一格一样成立）。
test('a mode can neither select nor hide the two MCP tools', async () => {
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [createMcpPlugin({ servers: () => ['fx'], toolsOf: async () => [], definition: async () => ({}), call: async () => ({}) })]);
  assert.deepEqual(kernel.list(), ['mcp.call', 'mcp.inspect']);
  assert.deepEqual(kernel.selectable(), [], '登记了但不在模式能挑的范围里');
  const chain = createDecisionChain({ mode: 'auto' });
  assert.deepEqual(chain.evaluate === undefined, false);
});
