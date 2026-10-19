import { KernelError } from '../kernel/error.js';

interface OutputBudget {
  readonly baseUrl: string;
  readonly model: string;
  readonly requested?: unknown;
  readonly defaultTokens: number;
  readonly configuredLimit?: number;
  readonly declaredOutputLimit?: unknown;
  readonly contextLimit?: unknown;
}

interface OutputTokenCeiling {
  readonly baseUrl: string;
  readonly model: string;
  readonly defaultTokens: number;
  readonly configuredLimit?: number;
  readonly declaredOutputLimit?: unknown;
}

// 已核实的 DeepSeek 模型上限以其官方文档为准：https://api-docs.deepseek.com/quick_start/pricing/
// 未知服务使用适配器的保守默认值，除非模型配置明确声明更高的输出上限。
// 声明值不能覆盖已核实的模型上限、较低的配置能力或上下文窗口限制。
function verifiedLimit(baseUrl: string, model: string): number | undefined {
  const url = new URL(baseUrl);
  if (url.origin !== 'https://api.deepseek.com'
    || !['', '/', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname)
    || !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return undefined;
  return 393216;
}

export function outputTokenCeiling({ baseUrl, model, defaultTokens, configuredLimit, declaredOutputLimit }: OutputTokenCeiling): number {
  for (const [name, value] of [['defaultTokens', defaultTokens], ['configuredLimit', configuredLimit], ['declaredOutputLimit', declaredOutputLimit]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new KernelError('provider_output_budget_invalid', { detail: `${name} must be a positive safe integer` });
    }
  }
  const declaredLimit = typeof declaredOutputLimit === 'number' ? declaredOutputLimit : undefined;
  return Math.min(verifiedLimit(baseUrl, model) ?? declaredLimit ?? defaultTokens,
    configuredLimit ?? Infinity);
}

export function resolveOutputTokens({ baseUrl, model, requested, defaultTokens, configuredLimit, declaredOutputLimit, contextLimit }: OutputBudget): number {
  if (requested !== undefined && (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1)) {
    throw new KernelError('provider_output_budget_invalid', { detail: 'outputTokens must be a positive safe integer' });
  }
  if (contextLimit !== undefined && (typeof contextLimit !== 'number' || !Number.isSafeInteger(contextLimit) || contextLimit < 1)) {
    throw new KernelError('provider_output_budget_invalid', { detail: 'contextTokens must be a positive safe integer' });
  }
  if (declaredOutputLimit !== undefined && (typeof declaredOutputLimit !== 'number' || !Number.isSafeInteger(declaredOutputLimit) || declaredOutputLimit < 1)) {
    throw new KernelError('provider_output_budget_invalid', { detail: 'declaredOutputLimit must be a positive safe integer' });
  }
  const declaredLimit = typeof declaredOutputLimit === 'number' ? declaredOutputLimit : undefined;
  const ceiling = Math.min(outputTokenCeiling({ baseUrl, model, defaultTokens, configuredLimit, declaredOutputLimit }),
    typeof contextLimit === 'number' ? contextLimit : Infinity);
  const effectiveRequested = requested ?? defaultTokens;
  if (declaredLimit !== undefined && effectiveRequested > declaredLimit) {
    throw new KernelError('provider_output_budget_unsupported', { detail: `outputTokens exceeds the declared limit of ${declaredLimit}` });
  }
  if (effectiveRequested > ceiling) {
    throw new KernelError('provider_output_budget_unsupported', { detail: `outputTokens exceeds the effective limit of ${ceiling}` });
  }
  return effectiveRequested;
}
