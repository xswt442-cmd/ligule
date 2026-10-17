// 第 11.5 步的验收：Chat Completions 那一种线上形状（D31）。
// 与 test/provider.test.js 同一种测法——本地起一个真实 HTTP 服务，按 SSE 一帧一帧写出去，
// 客户端走的是它平时那条解析路径；分片切在工具调用的参数中间，攒不出一次调用就当场暴露。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CHAT_COMPLETIONS_CAPABILITIES, chatCompletionsCapabilities, createChatCompletionsProvider, readTool,
} from '../dist/index.js';
import { listenFetchable } from './helpers/port.js';

const API_KEY_ENV = 'LIGULE_TEST_API_KEY';

function sseBody(chunks) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function withEndpoint(respond, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const text = Buffer.concat(body).toString('utf8');
    const observed = { url: request.url, headers: request.headers, body: text === '' ? undefined : JSON.parse(text) };
    requests.push(observed);
    await respond(response, observed);
  });
  const port = await listenFetchable(server);
  process.env[API_KEY_ENV] = 'test-key';
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    delete process.env[API_KEY_ENV];
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function provider(baseUrl, extra = {}) {
  return createChatCompletionsProvider({ baseUrl, model: 'test-model', apiKeyEnv: API_KEY_ENV, ...extra });
}

// 一次调用分三片到达，文本从中间穿过；整段响应再按 7 个字节切开写，切点落在 JSON 里。
const TOOL_CALL_CHUNKS = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'the file is one line' } }] },
  { choices: [{ index: 0, delta: { content: 'Let me ' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path": "no' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'te.txt"}' } }] } }] },
  { choices: [{ index: 0, delta: { content: 'read it.' } }] },
  { choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] },
];

test('tool call fragments arriving by index are assembled into one call', async () => {
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(sseBody(TOOL_CALL_CHUNKS), 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 7) {
      response.write(bytes.subarray(offset, offset + 7));
    }
    response.end();
  }, async (baseUrl) => {
    const events = await collect(provider(baseUrl).stream({ system: '', messages: [], tools: [] }));
    // 文本与推理按到达顺序交出；调用没有「这一块结束」那一种事件，攒到流收尾再交，顺序按 index。
    assert.deepEqual(events, [
      { type: 'reasoning', text: 'the file is one line' },
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'read it.' },
      { type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });
});

test('null usage on ordinary SSE chunks does not discard a tool call', async () => {
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([
      ...TOOL_CALL_CHUNKS.map(chunk => ({ ...chunk, usage: null })),
      { choices: [], usage: { prompt_tokens: 31, completion_tokens: 9 } },
    ]));
  }, async (baseUrl) => {
    const events = await collect(provider(baseUrl).stream({ system: '', messages: [], tools: [] }));
    assert.deepEqual(events.filter(event => event.type === 'tool-call'), [
      { type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } },
    ]);
    assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', input: 31, output: 9 });
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls' });
  });
});

test('the request body carries the shape this form names, and the address is the one from config', async () => {
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
  }, async (baseUrl, requests) => {
    await collect(provider(baseUrl).stream({
      system: 'rules here',
      messages: [
        { role: 'user', text: 'read the note' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
        { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false },
      ],
      tools: [{ name: 'read', description: readTool.description, parameters: readTool.parameters }],
    }));

    const { url, headers, body } = requests[0];
    // 地址按给出的那一份用：这里给的是没有 /v1 的根（DeepSeek 那一类），路径就是 /chat/completions。
    assert.equal(url, '/chat/completions');
    assert.equal(headers.authorization, 'Bearer test-key');
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, CHAT_COMPLETIONS_CAPABILITIES.maxOutputTokens);
    assert.equal(body.parallel_tool_calls, true);
    // 系统段在这一种形状里是消息列表的第一条；工具定义套在 function 下面；结果是一条 role:"tool" 的消息。
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'rules here' },
      { role: 'user', content: 'read the note' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"note.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"text":"the body"}' },
    ]);
    assert.deepEqual(body.tools, [{
      type: 'function',
      function: { name: 'read', description: readTool.description, parameters: readTool.parameters },
    }]);

    // 另一种约定也要能用：OpenAI 自己的 base_url 含 /v1，这时不重复补。
    await collect(provider(`${baseUrl}/v1`).stream({ system: '', messages: [], tools: [] }));
    assert.equal(requests[1].url, '/v1/chat/completions');
  });
});

