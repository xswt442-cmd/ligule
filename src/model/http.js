// 模型接口的共用一层（D13、D31）：地址校验、重试边界、SSE 帧解析与凭据读取。
// 两种线上形状（Messages 兼容与 Chat Completions 兼容）共用这一份；差别只在各自的适配器里。
import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from '../kernel/error.js';

// 重试边界照 Codex 的 RetryPolicy 那三条可重试类别：429、5xx、传输。请求构造错误与响应内容不可解析永不重试。
// 默认值是本项目自定的起点，配置层可以覆盖。
export const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  retry429: true,
  retry5xx: true,
  retryTransport: true,
});

// 错误详情里带的响应正文长度上限：网关出错时可能交回一整页 HTML，说明留一段就够。
const DETAIL_BYTES = 500;

// 提供方声明的能力上限是配置不能突破的那一条线：布尔项只能关不能开，数值项取更小的那个。
export function resolveCapabilities(declared, requested = {}) {
  const effective = { ...declared };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(declared, key)) throw new KernelError('provider_capability_unknown', { detail: key });
    if (typeof value !== typeof declared[key]) {
      throw new KernelError('provider_capability_invalid', { detail: `${key} must be a ${typeof declared[key]}` });
    }
    effective[key] = typeof declared[key] === 'boolean' ? value && declared[key] : Math.min(value, declared[key]);
  }
  return Object.freeze(effective);
}

// 服务地址必须是 HTTP(S) 的根：不带凭据、查询与片段，否则同一份配置在不同宿主下会打到不同地方。
// 路径末尾的 /v1 不重复补，两种形状的端点都挂在它下面。
export function apiRoot(baseUrl) {
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

// 凭据在发请求时才读：进程运行期间换过密钥不必重建提供方，配置快照里也始终没有它。
export function readCredential(apiKeyEnv) {
  const apiKey = process.env[apiKeyEnv];
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new KernelError('provider_credential_missing', { detail: apiKeyEnv });
  }
  return apiKey;
}

function backoffMs(baseDelayMs, attempt) {
  return baseDelayMs * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2);
}

// 重试只覆盖建立响应这一步：流已经开始往外吐内容之后再重试，会把同一段内容重复交给模型。
export async function open(url, init, retry) {
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
// 终止符 `[DONE]` 是 Chat Completions 那一种形状的收尾，它不是一段 JSON，所以在这里跳过。
export async function* parseSse(body) {
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

// 助手那一轮里每个调用都得有对应的结果，缺一条端点就把整份请求拒掉，而且从外面的报错看不出缺在哪一条。
export function assertAllAnswered(view) {
  const answered = new Set(view.filter((entry) => entry.role === 'tool').map((entry) => entry.id));
  for (const entry of view) {
    for (const call of entry.toolCalls ?? []) {
      if (!answered.has(call.id)) {
        throw new KernelError('provider_unanswered_call', { detail: `${call.name} (${call.id})` });
      }
    }
  }
}

// 工具交回的结果形状各家都要一段文本：不是字符串的那一份按 JSON 序列化。
export function resultText(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
