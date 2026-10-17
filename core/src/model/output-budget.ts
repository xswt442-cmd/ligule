import { KernelError } from '../kernel/error.js';

interface OutputBudget {
  readonly baseUrl: string;
  readonly model: string;
  readonly requested?: unknown;
  readonly defaultTokens: number;
  readonly configuredLimit?: number;
  readonly contextLimit?: unknown;
}

// Official model limits: https://api-docs.deepseek.com/quick_start/pricing/
// Unknown endpoints retain the adapter's conservative limit.
function verifiedLimit(baseUrl: string, model: string): number | undefined {
  const url = new URL(baseUrl);
  if (url.origin !== 'https://api.deepseek.com'
    || !['', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname)
    || !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return undefined;
  return 384000;
}

export function resolveOutputTokens({ baseUrl, model, requested, defaultTokens, configuredLimit, contextLimit }: OutputBudget): number {
  if (requested === undefined) return defaultTokens;
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) {
    throw new KernelError('provider_output_budget_invalid', { detail: 'outputTokens must be a positive safe integer' });
  }
  if (contextLimit !== undefined && (typeof contextLimit !== 'number' || !Number.isSafeInteger(contextLimit) || contextLimit < 1)) {
    throw new KernelError('provider_output_budget_invalid', { detail: 'contextTokens must be a positive safe integer' });
  }
  const ceiling = Math.min(verifiedLimit(baseUrl, model) ?? defaultTokens,
    configuredLimit ?? Infinity, typeof contextLimit === 'number' ? contextLimit : Infinity);
  if (requested > ceiling) {
    throw new KernelError('provider_output_budget_unsupported', { detail: `outputTokens exceeds the effective limit of ${ceiling}` });
  }
  return requested;
}
