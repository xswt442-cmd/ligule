// Chat Completions 兼容那一种线上形状（D31）：OpenAI 的 `POST <base>/chat/completions`，鉴权头 `Authorization: Bearer`。
// 与 messages.ts 共用 model/http.ts 那一层：地址、重试、SSE 帧与凭据都不在这里重复。
// 两处的实际差别只有三件：请求体的字段形状、工具调用参数的载体（一边是内容块里的 JSON 片段，一边是按下标分片的字符串），
// 以及工具结果是一条独立的 `role:"tool"` 消息而不是并进 user 那一条。
import { KernelError } from '../kernel/error.js';
import {
  apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, resolveCapabilities, resultText,
  type ProviderCapabilities, type RetryPolicy,
} from './http.js';
import type { ModelMessage, ModelRequest, ProviderEvent } from '../kernel/loop.js';

interface ChatCompletionsCapabilities extends ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens: number;
  readonly streamUsage: boolean;
}

interface ChatCompletionsProviderOptions {
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly apiKeyEnv?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly retry?: RetryPolicy;
}

interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ChatCompletionsCapabilities;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal | null }): AsyncGenerator<ProviderEvent>;
  withModel(model: string): ModelProvider;
}

type JsonRecord = Record<string, unknown>;
interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

type ChatToolMessage = { readonly role: 'tool'; readonly tool_call_id: string | undefined; readonly content: string | undefined };
type ChatWireMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly ChatToolCall[] }
  | ChatToolMessage;

interface StreamToolCall {
  id?: string;
  name: string;
  json: string;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, detail: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new KernelError('provider_stream_invalid', { detail });
  }
  return value;
}

