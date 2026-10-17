// Chat Completions 兼容那一种线上形状（D31）：OpenAI 的 `POST <base>/chat/completions`，鉴权头 `Authorization: Bearer`。
// 与 messages.ts 共用 model/http.ts 那一层：地址、重试、SSE 帧与凭据都不在这里重复。
// 两处的实际差别只有三件：请求体的字段形状、工具调用参数的载体（一边是内容块里的 JSON 片段，一边是按下标分片的字符串），
// 以及工具结果是一条独立的 `role:"tool"` 消息而不是并进 user 那一条。
import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { resolveOutputTokens } from './output-budget.js';
import {
  apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, readJson, resolveCapabilities, resultText, SSE_DONE,
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
  readonly outputTokens?: unknown;
  readonly contextTokens?: unknown;
  readonly retry?: RetryPolicy;
}

interface ModelProvider {
  readonly requiresCompletion: true;
  readonly name: string;
  readonly model: string;
  readonly capabilities: ChatCompletionsCapabilities;
  readonly outputTokens: number;
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

const WIRE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const WIRE_TOOL_ALIAS_PREFIX = 'ligule_';

interface ToolNameMapping {
  encode(name: string): string;
  decode(name: string): string;
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

function toolNameMapping(request: ModelRequest): ToolNameMapping {
  const names = new Set<string>();
  for (const tool of request.tools ?? []) names.add(tool.name);
  for (const message of request.messages ?? []) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) names.add(call.name);
    }
  }

  const encoded = new Set([...names].filter((name) => !WIRE_TOOL_NAME.test(name)));
  const aliasOf = (name: string) => `${WIRE_TOOL_ALIAS_PREFIX}${createHash('sha256').update(name).digest('hex').slice(0, 48)}`;
  // An invalid name's alias can equal a separate valid tool name. Encode that original name too,
  // repeating until the alias namespace no longer overlaps any unencoded original name.
  while (true) {
    const aliases = new Map<string, string>();
    for (const name of encoded) {
      const alias = aliasOf(name);
      const previous = aliases.get(alias);
      if (previous !== undefined && previous !== name) {
        throw new KernelError('provider_tool_name_collision', { detail: `${previous} and ${name} share a wire alias` });
      }
      aliases.set(alias, name);
    }
    const collisions = [...names].filter((name) => !encoded.has(name) && aliases.has(name));
    if (collisions.length === 0) break;
    for (const name of collisions) encoded.add(name);
  }

  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of names) {
    const wireName = encoded.has(name) ? aliasOf(name) : name;
    const previous = fromWire.get(wireName);
    if (previous !== undefined && previous !== name) {
      throw new KernelError('provider_tool_name_collision', { detail: `${previous} and ${name} share wire name ${wireName}` });
    }
    toWire.set(name, wireName);
    fromWire.set(wireName, name);
  }
  return {
    encode: (name) => toWire.get(name) ?? name,
    // Unknown model output remains unknown so the Host kernel can reject it by its original name.
    decode: (name) => fromWire.get(name) ?? name,
  };
}