test('invalid tool names use collision-free wire aliases in tools, history, and returned calls', async () => {
  const longUnicodeName = `读取${'项目文件'.repeat(30)}`;
  const inspectAlias = `ligule_${createHash('sha256').update('mcp.inspect').digest('hex').slice(0, 48)}`;
  const historyAlias = `ligule_${createHash('sha256').update('mcp.call').digest('hex').slice(0, 48)}`;
  const calls = [];
  await withEndpoint(async (response, request) => {
    const toolNames = (request.body.tools ?? []).map((tool) => tool.function.name);
    const historyNames = (request.body.messages ?? []).flatMap((message) =>
      (message.tool_calls ?? []).map((call) => call.function.name));
    const allNames = [...toolNames, ...historyNames];
    calls.push({ toolNames, historyNames });
    if (allNames.some((name) => !/^[A-Za-z0-9_-]{1,64}$/u.test(name))) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"invalid function name"}}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const returnedName = calls.length === 1 ? toolNames[0]
      : calls.length === 2 ? historyAlias
        : calls.length === 3 ? 'read' : 'mcp.unregistered';
    response.end(sseBody([{
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function', function: { name: returnedName, arguments: '{}' } }] } }],
    }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]));
  }, async (baseUrl, requests) => {
    const tools = [
      { name: 'mcp.inspect', description: 'inspect', parameters: { type: 'object' } },
      { name: 'mcp.call', description: 'call', parameters: { type: 'object' } },
      { name: 'read', description: 'read', parameters: { type: 'object' } },
      { name: longUnicodeName, description: 'unicode', parameters: { type: 'object' } },
      { name: inspectAlias, description: 'an original name equal to another name’s alias', parameters: { type: 'object' } },
    ];
    const first = await collect(provider(baseUrl).stream({ system: '', messages: [], tools }));
    assert.deepEqual(first.filter((event) => event.type === 'tool-call'), [
      { type: 'tool-call', id: 'call_1', name: 'mcp.inspect', args: {} },
    ]);
    const firstNames = requests[0].body.tools.map((tool) => tool.function.name);
    assert.equal(new Set(firstNames).size, firstNames.length, 'wire names stay unique when an original name matches an alias');
    assert.equal(firstNames[2], 'read', 'a valid short name is unchanged');
    assert.ok(firstNames.every((name) => /^[A-Za-z0-9_-]{1,64}$/u.test(name)));
    assert.notEqual(firstNames[0], 'mcp.inspect');
    assert.notEqual(firstNames[1], 'mcp.call');
    assert.notEqual(firstNames[3], longUnicodeName);
    assert.notEqual(firstNames[4], inspectAlias, 'the colliding original name is encoded too');

    const recovered = await collect(provider(baseUrl).stream({
      system: '',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
      messages: [
        { role: 'assistant', text: '', toolCalls: [{ id: 'old-call', name: 'mcp.call', args: {} }] },
        { role: 'tool', id: 'old-call', tool: 'mcp.call', content: 'done', failed: false },
      ],
    }));
    assert.deepEqual(recovered.filter((event) => event.type === 'tool-call'), [
      { type: 'tool-call', id: 'call_2', name: 'mcp.call', args: {} },
    ]);
    assert.equal(requests[1].body.tools[0].function.name, 'read');
    assert.deepEqual(calls[1].historyNames, [historyAlias], 'a no-longer-current historical tool name is still wire-safe');

    const unchanged = await collect(provider(baseUrl).stream({
      system: '',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
      messages: [{ role: 'user', text: 'continue' }],
    }));
    assert.deepEqual(unchanged.filter((event) => event.type === 'tool-call'), [
      { type: 'tool-call', id: 'call_3', name: 'read', args: {} },
    ], 'a legal short response name stays unchanged');

    const unknown = await collect(provider(baseUrl).stream({
      system: '',
      tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
      messages: [{ role: 'user', text: 'continue' }],
    }));
    assert.deepEqual(unknown.filter((event) => event.type === 'tool-call'), [
      { type: 'tool-call', id: 'call_4', name: 'mcp.unregistered', args: {} },
    ], 'unknown names pass through unchanged for the Host kernel to reject');
  });
});

