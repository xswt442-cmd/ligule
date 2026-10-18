import { KernelError } from '../kernel/error.js';

export const DEEPSEEK_THINKING_EFFORTS = ['none', 'low', 'high', 'max'] as const;
export type DeepSeekThinkingEffort = typeof DEEPSEEK_THINKING_EFFORTS[number];

export interface ThinkingCapability {
  readonly protocol: 'deepseek-chat-completions';
  readonly efforts: readonly DeepSeekThinkingEffort[];
  readonly defaultEffort: 'high';
}

// 只声明官方 DeepSeek Chat Completions 已记录的模型与端点能力。
// API 兼容网关没有可验证的模型协议元数据时，不继承这项能力。
export function thinkingCapabilityOf(api: unknown, baseUrl: unknown, model: unknown): ThinkingCapability | undefined {
  if (api !== 'chat-completions' || typeof baseUrl !== 'string' || typeof model !== 'string') return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.origin !== 'https://api.deepseek.com' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || !['', '/v1'].includes(url.pathname)) return undefined;
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return undefined;
  return Object.freeze({
    protocol: 'deepseek-chat-completions',
    efforts: DEEPSEEK_THINKING_EFFORTS,
    defaultEffort: 'high',
  });
}

export function checkedThinkingEffort(value: unknown, capability: ThinkingCapability | undefined): DeepSeekThinkingEffort {
  if (capability === undefined) throw new KernelError('provider_thinking_unsupported');
  if (typeof value !== 'string' || !capability.efforts.includes(value as DeepSeekThinkingEffort)) {
    throw new KernelError('provider_thinking_effort_invalid', { detail: `effort must be one of: ${capability.efforts.join(', ')}` });
  }
  return value as DeepSeekThinkingEffort;
}
