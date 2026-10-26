import { KernelError } from '../kernel/error.js';
import type { ConfigSnapshot } from '../kernel/config.js';
import type { ModelProvider } from '../kernel/loop.js';
import { resolveModel } from '../kernel/model-services.js';
import { createMessagesProvider } from '../model/messages.js';
import { createChatCompletionsProvider } from '../model/chat-completions.js';
import { DEFAULT_RETRY, type ProviderCapabilities, type RetryPolicy } from '../model/http.js';
import { checkedThinkingEffort, thinkingCapabilityOf, type DeepSeekThinkingEffort, type ThinkingCapability } from '../model/thinking.js';

export interface HostGenerationOptions {
  readonly outputTokens?: number;
  readonly thinkingEffort?: DeepSeekThinkingEffort;
}

export interface HostProvider extends ModelProvider {
  readonly name: string;
  readonly model: string | null;
  readonly pending?: true;
  readonly capabilities?: ProviderCapabilities;
  readonly outputTokens?: number;
  readonly contextTokens?: number;
  readonly thinkingCapability?: ThinkingCapability;
  readonly thinkingEffort?: DeepSeekThinkingEffort;
  withModel(model: string): HostProvider;
  withGeneration(options: HostGenerationOptions): HostProvider;
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

/** 选择配置声明的接口格式和能力；凭据在发送请求时解析。 */
export function providerFromConfig(config: ConfigSnapshot, generation: HostGenerationOptions = {}): HostProvider {
  if (!isRecord(config.model)) throw new KernelError('host_model_config_missing', { detail: 'config.model.baseURL and config.model.model' });
  const configuredModel = config.model;
  const model = resolveModel(configuredModel);
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
    ...(typeof model.serviceImageInput === 'boolean' ? { imageInput: model.serviceImageInput } : {}),
    ...(generation.outputTokens === undefined
      ? (model.outputTokens === undefined ? {} : { outputTokens: model.outputTokens })
      : { outputTokens: generation.outputTokens }),
    ...(generation.thinkingEffort === undefined ? {} : { thinkingEffort: generation.thinkingEffort }),
    ...(model.serviceOutputLimit === true ? { declaredOutputLimit: model.outputTokens } : {}),
    ...(model.serviceContextTokens !== undefined
      ? { contextTokens: model.serviceContextTokens }
      : isRecord(config.limits) && config.limits.contextTokens !== undefined ? { contextTokens: config.limits.contextTokens } : {}),
    retry: retryOf(model),
  };
  const thinkingCapability = thinkingCapabilityOf(api, model.baseURL, model.model);
  if (generation.thinkingEffort !== undefined) checkedThinkingEffort(generation.thinkingEffort, thinkingCapability);
  const contextTokens = typeof model.serviceContextTokens === 'number'
    ? model.serviceContextTokens
    : isRecord(config.limits) && typeof config.limits.contextTokens === 'number' ? config.limits.contextTokens : undefined;
  const provider = api === 'messages' ? createMessagesProvider(options) : createChatCompletionsProvider(options);
  const serviceId = model.serviceId === undefined || model.serviceId === 'legacy' ? 'legacy' : model.serviceId;
  const selectedConfig = {
    ...configuredModel,
    ...(serviceId === 'legacy' ? { model: model.model } : {}),
    selection: { provider: serviceId, model: model.model },
  };
  return Object.freeze({
    ...provider,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(thinkingCapability === undefined ? {} : { thinkingCapability }),
    ...(generation.thinkingEffort === undefined ? {} : { thinkingEffort: generation.thinkingEffort }),
    withModel(next: string) {
      return providerFromConfig({ ...config, model: { ...selectedConfig, selection: { provider: serviceId, model: next } } }, generation);
    },
    withGeneration(next: HostGenerationOptions) { return providerFromConfig({ ...config, model: selectedConfig }, next); },
  });
}

function pendingProvider(error: KernelError): HostProvider {
  const refuse = () => { throw error; };
  return {
    name: 'pending', model: null, pending: true, withModel: refuse, withGeneration: refuse,
    stream: async function* () { refuse(); },
  };
}

/** 未配置模型服务时 Host 仍可处理配置请求；开始轮次时明确返回配置错误。 */
export function hostProviderFromConfig(config: ConfigSnapshot, generation: HostGenerationOptions = {}): HostProvider {
  try {
    return providerFromConfig(config, generation);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (!['host_model_config_missing', 'provider_api_form_required', 'provider_base_url_required', 'provider_model_required', 'model_service_not_found', 'model_not_available'].includes(code ?? '')) throw error;
    if (!(error instanceof KernelError)) throw error;
    return pendingProvider(error);
  }
}