test('an assistant round with an unanswered call is refused before the request goes out', async () => {
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  }, async (baseUrl) => {
    await assert.rejects(
      collect(provider(baseUrl).stream({
        system: '',
        messages: [{ role: 'assistant', text: '', toolCalls: [{ id: 'call_x', name: 'read', args: {} }] }],
      })),
      (error) => error.code === 'provider_unanswered_call' && /call_x/.test(error.detail),
    );
  });
});

test('the declared limits of this form can be lowered by config but not raised', () => {
  assert.deepEqual(chatCompletionsCapabilities(), CHAT_COMPLETIONS_CAPABILITIES);
  assert.equal(chatCompletionsCapabilities({ parallelToolCalls: false }).parallelToolCalls, false);
  assert.equal(chatCompletionsCapabilities({ maxOutputTokens: 64 }).maxOutputTokens, 64);
  assert.equal(
    chatCompletionsCapabilities({ maxOutputTokens: 999_999 }).maxOutputTokens,
    CHAT_COMPLETIONS_CAPABILITIES.maxOutputTokens,
    'a config value cannot raise a declared limit',
  );
  assert.throws(() => chatCompletionsCapabilities({ vision: true }), (error) => error.code === 'provider_capability_unknown');
});

// 流式也要把用量要回来（压缩的那一条压力判据看的是端点真实报回的那一份，D75）：
// 那一族端点不写 stream_options 就不交 usage，而它落在一条没有 choices 的收尾分片上。
test('a streamed answer asks for usage and hands back the one it got', async () => {
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([
      { choices: [{ index: 0, delta: { content: 'hi' } }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]));
  }, async (baseUrl, requests) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [{ role: 'user', text: 'x' }] })), [
      { type: 'text', text: 'hi' },
      { type: 'usage', input: 900, output: 12 },
      { type: 'finish', reason: 'stop' },
    ]);
    assert.deepEqual(requests[0].body.stream_options, { include_usage: true });

    // 不认这一格的兼容代理把 streamUsage 降成 false：少一条用量，别少一次请求。
    await collect(provider(baseUrl, { capabilities: { streamUsage: false } }).stream({ system: '', tools: [], messages: [] }));
    assert.equal(requests[1].body.stream_options, undefined);
  });
});

test('a cancel that lands while the stream is still open reports provider_cancelled', async () => {
  // 第 94 步在真端点上撞到的那条：流已经在吐内容时打断，Node 交回的是只带数字码的 AbortError，
  // 界面那一侧认的是稳定码，所以这一处要在模型层就换掉（core/src/model/http.ts 的 cancelMapped）。
  await withEndpoint(async (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '第一段' } }] })}\n\n`);
    await new Promise(() => {});
  }, async (baseUrl) => {
    const controller = new AbortController();
    const stream = provider(baseUrl).stream({ system: '', tools: [], messages: [{ role: 'user', content: 'x' }] }, { signal: controller.signal });
    assert.deepEqual((await stream.next()).value, { type: 'text', text: '第一段' });
    controller.abort();
    await assert.rejects(() => stream.next(), (error) => error.code === 'provider_cancelled');
  });
});
