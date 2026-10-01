// 模型接口（D13）：自己写的最小 HTTP 客户端，打一个 Messages 兼容端点。
// 服务地址属于普通配置，凭据只从环境变量读；能力上限由提供方声明，配置只能把它调低。
// 流式接收期间就开始拼装工具调用：增量到的 JSON 片段先积在块上，块一关就解析成一次调用交出去。
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from './error.js';

// 重试边界照 Codex 的 RetryPolicy 那三条可重试类别：429、5xx、传输。请求构造错误与响应内容不可解析永不重试。
// 默认值是本项目自定的起点，配置层可以覆盖。
export const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  retry429: true,
  retry5xx: true,
  retryTransport: true,
});

// 提供方声明的能力上限。配置请求的每一项都不能超过这里：布尔项只能关不能开，数值项取更小的那个。
export const MESSAGES_CAPABILITIES = Object.freeze({
  streaming: true,
  parallelToolCalls: false,
  maxOutputTokens: 8192,
});

const ANTHROPIC_VERSION = '2023-06-01';

// 错误详情里带的响应正文长度上限：网关出错时可能交回一整页 HTML，说明留一段就够。
const DETAIL_BYTES = 500;

export function capabilitiesOf(requested = {}) {
  const effective = { ...MESSAGES_CAPABILITIES };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(MESSAGES_CAPABILITIES, key)) throw new KernelError('provider_capability_unknown', { detail: key });
    const declared = MESSAGES_CAPABILITIES[key];
    if (typeof value !== typeof declared) throw new KernelError('provider_capability_invalid', { detail: `${key} must be a ${typeof declared}` });
    effective[key] = typeof declared === 'boolean' ? value && declared : Math.min(value, declared);
  }
  return Object.freeze(effective);
}

// 服务地址必须是 HTTP(S) 的根：不带凭据、查询与片段，否则同一份配置在不同宿主下会打到不同地方。
// 路径末尾的 /v1 不重复补。
function apiRoot(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new KernelError('provider_base_url_required');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new KernelError('provider_base_url_invalid', { detail: baseUrl });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new KernelError('provider_base_url_invalid', { detail: 'an HTTP(S) root without credentials, query, or fragment' });
  }
  const base = baseUrl.replace(/\/+$/, '');
  return parsed.pathname.endsWith('/v1') ? base : `${base}/v1`;
}

function backoffMs(baseDelayMs, attempt) {
  return baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2);
}

// 重试只覆盖建立响应这一步：流已经开始往外吐内容之后再重试，会把同一段内容重复交给模型。
async function open(url, init, retry) {
  // 退避期间被取消也算取消，不能把定时器抛出的 AbortError 原样交出去。
  const wait = async (attempt) => {
    try {
      await sleep(backoffMs(retry.baseDelayMs, attempt), undefined, { signal: init.signal });
    } catch (error) {
      throw new KernelError('provider_cancelled', { cause: error });
    }
  };
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error?.name === 'AbortError') throw new KernelError('provider_cancelled', { cause: error });
      if (!retry.retryTransport || attempt >= retry.maxAttempts) {
        throw new KernelError('provider_transport_failed', { cause: error });
      }
      await wait(attempt);
      continue;
    }
    if (response.ok) return response;
    const retryable = (response.status === 429 && retry.retry429) || (response.status >= 500 && retry.retry5xx);
    if (!retryable || attempt >= retry.maxAttempts) {
      // 网关不一定交回 JSON，状态码是这一层唯一可靠的依据，响应正文只作为说明，截一段就够。
      const body = (await response.text()).slice(0, DETAIL_BYTES);
      throw new KernelError('provider_http_error', { detail: `${response.status} ${body}`.trimEnd() });
    }
    await wait(attempt);
  }
}

// SSE 的一帧以空行结束，一帧里的 data 行可以连着几行；其余字段与注释行不带内容。
async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data === '' || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch (error) {
        throw new KernelError('provider_stream_invalid', { cause: error, detail: data });
      }
    }
  }
  // 流结束时还剩下没有以空行收尾的半帧：里面可能是一次没交出去的工具调用，报出来而不是悄悄丢掉。
  if (buffer.trim() !== '') throw new KernelError('provider_stream_invalid', { detail: 'the stream ended inside a frame' });
}

