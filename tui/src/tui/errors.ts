import type { Locale } from '@ligule/core/kernel/locale.js';

const FAILURE_TEXT: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
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
