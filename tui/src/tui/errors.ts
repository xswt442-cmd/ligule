import type { Locale } from '@ligule/core/kernel/locale.js';
import type { ProviderDiagnostic, ProviderDiagnosticCategory } from '@ligule/core/kernel/error.js';

const DIAGNOSTIC_CATEGORIES: Readonly<Record<ProviderDiagnosticCategory, readonly [string, string]>> = {
  authentication: ['身份认证', 'authentication'],
  rate_limit: ['请求限流', 'rate limit'],
  client: ['客户端请求', 'client request'],
  server: ['服务端故障', 'server failure'],
  http: ['HTTP 响应', 'HTTP response'],
  transport: ['传输故障', 'transport failure'],
  stream: ['响应流中断', 'response stream interrupted'],
  invalid_response: ['响应格式无效', 'invalid response'],
  cancelled: ['请求已取消', 'request cancelled'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function providerDiagnosticText(value: unknown, locale: Locale = 'zh'): string | undefined {
  if (!isRecord(value)) return undefined;
  const categories = Object.keys(DIAGNOSTIC_CATEGORIES);
  if (typeof value.category !== 'string' || !categories.includes(value.category)
    || !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 1
    || typeof value.responseReceived !== 'boolean' || typeof value.streamReceived !== 'boolean'
    || typeof value.recoverable !== 'boolean'
    || (value.status !== undefined && (!Number.isSafeInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599))) {
    return undefined;
  }
  const diagnostic = value as unknown as ProviderDiagnostic;
  const category = DIAGNOSTIC_CATEGORIES[diagnostic.category][locale === 'zh' ? 0 : 1];
  const status = diagnostic.status === undefined ? (locale === 'zh' ? 'HTTP 状态未知' : 'HTTP status unknown') : `HTTP ${diagnostic.status}`;
  const attempts = locale === 'zh' ? `尝试 ${diagnostic.attempts} 次` : `${diagnostic.attempts} attempts`;
  const response = diagnostic.responseReceived ? (locale === 'zh' ? '收到响应' : 'response received') : (locale === 'zh' ? '未收到响应' : 'no response');
  const stream = diagnostic.streamReceived ? (locale === 'zh' ? '收到响应流' : 'stream data received') : (locale === 'zh' ? '未收到响应流' : 'no stream data');
  const recovery = diagnostic.recoverable ? (locale === 'zh' ? '可恢复' : 'recoverable') : (locale === 'zh' ? '不可安全重试' : 'not safe to retry');
  return `${status} · ${category} · ${attempts} · ${response} · ${stream} · ${recovery}`;
}

const FAILURE_TEXT: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  provider_output_exhausted: {
    zh: '模型达到输出预算，回答未完整完成。先检查已有结果，再调整 model.outputTokens 或缩小任务。',
    en: 'The model reached its output budget before completing. Inspect existing results, then adjust model.outputTokens or reduce the task.',
  },
  provider_empty_response: {
    zh: '模型没有返回有效正文或工具调用。查看记录后决定是否重新提交。',
    en: 'The model returned no useful text or tool calls. Inspect the record before deciding whether to submit again.',
  },
  provider_stream_incomplete: {
    zh: '模型响应缺少完整结束标记或分片。检查接口兼容性，并先查看已有结果。',
    en: 'The model response lacks a complete terminator or frame. Check API compatibility and inspect existing results first.',
  },
  provider_stream_interrupted: {
    zh: '模型响应在读取途中中断。工具不会自动重做，请先查看已有结果。',
    en: 'Reading the model response was interrupted. Tools are not replayed automatically; inspect existing results first.',
  },
  provider_finish_reason_invalid: {
    zh: '模型服务返回了不支持的结束原因。请检查接口类型与兼容性。',
    en: 'The model service returned an unsupported finish reason. Check its API type and compatibility.',
  },
  provider_tool_call_invalid: {
    zh: '模型返回的工具调用缺少有效标识或名称，或标识重复。请检查模型服务兼容性。',
    en: 'The model returned a tool call with a missing or duplicate identity, or missing name. Check model service compatibility.',
  },
  provider_output_budget_invalid: {
    zh: '输出预算无效。请把 model.outputTokens 设置为有效范围内的正整数。',
    en: 'The output budget is invalid. Set model.outputTokens to a positive integer within the supported range.',
  },
  provider_output_budget_unsupported: {
    zh: '输出预算超过当前模型或配置允许的上限。请降低 model.outputTokens 或选择支持该预算的服务。',
    en: 'The output budget exceeds this model or configuration limit. Lower model.outputTokens or select a service that supports it.',
  },
  provider_credential_missing: {
    zh: '模型凭据尚未设置。用 /credentials 查看凭据引用，并通过环境变量或桌面模型服务保存凭据。',
    en: 'The model credential is not set. Use /credentials to view its reference, then set it in the environment or save it through Desktop model services.',
  },
  credential_store_unavailable: {
    zh: '系统凭据存储当前不可用。检查系统凭据服务，或改用环境变量提供凭据。',
    en: 'The system credential store is unavailable. Check the OS credential service or provide the credential through an environment variable.',
  },
  host_model_config_missing: {
    zh: '尚未配置模型。用 /model 查看可用模型，或在桌面配置模型服务。',
    en: 'No model is configured. Use /model to view available models or configure a model service in Desktop.',
  },
  provider_api_form_required: {
    zh: '尚未选择模型服务接口类型。检查模型服务配置并选择支持的接口类型。',
    en: 'The model service API type is missing. Check the model service settings and choose a supported API type.',
  },
  provider_base_url_required: {
    zh: '尚未配置模型服务地址。检查模型服务配置中的服务地址。',
    en: 'The model service address is missing. Check the address in the model service settings.',
  },
  provider_model_required: {
    zh: '尚未配置模型名称。用 /model 选择可用模型，或检查桌面模型服务配置。',
    en: 'The model name is missing. Use /model to select an available model or check the Desktop model service settings.',
  },
  model_service_not_found: {
    zh: '所选模型服务不存在。用 /model 查看可用服务并重新选择。',
    en: 'The selected model service was not found. Use /model to view available services and select one again.',
  },
  model_not_available: {
    zh: '所选模型不在该服务的可用列表中。用 /model 查看并选择该服务列出的模型。',
    en: 'The selected model is not available from this service. Use /model to choose a model listed for that service.',
  },
  provider_transport_failed: {
    zh: '无法连接模型服务。检查服务地址和网络连接后重试。',
    en: 'Could not connect to the model service. Check the service address and network connection, then retry.',
  },
  provider_timeout: {
    zh: '模型请求超过时限。先检查会话记录与已完成的工具结果，再决定是否重新发送。',
    en: 'The model request exceeded its time limit. Inspect the session record and completed tool results before deciding whether to send again.',
  },
  provider_http_error: {
    zh: '模型服务未能完成请求。检查服务地址、模型配置和网络连接后重试。',
    en: 'The model service could not complete the request. Check the service address, model settings, and network connection, then retry.',
  },
  provider_stream_invalid: {
    zh: '无法解析模型服务的响应。检查接口类型以及服务是否返回兼容的响应格式。',
    en: 'The model service response could not be parsed. Check the API type and whether the service returns a compatible response format.',
  },
  provider_tool_args_invalid: {
    zh: '模型返回的工具参数无法解析。检查模型服务是否返回兼容的工具调用格式。',
    en: 'The model returned unreadable tool arguments. Check whether the model service returns a compatible tool-call format.',
  },
};

export function runtimeFailureText(code: string, locale: Locale = 'zh'): string | undefined {
  return FAILURE_TEXT[code]?.[locale];
}