function toWireMessages(view: readonly ModelMessage[], system: string, toolNames: ToolNameMapping): ChatWireMessage[] {
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
            function: { name: toolNames.encode(call.name), arguments: JSON.stringify(call.args ?? {}) },
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
  outputTokens,
  contextTokens,
  retry = DEFAULT_RETRY,
}: ChatCompletionsProviderOptions = {}): ModelProvider {
  // 地址按给出的那一份用：这一种形状的约定是 base_url 已经含 /v1（OpenAI 自己的 base_url 就是
  // `https://api.openai.com/v1`），而 DeepSeek 那一种把 base_url 写作 `https://api.deepseek.com`、
  // 路径直接是 /chat/completions（2026-10-02 从其文档「首次调用 API」一节读到）。补一个 /v1 会打断后一种。
  const root = apiRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = chatCompletionsCapabilities(capabilities);
  const budget = resolveOutputTokens({ baseUrl: root, model, requested: outputTokens,
    defaultTokens: effective.maxOutputTokens,
    configuredLimit: capabilities?.maxOutputTokens === undefined ? undefined : effective.maxOutputTokens,
    contextLimit: contextTokens });

  async function* stream(request: ModelRequest, { signal }: { readonly signal?: AbortSignal | null } = {}): AsyncGenerator<ProviderEvent> {
    const toolNames = toolNameMapping(request);
    const response = await open(`${root}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': effective.streaming ? 'text/event-stream' : 'application/json',
        'authorization': `Bearer ${await readCredential(apiKeyEnv)}`,
      },
      body: JSON.stringify({
        model,
        messages: toWireMessages(request.messages ?? [], request.system ?? '', toolNames),
        stream: effective.streaming,
        // 流式也要最后那一条用量（压缩的压力线要看端点真实报回的那一份）：这一格由能力声明决定，
        // 不认它的代理把 model.capabilities 里的 streamUsage 降成 false，两条线退回本地估算。
        ...(effective.streaming && effective.streamUsage ? { stream_options: { include_usage: true } } : {}),
        max_tokens: budget,
        parallel_tool_calls: effective.parallelToolCalls,
        ...(request.tools?.length === 0 || request.tools === undefined ? {} : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: toolNames.encode(tool.name), description: tool.description, parameters: tool.parameters },
          })),
        }),
      }),
    }, retry);
    if (response.body === null) throw new KernelError('provider_stream_missing');

    if (!effective.streaming) {
      const completion = asRecord(await readJson(response, signal), 'a completion response is not an object');
      if (!Array.isArray(completion.choices) || completion.choices.length !== 1) {
        throw new KernelError('provider_stream_incomplete');
      }
      const choice = asRecord(completion.choices[0], 'a completion choice is not an object');
      const message = asRecord(choice.message, 'a completion message is not an object');
      if (message.role !== undefined && message.role !== 'assistant') throw new KernelError('provider_stream_invalid', { detail: 'completion message is not an assistant message' });
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw new KernelError('provider_stream_invalid', { detail: 'completion content is not text' });
      }
      const text = typeof message.content === 'string' ? message.content : '';
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
      if (text !== '') yield { type: 'text', text };
      if (reasoning !== '') yield { type: 'reasoning', text: reasoning };
      const finishReason = choice.finish_reason;
      const reason = finishReason === 'stop'
        ? 'stop'
        : finishReason === 'tool_calls'
          ? 'tool_calls'
          : finishReason === 'length'
            ? 'length'
            : undefined;
      if (reason === undefined) {
        if (typeof finishReason !== 'string') throw new KernelError('provider_stream_incomplete');
        throw new KernelError('provider_finish_reason_invalid');
      }
      if (reason !== 'length') {
        const calls = message.tool_calls === undefined || message.tool_calls === null
          ? []
          : Array.isArray(message.tool_calls)
            ? message.tool_calls
            : (() => { throw new KernelError('provider_stream_invalid', { detail: 'completion tool_calls is not an array' }); })();
        const callIds = new Set<string>();
        const parsed = calls.map((rawCall) => {
          const call = asRecord(rawCall, 'a completion tool call is not an object');
          const id = typeof call.id === 'string' ? call.id : '';
          if (id === '' || callIds.has(id)) throw new KernelError('provider_tool_call_invalid');
          callIds.add(id);
          const functionValue = asRecord(call.function, 'a completion tool function is not an object');
          const name = typeof functionValue.name === 'string' ? functionValue.name : '';
          if (name === '') throw new KernelError('provider_tool_call_invalid');
          const args = functionValue.arguments === undefined ? '' : functionValue.arguments;
          if (typeof args !== 'string') throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
          return { type: 'tool-call' as const, id, name: toolNames.decode(name), args: parseArgs(args) };
        });
        for (const call of parsed) yield call;
      }
      const usage = completion.usage === undefined || completion.usage === null
        ? undefined
        : asRecord(completion.usage, 'completion usage is not an object');
      if (usage !== undefined) {
        yield { type: 'usage', input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) };
      }
      yield { type: 'finish', reason };
      return;
    }

    // 一次工具调用的参数按 index 分片到达，中间没有「这一块结束了」那一种事件，
    // 所以全部攒到流收尾再交出去；循环本来也是在流结束后才用这些调用（D20）。
    const calls = new Map<number, StreamToolCall>();
    let usage: JsonRecord | undefined;
    let finishReason: unknown;
    let done = false;
    for await (const rawChunk of parseSse(response.body, { includeDone: true })) {
      if (rawChunk === SSE_DONE) {
        if (done) throw new KernelError('provider_stream_invalid', { detail: 'duplicate stream terminator' });
        done = true;
        continue;
      }
      if (done) throw new KernelError('provider_stream_invalid', { detail: 'data follows the stream terminator' });
      const chunk = asRecord(rawChunk, 'a stream chunk is not an object');
      // 普通分片的 usage 可以为 null；只有实际用量对象进入累计结果。
      if (chunk.usage !== undefined && chunk.usage !== null) usage = asRecord(chunk.usage, 'a stream usage value is not an object');
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const rawChoice of choices) {
        const choice = asRecord(rawChoice, 'a stream choice is not an object');
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
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
    if (!done || typeof finishReason !== 'string') throw new KernelError('provider_stream_incomplete');
    const reason = finishReason === 'stop'
      ? 'stop'
      : finishReason === 'tool_calls'
        ? 'tool_calls'
        : finishReason === 'length'
          ? 'length'
          : undefined;
    if (reason === undefined) throw new KernelError('provider_finish_reason_invalid');
    if (reason !== 'length') {
      const callIds = new Set<string>();
      const parsed = [...calls.entries()].sort((left, right) => left[0] - right[0]).map(([, call]) => {
        if (call.id === undefined || call.id === '' || call.name === '' || callIds.has(call.id)) {
          throw new KernelError('provider_tool_call_invalid');
        }
        callIds.add(call.id);
        return { type: 'tool-call' as const, id: call.id, name: toolNames.decode(call.name), args: parseArgs(call.json) };
      });
      for (const call of parsed) yield call;
    }
    // 用量在那一条没有 choices 的收尾分片上；没有报回来时不交这一条，压缩的那一条判据宁可只用本地估算。
    if (usage !== undefined) {
      yield { type: 'usage', input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0) };
    }
    yield { type: 'finish', reason };
  }

  const provider = {
    name: 'chat-completions',
    requiresCompletion: true as const,
    model,
    capabilities: effective,
    outputTokens: budget,
    stream,
    // 换模型是显式的一步：交回一个新的提供方，不在失败时悄悄改用别的模型（D13）。
    withModel(next: string) {
      return createChatCompletionsProvider({ baseUrl, model: next, apiKeyEnv, capabilities, outputTokens, contextTokens, retry });
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
    throw new KernelError('provider_tool_args_invalid', { detail: 'tool arguments are not valid JSON' });
  }
}
