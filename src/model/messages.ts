// Messages 兼容那一种线上形状（D13、D31）：Anthropic 的 `POST <base>/v1/messages`，鉴权头 `x-api-key`。
// 地址、重试、SSE 与凭据都在 model/http.ts 那一层；这里只有形状本身：请求体怎么拼、事件怎么折回内部形状。
import { KernelError } from '../kernel/error.js';
import {
  apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, resolveCapabilities, resultText,
  type ProviderCapabilities, type RetryPolicy,
} from './http.js';
import type { ModelMessage, ModelRequest, ProviderEvent } from '../kernel/loop.js';

interface MessagesCapabilities extends ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens: number;
}

interface MessagesProviderOptions {
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly apiKeyEnv?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly retry?: RetryPolicy;
}

interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: MessagesCapabilities;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal | null }): AsyncGenerator<ProviderEvent>;
  withModel(model: string): ModelProvider;
}

type MessagesBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string | undefined; readonly content: string | undefined; readonly is_error: boolean };

type MessagesWireMessage =
  | { readonly role: 'user'; content: string | MessagesBlock[] }
  | { readonly role: 'assistant'; content: MessagesBlock[] };

type MessageBlockState =
  | { readonly kind: 'text' }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; json: string }
  | { readonly kind: 'reasoning'; signature?: string };

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, detail: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new KernelError('provider_stream_invalid', { detail });
  }
  return value;
}

function requiredString(value: unknown, detail: string): string {
  if (typeof value !== 'string' || value === '') throw new KernelError('provider_stream_invalid', { detail });
  return value;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberCapability(value: boolean | number, name: string): number {
  if (typeof value !== 'number') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a number` });
  return value;
}

function booleanCapability(value: boolean | number, name: string): boolean {
  if (typeof value !== 'boolean') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a boolean` });
  return value;
}

// 提供方声明的能力上限。配置请求的每一项都不能超过这里。
export const MESSAGES_CAPABILITIES: MessagesCapabilities = Object.freeze({
  streaming: true,
  parallelToolCalls: false,
  maxOutputTokens: 8192,
});

const ANTHROPIC_VERSION = '2023-06-01';

export function capabilitiesOf(requested: Readonly<Record<string, unknown>> = {}): MessagesCapabilities {
  const resolved = resolveCapabilities(MESSAGES_CAPABILITIES, requested);
  return Object.freeze({
    streaming: booleanCapability(resolved.streaming, 'streaming'),
    parallelToolCalls: booleanCapability(resolved.parallelToolCalls, 'parallelToolCalls'),
    maxOutputTokens: numberCapability(resolved.maxOutputTokens, 'maxOutputTokens'),
  });
}