// 把重建出来的会话投影折成 Messages 的 messages：连续的几条工具结果并进同一条 user 消息，
// 因为端点要求工具结果紧跟在发出调用的那条助手消息之后。
function toWireMessages(view) {
  const messages = [];
  // 助手那一轮里每个调用都得有对应的结果，缺一条端点就把整份请求拒掉，而且从外面的报错看不出缺在哪一条。
  const answered = new Set(view.filter((entry) => entry.role === 'tool').map((entry) => entry.id));
  for (const entry of view) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
      continue;
    }
    if (entry.role === 'assistant') {
      const content = [];
      if (entry.text !== '') content.push({ type: 'text', text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        if (!answered.has(call.id)) {
          throw new KernelError('provider_unanswered_call', { detail: `${call.name} (${call.id})` });
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    const result = {
      type: 'tool_result',
      tool_use_id: entry.id,
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
      is_error: entry.failed === true,
    };
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(result);
    else messages.push({ role: 'user', content: [result] });
  }
  return messages;
}

export function createMessagesProvider({
  baseUrl,
  model,
  apiKeyEnv = 'LIGULE_API_KEY',
  capabilities,
  retry = DEFAULT_RETRY,
} = {}) {
  const root = apiRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = capabilitiesOf(capabilities);

  async function* stream(request, { signal } = {}) {
    // 凭据在发请求时才读：进程运行期间换过密钥不必重建提供方，配置快照里也始终没有它。
    const apiKey = process.env[apiKeyEnv];
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new KernelError('provider_credential_missing', { detail: apiKeyEnv });
    }
    const response = await open(`${root}/messages`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: effective.maxOutputTokens,
        stream: effective.streaming,
        system: request.system,
        messages: toWireMessages(request.messages ?? []),
        tools: (request.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      }),
    }, retry);
    if (response.body === null) throw new KernelError('provider_stream_missing');

    const blocks = new Map();
    let started = false;
    for await (const event of parseSse(response.body)) {
      // 端点可以增加自己的事件类型，带内容的那几类之外的都跳过。
      if (event.type === 'message_start') {
        started = true;
        continue;
      }
      if (!started) throw new KernelError('provider_stream_invalid', { detail: 'an event precedes message_start' });
      if (event.type === 'content_block_start') {
        const content = event.content_block ?? {};
        if (content.type === 'text') blocks.set(event.index, { kind: 'text' });
        else if (content.type === 'tool_use') blocks.set(event.index, { kind: 'tool', id: content.id, name: content.name, json: '' });
        else throw new KernelError('provider_content_unsupported', { detail: String(content.type) });
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a delta without an open block' });
        const delta = event.delta ?? {};
        if (delta.type === 'text_delta') {
          yield { type: 'text', text: delta.text ?? '' };
        } else if (delta.type === 'input_json_delta') {
          block.json += delta.partial_json ?? '';
        } else {
          throw new KernelError('provider_stream_invalid', { detail: `unsupported delta ${String(delta.type)}` });
        }
      } else if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a stop without an open block' });
        blocks.delete(event.index);
        if (block.kind !== 'tool') continue;
        let args;
        try {
          args = block.json === '' ? {} : JSON.parse(block.json);
        } catch (error) {
          throw new KernelError('provider_tool_args_invalid', { cause: error, detail: block.json });
        }
        yield { type: 'tool-call', id: block.id, name: block.name, args };
      }
    }
  }

  const provider = {
    name: 'messages',
    model,
    capabilities: effective,
    stream,
    // 换模型是显式的一步：交回一个新的提供方，不在失败时悄悄改用别的模型（D13）。
    withModel(next) {
      return createMessagesProvider({ baseUrl, model: next, apiKeyEnv, capabilities, retry });
    },
  };
  return Object.freeze(provider);
}
