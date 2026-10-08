import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  capabilitiesOf, createConfig, createKernel, createLoop, createMessagesProvider, createSessionLog,
  DEFAULT_RETRY, MESSAGES_CAPABILITIES, readTool,
} from '../dist/index.js';

const API_KEY_ENV = 'LIGULE_TEST_API_KEY';
const FAST_RETRY = { ...DEFAULT_RETRY, baseDelayMs: 1 };

function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const EMPTY_TURN = [{ type: 'message_start', message: { usage: {} } }, { type: 'message_stop' }];

// 一次真实的 HTTP 往返：本地起一个服务按 SSE 写出去，客户端走的是它平时走的那条解析路径。
async function withEndpoint(respond, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    requests.push({
      url: request.url,
      headers: request.headers,
      body: text === '' ? undefined : JSON.parse(text),
    });
    await respond(requests.length, response, requests[requests.length - 1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address()?.port;
  // 一次整套跑里见过这里拿到的端口不能用，报回来的却是端点那一句 `provider_transport_failed`（fetch 的「bad port」）：
  // 端口不对就在这儿说清，别让它混进端点那一类的失败里。
  if (typeof port !== 'number' || port === 0) throw new Error(`test_endpoint_port_unusable:${String(port)}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env[API_KEY_ENV] = 'test-key';
  try {
    return await run(baseUrl, requests);
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
  return createMessagesProvider({ baseUrl, model: 'test-model', apiKeyEnv: API_KEY_ENV, retry: FAST_RETRY, ...extra });
}

test('a tool call is assembled while the stream is still arriving', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "no' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'te.txt"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = sseBody(turn);
    // 按 7 个字节一段写出去，切点落在 JSON 中间：拼装必须在接收期间做，不能等整帧到齐。
    for (let index = 0; index < body.length; index += 7) {
      response.write(body.slice(index, index + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  }, async (baseUrl, requests) => {
    const events = await collect(provider(baseUrl).stream({
      system: 'be brief',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', text: 'question' }],
    }));
    assert.deepEqual(events, [
      { type: 'text', text: 'let me ' },
      { type: 'text', text: 'look' },
      { type: 'tool-call', id: 'call_1', name: 'read', args: { path: 'note.txt' } },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/messages');
    assert.equal(requests[0].headers['x-api-key'], 'test-key');
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(requests[0].body, {
      model: 'test-model',
      max_tokens: MESSAGES_CAPABILITIES.maxOutputTokens,
      stream: true,
      system: 'be brief',
      messages: [{ role: 'user', content: 'question' }],
      tools: [{
        name: 'read',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
  });
});

// 推理段是一种内容块（D32）：它作为 reasoning 事件交出去，与答案分开，签名攒着不外传。
test('a reasoning block becomes reasoning events while the answer stays separate', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the file is one line' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'reading it' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'reasoning', text: 'the file is one line' },
      { type: 'text', text: 'reading it' },
    ]);
  });
});

// 签名只会跟在推理块上；落在别的内容块上说明这一份流不是我们以为的那个形状。
test('a signature delta on another kind of block is reported as a broken stream', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })),
      (error) => error.code === 'provider_stream_invalid' && /signature/.test(error.detail),
    );
  });
});

// 「见过并且不要」与「没见过」是两件事：类型认不出来的仍然当场报出去，不悄悄收下。
test('a content block type nobody named is still refused', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'audio', audio: {} } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })),
      (error) => error.code === 'provider_content_unsupported' && /audio/.test(error.detail),
    );
  });
});

test('a rebuilt session reaches the wire as assistant turns and merged tool results', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(EMPTY_TURN));
  }, async (baseUrl, requests) => {
    // 服务地址已经带 /v1 时不重复补一段。
    await collect(provider(`${baseUrl}/v1`, { capabilities: { maxOutputTokens: 100 } }).stream({
      system: '',
      tools: [],
      messages: [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'reading', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
        { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'body' }, failed: false },
        { role: 'tool', id: 'call_2', tool: 'read', content: '', failed: true, code: 'path_not_found' },
      ],
    }));
    assert.equal(requests[0].url, '/v1/messages');
    assert.equal(requests[0].body.max_tokens, 100, '配置只能把上限调低，调低之后请求体跟着变');
    assert.deepEqual(requests[0].body.messages, [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'note.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"text":"body"}', is_error: false },
          { type: 'tool_result', tool_use_id: 'call_2', content: '', is_error: true },
        ],
      },
    ]);
  });
});

test('configuration can lower a declared capability but never raise it', () => {
  assert.deepEqual(capabilitiesOf({ parallelToolCalls: true, maxOutputTokens: 999_999 }), {
    streaming: true,
    parallelToolCalls: false,
    maxOutputTokens: MESSAGES_CAPABILITIES.maxOutputTokens,
  });
  assert.equal(capabilitiesOf({ streaming: false }).streaming, false);
  assert.deepEqual(capabilitiesOf(), MESSAGES_CAPABILITIES);
  assert.throws(() => capabilitiesOf({ thinking: true }), (error) => error.code === 'provider_capability_unknown');
  assert.throws(() => capabilitiesOf({ maxOutputTokens: '8192' }), (error) => error.code === 'provider_capability_invalid');
});

test('a retryable status is retried up to the boundary and a non-retryable one is not retried', async () => {
  await withEndpoint(async (attempt, response) => {
    if (attempt < 3) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream is busy');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(EMPTY_TURN));
  }, async (baseUrl, requests) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({})), []);
    assert.equal(requests.length, 3);
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('upstream is busy');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      () => collect(provider(baseUrl, { retry: { ...FAST_RETRY, maxAttempts: 2 } }).stream({})),
      (error) => error.code === 'provider_http_error' && error.detail.startsWith('503'),
    );
    assert.equal(requests.length, 2, '尝试次数不超过定下的边界');
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('bad request');
  }, async (baseUrl, requests) => {
    await assert.rejects(() => collect(provider(baseUrl).stream({})), (error) => error.code === 'provider_http_error');
    assert.equal(requests.length, 1, 'a 400 is never retried');
  });
});

test('a tool call whose arguments are not valid JSON reports a stable code', async () => {
  const turn = [
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_stop', index: 0 },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({})),
      (error) => error.code === 'provider_tool_args_invalid' && error.detail === '{"path":',
    );
  });
});

test('an unsupported block type and a stream that starts late both report a stable code', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'image' } },
    ]));
  }, async (baseUrl) => {
    await assert.rejects(() => collect(provider(baseUrl).stream({})), (error) => error.code === 'provider_content_unsupported');
  });

  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }]));
  }, async (baseUrl) => {
    await assert.rejects(() => collect(provider(baseUrl).stream({})), (error) => error.code === 'provider_stream_invalid');
  });
});

test('a stream that ends inside a frame is reported instead of dropped', async () => {
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // 最后一帧没有空行收尾：里面是一次没交出去的工具调用。
    response.write(sseBody([{ type: 'message_start', message: { usage: {} } }]));
    response.end('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"read"}}\n');
  }, async (baseUrl) => {
    await assert.rejects(
      () => collect(provider(baseUrl).stream({})),
      (error) => error.code === 'provider_stream_invalid' && error.detail === 'the stream ended inside a frame',
    );
  });
});

test('the credential is read from the environment at request time and a missing one is refused', async () => {
  delete process.env[API_KEY_ENV];
  const events = collect(createMessagesProvider({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: API_KEY_ENV }).stream({}));
  await assert.rejects(() => events, (error) => error.code === 'provider_credential_missing' && error.detail === API_KEY_ENV);
});

test('a projection with a call nobody answered is refused before the request goes out', async () => {
  process.env[API_KEY_ENV] = 'test-key';
  try {
    const events = collect(createMessagesProvider({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: API_KEY_ENV }).stream({
      messages: [{ role: 'assistant', text: '', toolCalls: [{ id: 'call_7', name: 'read', args: {} }] }],
    }));
    await assert.rejects(
      () => events,
      (error) => error.code === 'provider_unanswered_call' && error.detail === 'read (call_7)',
    );
  } finally {
    delete process.env[API_KEY_ENV];
  }
});

test('a service address that is not an HTTP(S) root, and a missing model, are refused at construction', () => {
  assert.throws(() => createMessagesProvider({ model: 'm' }), (error) => error.code === 'provider_base_url_required');
  for (const baseUrl of [
    'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?a=1', 'https://example.com/#frag', 'not a url',
  ]) {
    assert.throws(
      () => createMessagesProvider({ baseUrl, model: 'm' }),
      (error) => error.code === 'provider_base_url_invalid',
      baseUrl,
    );
  }
  assert.throws(
    () => createMessagesProvider({ baseUrl: 'https://example.com' }),
    (error) => error.code === 'provider_model_required',
  );
});

test('switching models is an explicit step that leaves the original provider alone', () => {
  const first = createMessagesProvider({ baseUrl: 'https://example.com', model: 'big', apiKeyEnv: API_KEY_ENV });
  const second = first.withModel('small');
  assert.equal(first.model, 'big');
  assert.equal(second.model, 'small');
  assert.deepEqual(second.capabilities, first.capabilities);
});

test('one real round trip: the second request body is what the record rebuilds into', async () => {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'provider-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'the body');
    const session = createSessionLog({ directory: root, id: 'round' });
    const kernel = createKernel({ config: createConfig({ user: { boundary: workspace } }), session });
    kernel.register(readTool);
    const toolTurn = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "note.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    const textTurn = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file says so' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    // 答哪一轮看这一份请求里有没有工具结果，不看第几次连接：一次传输层的重试会让同一轮被问两次，
    // 按次数答的话测试断的是重试的次序，不是它本来要断的那件事。
    await withEndpoint(async (attempt, response, request) => {
      const answered = JSON.stringify(request.body?.messages ?? []).includes('tool_result');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sseBody(answered ? textTurn : toolTurn));
    }, async (baseUrl, requests) => {
      const result = await createLoop({ kernel, provider: provider(baseUrl), session }).run('read the note');
      assert.equal(result.text, 'the file says so');
      // 带着工具结果的那一份请求只该有一份：重试把同一轮发两遍时，这里会数到两份。
      const asked = requests.filter((entry) => JSON.stringify(entry.body.messages).includes('tool_result'));
      assert.equal(asked.length, 1, 'the tool round is sent once');
      assert.deepEqual(asked[0].body.messages, [
        { role: 'user', content: 'read the note' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'note.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"text":"the body"}', is_error: false }] },
      ]);
      // 请求体里的每一条都来自记录，记录里的每一条都能投影回去（I5）；最后那一轮助手消息在请求之后才落盘。
      assert.deepEqual(await session.modelView(), [
        { role: 'user', text: 'read the note' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read', args: { path: 'note.txt' } }] },
        { role: 'tool', id: 'call_1', tool: 'read', content: { text: 'the body' }, failed: false, code: undefined },
        { role: 'assistant', text: 'the file says so', toolCalls: [] },
      ]);
      assert.deepEqual(asked[0].body.tools, [{
        name: 'read',
        description: readTool.description,
        input_schema: readTool.parameters,
      }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 端点报回的用量作为一条 usage 事件交出去：压缩的那一条压力判据要拿它修正本地估算（D75）。
// 这一种形状把它拆在两处，输入的在 message_start（含缓存里读回来的那一段），输出的在 message_delta。
test('the usage the endpoint reports comes back as one event at the end', async () => {
  const turn = [
    { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  await withEndpoint(async (attempt, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(turn));
  }, async (baseUrl) => {
    assert.deepEqual(await collect(provider(baseUrl).stream({ system: '', tools: [], messages: [] })), [
      { type: 'text', text: 'hi' },
      { type: 'usage', input: 1500, output: 7 },
    ]);
  });
});
