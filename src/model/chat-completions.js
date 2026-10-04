// Chat Completions 兼容那一种线上形状（D31）：OpenAI 的 `POST <base>/chat/completions`，鉴权头 `Authorization: Bearer`。
// 与 messages.js 共用 model/http.js 那一层：地址、重试、SSE 帧与凭据都不在这里重复。
// 两处的实际差别只有三件：请求体的字段形状、工具调用参数的载体（一边是内容块里的 JSON 片段，一边是按下标分片的字符串），
// 以及工具结果是一条独立的 `role:"tool"` 消息而不是并进 user 那一条。
import { KernelError } from '../kernel/error.js';
import { apiRoot, assertAllAnswered, DEFAULT_RETRY, open, parseSse, readCredential, resolveCapabilities, resultText } from './http.js';

export const CHAT_COMPLETIONS_CAPABILITIES = Object.freeze({
  streaming: true,
  parallelToolCalls: true,
  maxOutputTokens: 8192,
});

export function chatCompletionsCapabilities(requested = {}) {
  return resolveCapabilities(CHAT_COMPLETIONS_CAPABILITIES, requested);
}

function toWireMessages(view, system) {
  // 系统段在这一种形状里是消息列表的第一条，不是请求体上的一个字段。
  const messages = system === '' ? [] : [{ role: 'system', content: system }];
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
} = {}) {
  // 地址按给出的那一份用：这一种形状的约定是 base_url 已经含 /v1（OpenAI 自己的 base_url 就是
  // `https://api.openai.com/v1`），而 DeepSeek 那一种把 base_url 写作 `https://api.deepseek.com`、
  // 路径直接是 /chat/completions（2026-10-02 从其文档「首次调用 API」一节读到）。补一个 /v1 会打断后一种。
  const root = apiRoot(baseUrl);
  if (typeof model !== 'string' || model === '') throw new KernelError('provider_model_required');
  const effective = chatCompletionsCapabilities(capabilities);

  async function* stream(request, { signal } = {}) {
    const response = await open(`${root}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'authorization': `Bearer ${readCredential(apiKeyEnv)}`,
      },
      body: JSON.stringify({
        model,
        messages: toWireMessages(request.messages ?? [], request.system ?? ''),
        stream: effective.streaming,
        // 流式也要最后那一条用量（压缩的压力线要看端点真实报回的那一份）：不写这一格，很多兼容端点就不交 usage。
        ...(effective.streaming ? { stream_options: { include_usage: true } } : {}),
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
    const calls = new Map();
    let usage;
    for await (const chunk of parseSse(response.body)) {
      if (chunk.usage !== undefined) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content };
        // 推理段在这一种形状里是增量上的一个平行字段（D32），DeepSeek 那一类用的名字是 reasoning_content。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning', text: delta.reasoning_content };
        }
        for (const fragment of delta.tool_calls ?? []) {
          const index = Number.isInteger(fragment.index) ? fragment.index : calls.size;
          const call = calls.get(index) ?? { id: undefined, name: '', json: '' };
          if (fragment.id !== undefined) call.id = fragment.id;
          if (typeof fragment.function?.name === 'string') call.name += fragment.function.name;
          if (typeof fragment.function?.arguments === 'string') call.json += fragment.function.arguments;
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
    withModel(next) {
      return createChatCompletionsProvider({ baseUrl, model: next, apiKeyEnv, capabilities, retry });
    },
  };
  return Object.freeze(provider);
}

// 参数解析不了当场报出去（D13）。空片段是一次没有参数的调用，不是缺参数。
function parseArgs(json) {
  if (json === '') return {};
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new KernelError('provider_tool_args_invalid', { cause: error, detail: json });
  }
}
