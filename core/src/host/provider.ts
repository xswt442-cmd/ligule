import { KernelError } from '../kernel/error.js';
import type { ConfigSnapshot } from '../kernel/config.js';
import type { ModelProvider } from '../kernel/loop.js';
import { resolveModel } from '../kernel/model-services.js';
import { createMessagesProvider } from '../model/messages.js';
import { createChatCompletionsProvider } from '../model/chat-completions.js';
import { DEFAULT_RETRY, type ProviderCapabilities, type RetryPolicy } from '../model/http.js';

export interface HostProvider extends ModelProvider {
  readonly name: string;
  readonly model: string | null;
  readonly pending?: true;
  readonly capabilities?: ProviderCapabilities;
  withModel(model: string): HostProvider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryOf(model: Record<string, unknown>): RetryPolicy {
  if (model.retry !== undefined && !isRecord(model.retry)) {
    throw new KernelError('host_retry_invalid', { detail: 'retry must be an object' });
  }
  const retry = { ...DEFAULT_RETRY, ...(isRecord(model.retry) ? model.retry : {}) };
  const positiveInteger = (value: unknown, key: 'maxAttempts' | 'baseDelayMs'): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new KernelError('host_retry_invalid', { detail: `${key} must be an integer of at least 1` });
    }
    return value;
  };
  const boolean = (value: unknown, key: 'retry429' | 'retry5xx' | 'retryTransport'): boolean => {
    if (typeof value !== 'boolean') throw new KernelError('host_retry_invalid', { detail: `${key} must be a boolean` });
    return value;
  };
  return Object.freeze({
    maxAttempts: positiveInteger(retry.maxAttempts, 'maxAttempts'),
    baseDelayMs: positiveInteger(retry.baseDelayMs, 'baseDelayMs'),
    retry429: boolean(retry.retry429, 'retry429'),
    retry5xx: boolean(retry.retry5xx, 'retry5xx'),
    retryTransport: boolean(retry.retryTransport, 'retryTransport'),
  });
}

/** Select the declared wire format and capabilities; credentials resolve at request time. */
export function providerFromConfig(config: ConfigSnapshot): HostProvider {
  if (!isRecord(config.model)) throw new KernelError('host_model_config_missing', { detail: 'config.model.baseURL and config.model.model' });
  const model = resolveModel(config.model);
  const api = model.api;
  if (api !== 'messages' && api !== 'chat-completions') {
    throw new KernelError('provider_api_form_required', { detail: 'model.api must be "messages" or "chat-completions"' });
  }
  const apiKeyEnv = model.apiKeyEnv;
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') {
    throw new KernelError('provider_credential_missing', { detail: 'model.apiKeyEnv must be a string' });
  }
  const capabilities = model.capabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) {
    throw new KernelError('provider_capability_invalid', { detail: 'model.capabilities must be a table' });
  }
  const options = {
    baseUrl: model.baseURL,
    model: model.model,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(capabilities === undefined ? {} : { capabilities }),
    retry: retryOf(model),
  };
  if (api === 'messages') return createMessagesProvider(options);
  return createChatCompletionsProvider(options);
}

function pendingProvider(error: KernelError): HostProvider {
  const refuse = () => { throw error; };
  return { name: 'pending', model: null, pending: true, withModel: refuse, stream: async function* () { refuse(); } };
}

/** A Host without model settings still accepts configuration requests; runs fail explicitly. */
export function hostProviderFromConfig(config: ConfigSnapshot): HostProvider {
  try {
    return providerFromConfig(config);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (!['host_model_config_missing', 'provider_api_form_required', 'provider_base_url_required', 'provider_model_required', 'model_service_not_found', 'model_not_available'].includes(code ?? '')) throw error;
    if (!(error instanceof KernelError)) throw error;
    return pendingProvider(error);
  }
}
