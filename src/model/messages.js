// Messages 兼容那一种线上形状（D13、D31）：Anthropic 的 `POST <base>/v1/messages`，鉴权头 `x-api-key`。
// 地址、重试、SSE 与凭据都在 model/http.js 那一层；这里只有形状本身：请求体怎么拼、事件怎么折回内部形状。
import { KernelError } from '../kernel/error.js';
import { apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, resolveCapabilities, resultText } from './http.js';

// 提供方声明的能力上限。配置请求的每一项都不能超过这里。
export const MESSAGES_CAPABILITIES = Object.freeze({
  streaming: true,
  parallelToolCalls: false,
  maxOutputTokens: 8192,
});

const ANTHROPIC_VERSION = '2023-06-01';

export function capabilitiesOf(requested = {}) {
  return resolveCapabilities(MESSAGES_CAPABILITIES, requested);
}

// 这一种形状的端点挂在 /v1 下面；地址末尾已经有了就不重复补（dsh 的 messages-api 同一条规则）。
function messagesRoot(baseUrl) {
  const root = apiRoot(baseUrl);
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

// 把重建出来的会话投影折成 Messages 的 messages：连续的几条工具结果并进同一条 user 消息，
// 因为端点要求工具结果紧跟在发出调用的那条助手消息之后。
function toWireMessages(view) {
  const messages = [];
  assertAllAnswered(view);
  for (const entry of view) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
      continue;
    }
    if (entry.role === 'assistant') {
      const content = [];
      if (entry.text !== '') content.push({ type: 'text', text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    const result = {
      type: 'tool_result',
      tool_use_id: entry.id,
      content: resultText(entry.content),
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
  const root = messagesRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = capabilitiesOf(capabilities);

  async function* stream(request, { signal } = {}) {
    const response = await open(`${root}/messages`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-api-key': readCredential(apiKeyEnv),
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
        // 推理段是一种内容块（D32）：认出来，把它的内容增量作为 reasoning 事件交出去。
        // 签名先攒着不外传——把带签名的推理块回传是 Anthropic 原生端点那一类要求，接上之后再补。
        else if (content.type === 'thinking' || content.type === 'redacted_thinking') blocks.set(event.index, { kind: 'reasoning' });
        else throw new KernelError('provider_content_unsupported', { detail: String(content.type) });
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a delta without an open block' });
        const delta = event.delta ?? {};
        if (delta.type === 'text_delta') {
          yield { type: 'text', text: delta.text ?? '' };
        } else if (delta.type === 'input_json_delta') {
          block.json += delta.partial_json ?? '';
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'reasoning', text: delta.thinking ?? '' };
        } else if (delta.type === 'signature_delta') {
          if (block.kind !== 'reasoning') {
            throw new KernelError('provider_stream_invalid', { detail: 'a signature delta on a block that is not reasoning' });
          }
          block.signature = (block.signature ?? '') + (delta.signature ?? '');
        } else {
          throw new KernelError('provider_stream_invalid', { detail: `unsupported delta ${String(delta.type)}` });
        }
      } else if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a stop without an open block' });
        blocks.delete(event.index);
        if (block.kind !== 'tool') continue;
        yield { type: 'tool-call', id: block.id, name: block.name, args: parseArgs(block.json) };
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

// 参数解析不了当场报出去，不等流结束（D13）。空片段是一次没有参数的调用，不是缺参数。
function parseArgs(json) {
  if (json === '') return {};
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { cause: error, detail: json });
  }
}