function booleanCapability(value: boolean | number, name: string): boolean {
  if (typeof value !== 'boolean') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a boolean` });
  return value;
}

function numberCapability(value: boolean | number, name: string): number {
  if (typeof value !== 'number') throw new KernelError('provider_capability_invalid', { detail: `${name} must be a number` });
  return value;
}

export const CHAT_COMPLETIONS_CAPABILITIES: ChatCompletionsCapabilities = Object.freeze({
  streaming: true,
  parallelToolCalls: true,
  maxOutputTokens: 8192,
  // 流式请求要不要带 `stream_options:{include_usage:true}` 去要那一条用量（D75 的压力线要用真实用量修正本地估算）。
  // 这一族里绝大多数端点认这一格，不认的那一些把它降成 false：少一条用量，压缩的压力线退回本地估算，聊天照跑。
  streamUsage: true,
});

export function chatCompletionsCapabilities(requested: Readonly<Record<string, unknown>> = {}): ChatCompletionsCapabilities {
  const resolved = resolveCapabilities(CHAT_COMPLETIONS_CAPABILITIES, requested);
  return Object.freeze({
    streaming: booleanCapability(resolved.streaming, 'streaming'),
    parallelToolCalls: booleanCapability(resolved.parallelToolCalls, 'parallelToolCalls'),
    maxOutputTokens: numberCapability(resolved.maxOutputTokens, 'maxOutputTokens'),
    streamUsage: booleanCapability(resolved.streamUsage, 'streamUsage'),
  });
}

function toWireMessages(view: readonly ModelMessage[], system: string): ChatWireMessage[] {
  // 系统段在这一种形状里是消息列表的第一条，不是请求体上的一个字段。
  const messages: ChatWireMessage[] = system === '' ? [] : [{ role: 'system', content: system }];
  assertAllAnswered(view);
  for (const entry of view) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      const calls = entry.toolCalls ?? [];
      messages.push({
        role: 'assistant',
        // 只有调用没有文本的那一轮，content 交 null：交空串会让有些兼容层把它当成一段要续写的内容。
        content: entry.text === '' && calls.length > 0 ? null : entry.text,
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        }),
      });
    } else {
      // 每个调用一条结果，按调用 id 对上；这一种形状没有「几条结果并进一条消息」那一条规则。
      messages.push({ role: 'tool', tool_call_id: entry.id, content: resultText(entry.content) });
    }
  }
  return messages;
}

export function createChatCompletionsProvider({
  baseUrl,
  model,
  apiKeyEnv = 'LIGULE_API_KEY',
  capabilities,
  retry = DEFAULT_RETRY,
}: ChatCompletionsProviderOptions = {}): ModelProvider {
  // 地址按给出的那一份用：这一种形状的约定是 base_url 已经含 /v1（OpenAI 自己的 base_url 就是
  // `https://api.openai.com/v1`），而 DeepSeek 那一种把 base_url 写作 `https://api.deepseek.com`、
  // 路径直接是 /chat/completions（2026-10-02 从其文档「首次调用 API」一节读到）。补一个 /v1 会打断后一种。
  const root = apiRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = chatCompletionsCapabilities(capabilities);

  async function* stream(request: ModelRequest, { signal }: { readonly signal?: AbortSignal | null } = {}): AsyncGenerator<ProviderEvent> {
    const response = await open(`${root}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'authorization': `Bearer ${await readCredential(apiKeyEnv)}`,
      },
      body: JSON.stringify({
        model,
        messages: toWireMessages(request.messages ?? [], request.system ?? ''),
        stream: effective.streaming,
        // 流式也要最后那一条用量（压缩的压力线要看端点真实报回的那一份）：这一格由能力声明决定，
        // 不认它的代理把 model.capabilities 里的 streamUsage 降成 false，两条线退回本地估算。
        ...(effective.streaming && effective.streamUsage ? { stream_options: { include_usage: true } } : {}),
        max_tokens: effective.maxOutputTokens,
        parallel_tool_calls: effective.parallelToolCalls,
        ...(request.tools?.length === 0 || request.tools === undefined ? {} : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
      }),
    }, retry);
    if (response.body === null) throw new KernelError('provider_stream_missing');

    // 一次工具调用的参数按 index 分片到达，中间没有「这一块结束了」那一种事件，
    // 所以全部攒到流收尾再交出去；循环本来也是在流结束后才用这些调用（D20）。
    const calls = new Map<number, StreamToolCall>();
    let usage: JsonRecord | undefined;
    for await (const rawChunk of parseSse(response.body)) {
      const chunk = asRecord(rawChunk, 'a stream chunk is not an object');
      // 普通分片的 usage 可以为 null；只有实际用量对象进入累计结果。
      if (chunk.usage !== undefined && chunk.usage !== null) usage = asRecord(chunk.usage, 'a stream usage value is not an object');
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const rawChoice of choices) {
        const choice = asRecord(rawChoice, 'a stream choice is not an object');
        const delta = asRecord(choice.delta ?? {}, 'a stream delta is not an object');
        if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content };
        // 推理段在这一种形状里是增量上的一个平行字段（D32），DeepSeek 那一类用的名字是 reasoning_content。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning', text: delta.reasoning_content };
        }
        const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawFragment of fragments) {
          const fragment = asRecord(rawFragment, 'a tool call fragment is not an object');
          const index = Number.isInteger(fragment.index) ? Number(fragment.index) : calls.size;
          const call = calls.get(index) ?? { name: '', json: '' };
          if (typeof fragment.id === 'string') call.id = fragment.id;
          const functionValue = typeof fragment.function === 'object' && fragment.function !== null
            ? asRecord(fragment.function, 'a tool call function is not an object')
            : {};
          if (typeof functionValue.name === 'string') call.name += functionValue.name;
          if (typeof functionValue.arguments === 'string') call.json += functionValue.arguments;
          calls.set(index, call);
        }
      }
    }
    for (const [, call] of [...calls.entries()].sort((left, right) => left[0] - right[0])) {
      if (call.id === undefined || call.name === '') {
        throw new KernelError('provider_stream_invalid', { detail: 'a tool call without an id or a name' });
      }
      yield { type: 'tool-call', id: call.id, name: call.name, args: parseArgs(call.json) };
    }
    // 用量在那一条没有 choices 的收尾分片上；没有报回来时不交这一条，压缩的那一条判据宁可只用本地估算。
    if (usage !== undefined) {
      yield { type: 'usage', input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) };
    }
  }

  const provider = {
    name: 'chat-completions',
    model,
    capabilities: effective,
    stream,
    // 换模型是显式的一步：交回一个新的提供方，不在失败时悄悄改用别的模型（D13）。
    withModel(next: string) {
      return createChatCompletionsProvider({ baseUrl, model: next, apiKeyEnv, capabilities, retry });
    },
  };
  return Object.freeze(provider);
}

// 参数解析不了当场报出去（D13）。空片段是一次没有参数的调用，不是缺参数。
function parseArgs(json: string): unknown {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { cause: error, detail: json });
  }
}
