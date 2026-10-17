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

// Official model limits: https://api-docs.deepseek.com/quick_start/pricing/
// Unknown endpoints retain the adapter's conservative limit unless a service model explicitly declares its output ceiling.
// Such a declaration does not override a verified model limit, a configured lower capability, or the context window.
function verifiedLimit(baseUrl: string, model: string): number | undefined {
  const url = new URL(baseUrl);
  if (url.origin !== 'https://api.deepseek.com'
    || !['', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname)
    || !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return undefined;
  return 384000;
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
  const ceiling = Math.min(verifiedLimit(baseUrl, model) ?? declaredLimit ?? defaultTokens,
    configuredLimit ?? Infinity, typeof contextLimit === 'number' ? contextLimit : Infinity);
  const effectiveRequested = requested ?? defaultTokens;
  if (declaredLimit !== undefined && effectiveRequested > declaredLimit) {
    throw new KernelError('provider_output_budget_unsupported', { detail: `outputTokens exceeds the declared limit of ${declaredLimit}` });
  }
  if (effectiveRequested > ceiling) {
    throw new KernelError('provider_output_budget_unsupported', { detail: `outputTokens exceeds the effective limit of ${ceiling}` });
  }
  return effectiveRequested;
}