// 这一种形状的端点挂在 /v1 下面；地址末尾已经有了就不重复补（dsh 的 messages-api 同一条规则）。
function messagesRoot(baseUrl: unknown): string {
  const root = apiRoot(baseUrl);
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

// 把重建出来的会话投影折成 Messages 的 messages：连续的几条工具结果并进同一条 user 消息，
// 因为端点要求工具结果紧跟在发出调用的那条助手消息之后。
function toWireMessages(view: readonly ModelMessage[]): MessagesWireMessage[] {
  const messages: MessagesWireMessage[] = [];
  assertAllAnswered(view);
  for (const entry of view) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
      continue;
    }
    if (entry.role === 'assistant') {
      const content: MessagesBlock[] = [];
      if (entry.text !== '') content.push({ type: 'text', text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    const result: MessagesBlock = {
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
}: MessagesProviderOptions = {}): ModelProvider {
  const root = messagesRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = capabilitiesOf(capabilities);

  async function* stream(request: ModelRequest, { signal }: { readonly signal?: AbortSignal | null } = {}): AsyncGenerator<ProviderEvent> {
    const response = await open(`${root}/messages`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'x-api-key': await readCredential(apiKeyEnv),
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

    const blocks = new Map<number, MessageBlockState>();
    let started = false;
    // 用量攒在这里，流收尾时才交一条：这一种形状把它拆在两处——`message_start` 给输入的，`message_delta` 给输出的。
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const rawEvent of parseSse(response.body)) {
      const event = asRecord(rawEvent, 'an event is not an object');
      // 端点可以增加自己的事件类型，带内容的那几类之外的都跳过。
      if (event.type === 'message_start') {
        started = true;
        const message = typeof event.message === 'object' && event.message !== null ? event.message : {};
        const usageValue = asRecord(message, 'message_start has an invalid message');
        const usage = typeof usageValue.usage === 'object' && usageValue.usage !== null ? usageValue.usage : {};
        const usageRecord = asRecord(usage, 'message_start has invalid usage');
        // 窗口占的是这几段之和：缓存里读回来的那一段同样是这一轮请求的上下文（压缩的压力线要看它）。
        inputTokens = Number(usageRecord.input_tokens ?? 0) + Number(usageRecord.cache_read_input_tokens ?? 0)
          + Number(usageRecord.cache_creation_input_tokens ?? 0);
        outputTokens = Number(usageRecord.output_tokens ?? 0);
        continue;
      }
      if (!started) throw new KernelError('provider_stream_invalid', { detail: 'an event precedes message_start' });
      if (event.type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        if (!Number.isInteger(index)) throw new KernelError('provider_stream_invalid', { detail: 'content block has an invalid index' });
        const content = asRecord(event.content_block ?? {}, 'content_block_start has an invalid content block');
        if (content.type === 'text') blocks.set(index, { kind: 'text' });
        else if (content.type === 'tool_use') {
          blocks.set(index, {
            kind: 'tool',
            id: requiredString(content.id, 'tool_use has no id'),
            name: requiredString(content.name, 'tool_use has no name'),
            json: '',
          });
        }
        // 推理段是一种内容块（D32）：认出来，把它的内容增量作为 reasoning 事件交出去。
        // 签名先攒着不外传——把带签名的推理块回传是 Anthropic 原生端点那一类要求，接上之后再补。
        else if (content.type === 'thinking' || content.type === 'redacted_thinking') blocks.set(index, { kind: 'reasoning' });
        else throw new KernelError('provider_content_unsupported', { detail: String(content.type) });
      } else if (event.type === 'content_block_delta') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        const block = blocks.get(index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a delta without an open block' });
        const delta = asRecord(event.delta ?? {}, 'content_block_delta has an invalid delta');
        if (delta.type === 'text_delta') {
          yield { type: 'text', text: stringOrEmpty(delta.text) };
        } else if (delta.type === 'input_json_delta') {
          if (block.kind !== 'tool') throw new KernelError('provider_stream_invalid', { detail: 'input JSON delta without a tool block' });
          block.json += stringOrEmpty(delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'reasoning', text: stringOrEmpty(delta.thinking) };
        } else if (delta.type === 'signature_delta') {
          if (block.kind !== 'reasoning') {
            throw new KernelError('provider_stream_invalid', { detail: 'a signature delta on a block that is not reasoning' });
          }
          block.signature = (block.signature ?? '') + stringOrEmpty(delta.signature);
        } else {
          throw new KernelError('provider_stream_invalid', { detail: `unsupported delta ${String(delta.type)}` });
        }
      } else if (event.type === 'content_block_stop') {
        const index = typeof event.index === 'number' ? event.index : Number.NaN;
        const block = blocks.get(index);
        if (block === undefined) throw new KernelError('provider_stream_invalid', { detail: 'a stop without an open block' });
        blocks.delete(index);
        if (block.kind !== 'tool') continue;
        yield { type: 'tool-call', id: block.id, name: block.name, args: parseArgs(block.json) };
      } else if (event.type === 'message_delta') {
        const usage = typeof event.usage === 'object' && event.usage !== null ? asRecord(event.usage, 'message_delta has invalid usage') : {};
        outputTokens = Number(usage.output_tokens ?? outputTokens);
      }
    }
    // 一条都没报回来时不交这一条：压缩的那一条判据宁可沿用本地估算，也不把一个 0 当成真实用量。
    if (inputTokens > 0 || outputTokens > 0) yield { type: 'usage', input: inputTokens, output: outputTokens };
  }

  const provider = {
    name: 'messages',
    model,
    capabilities: effective,
    stream,
    // 换模型是显式的一步：交回一个新的提供方，不在失败时悄悄改用别的模型（D13）。
    withModel(next: string) {
      return createMessagesProvider({ baseUrl, model: next, apiKeyEnv, capabilities, retry });
    },
  };
  return Object.freeze(provider);
}

// 参数解析不了当场报出去，不等流结束（D13）。空片段是一次没有参数的调用，不是缺参数。
function parseArgs(json: string): unknown {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { cause: error, detail: json });
  }
}
