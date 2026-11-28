import type { ProviderDiagnostic, ProviderDiagnosticCategory } from './status';

export type TurnFailure = {
  explanation: [string, string];
  action?: 'models';
  diagnostic?: [string, string];
};

const DIAGNOSTIC_LABELS: Readonly<Record<ProviderDiagnosticCategory, readonly [string, string]>> = {
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

function providerDiagnosticText(value: unknown): [string, string] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const diagnostic = value as Partial<ProviderDiagnostic>;
  if (typeof diagnostic.category !== 'string' || !Object.hasOwn(DIAGNOSTIC_LABELS, diagnostic.category)
    || !Number.isSafeInteger(diagnostic.attempts) || (diagnostic.attempts ?? 0) < 1
    || typeof diagnostic.responseReceived !== 'boolean' || typeof diagnostic.streamReceived !== 'boolean'
    || typeof diagnostic.recoverable !== 'boolean'
    || (diagnostic.status !== undefined && (!Number.isSafeInteger(diagnostic.status) || diagnostic.status < 100 || diagnostic.status > 599))) {
    return undefined;
  }
  const category = DIAGNOSTIC_LABELS[diagnostic.category as ProviderDiagnosticCategory];
  const status = diagnostic.status === undefined ? ['HTTP 状态未知', 'HTTP status unknown'] : [`HTTP ${diagnostic.status}`, `HTTP ${diagnostic.status}`];
  const attempts = [`尝试 ${diagnostic.attempts} 次`, `${diagnostic.attempts} attempts`];
  const response = diagnostic.responseReceived ? ['收到响应', 'response received'] : ['未收到响应', 'no response'];
  const stream = diagnostic.streamReceived ? ['收到响应流', 'stream data received'] : ['未收到响应流', 'no stream data'];
  const recovery = diagnostic.recoverable ? ['可恢复', 'recoverable'] : ['不可安全重试', 'not safe to retry'];
  return [
    [status[0], category[0], attempts[0], response[0], stream[0], recovery[0]].join(' · '),
    [status[1], category[1], attempts[1], response[1], stream[1], recovery[1]].join(' · '),
  ];
}

// 失败行同样用稳定错误码解释原因：已知码用上表，未知但明显是传输/HTTP 层的码补一句人话，原始信息留给详情。
export type FailureExplanation = { explanation: [string, string]; original: boolean };

export function failureExplanation(code: string, detail?: string): FailureExplanation {
  const known = turnFailure(code);
  const status = typeof detail === 'string' ? /HTTP\s+(\d{3})/iu.exec(detail)?.[1] : undefined;
  if (code !== '' && /http_error$/iu.test(code)) {
    return {
      explanation: status === undefined
        ? ['模型服务返回错误。请检查密钥、模型访问权限及服务状态。', 'The model service returned an error. Check the API key, model access, and service status.']
        : [`模型服务返回 HTTP ${status}。请检查密钥、模型访问权限及服务状态。`, `The model service returned HTTP ${status}. Check the API key, model access, and service status.`],
      original: true,
    };
  }
  if (known.explanation[0].startsWith('本轮未能完成') || known.explanation[1].startsWith('The turn could not complete')) {
    return { explanation: known.explanation, original: true };
  }
  return { explanation: known.explanation, original: false };
}

// 轮次记录只保存稳定错误码；界面解释已知原因，未知错误保留通用提示与原码。
export function turnFailure(code: string, diagnostics?: unknown): TurnFailure {
  const diagnostic = providerDiagnosticText(diagnostics);
  const withDiagnostic = (failure: TurnFailure): TurnFailure => diagnostic === undefined ? failure : { ...failure, diagnostic };
  switch (code) {
    case 'provider_output_exhausted':
      return { explanation: ['模型达到输出预算，回答未完整完成。先检查已有结果，再调整输出预算或缩小任务。', 'The model reached its output budget before completing. Inspect existing results, then adjust the budget or reduce the task.'] };
    case 'provider_empty_response':
      return { explanation: ['模型没有返回有效正文或工具调用。查看记录后决定是否重新提交。', 'The model returned no useful text or tool calls. Inspect the record before deciding whether to submit again.'] };
    case 'provider_stream_incomplete':
      return withDiagnostic({ explanation: ['模型响应缺少完整结束标记或分片。检查接口兼容性，并先查看已有结果。', 'The model response lacks a complete terminator or frame. Check API compatibility and inspect existing results first.'], action: 'models' });
    case 'provider_stream_interrupted':
      return withDiagnostic({ explanation: ['模型响应在读取途中中断。工具不会自动重做，请先查看已有结果。', 'Reading the model response was interrupted. Tools are not replayed automatically; inspect existing results first.'] });
    case 'provider_finish_reason_invalid':
      return { explanation: ['模型服务返回了不支持的结束原因。请检查接口类型与兼容性。', 'The model service returned an unsupported finish reason. Check its API type and compatibility.'], action: 'models' };
    case 'provider_tool_call_invalid':
      return { explanation: ['模型返回的工具调用缺少有效标识或名称，或标识重复。请检查模型服务兼容性。', 'The model returned a tool call with a missing or duplicate identity, or missing name. Check model service compatibility.'], action: 'models' };
    case 'exec_temp_cleanup_failed':
      return { explanation: ['命令结束后无法清理私有临时目录。检查系统文件占用或权限，核对已完成操作后再决定是否重试。', 'Ligule could not remove its private execution directory. Check OS file locks or permissions and inspect completed effects before retrying.'] };
    case 'exec_script_snapshot_cleanup_failed':
      return { explanation: ['命令结束后无法清理脚本快照。检查源文件所在目录的权限和占用，并核对已完成操作后再决定是否重试。', 'Ligule could not remove the execution script snapshot. Check permissions and file locks in its source directory, then inspect completed effects before retrying.'] };
    case 'exec_sandbox_cleanup_failed':
      return { explanation: ['平台沙箱清理未能确认完成。检查操作系统权限或 ACL 状态，确认后再重试受限命令。', 'Platform sandbox cleanup could not be confirmed. Check OS permissions or ACL state before retrying the restricted command.'] };
    case 'exec_sandbox_setup_failed':
      return { explanation: ['受限命令的操作系统沙箱未能初始化。检查当前平台的隔离能力与系统权限后重试。', 'The operating-system sandbox for the restricted command could not be initialized. Check platform isolation support and OS permissions before retrying.'] };
    case 'exec_termination_cleanup_failed':
      return { explanation: ['进程是否已终止和临时资源清理均未确认。先检查进程状态和已完成操作，再决定是否重试。', 'Process termination and temporary-resource cleanup are both unconfirmed. Check running processes and completed effects before retrying.'] };
    case 'provider_output_budget_invalid':
    case 'provider_output_budget_unsupported':
      return { explanation: ['输出预算无效或超过当前模型及配置允许的上限。检查 model.outputTokens 和能力限制。', 'The output budget is invalid or exceeds this model and configuration limit. Check model.outputTokens and capability limits.'], action: 'models' };
    case 'provider_credential_missing':
      return { explanation: ['当前模型未配置 API Key。请在模型服务中设置密钥或检查环境变量。', 'No API key is configured for this model. Set a key in Model services or check its environment variable.'], action: 'models' };
    case 'provider_credential_unbound':
      return { explanation: ['模型服务地址与凭据引用未在用户配置中绑定。请将该服务保存到用户层，或通过命令行明确配置服务目标。', 'The model endpoint and credential reference are not bound in user configuration. Save the service in the user layer or explicitly configure its target through command-line flags.'], action: 'models' };
    case 'credential_store_unavailable':
      return { explanation: ['系统凭据存储当前不可用。检查系统凭据服务，或改用环境变量提供凭据。', 'The system credential store is unavailable. Check the OS credential service or provide the credential through an environment variable.'], action: 'models' };
    case 'host_model_config_missing':
      return { explanation: ['尚未配置模型。请在桌面配置模型服务。', 'No model is configured. Configure a model service in Desktop.'], action: 'models' };
    case 'provider_api_form_required':
      return { explanation: ['尚未选择模型服务接口类型。检查模型服务配置并选择支持的接口类型。', 'The model service API type is missing. Check the model service settings and choose a supported API type.'], action: 'models' };
    case 'model_service_not_found':
      return { explanation: ['所选模型服务不存在。请查看可用服务并重新选择。', 'The selected model service was not found. View available services and select one again.'], action: 'models' };
    case 'model_not_available':
      return { explanation: ['所选模型不在该服务的可用列表中。请选择该服务列出的模型。', 'The selected model is not available from this service. Choose a model listed for that service.'], action: 'models' };
    case 'provider_model_required':
    case 'provider_base_url_required':
    case 'provider_base_url_invalid':
      return { explanation: ['模型配置不完整或地址无效。请检查模型服务。', 'The model configuration is incomplete or its URL is invalid. Check Model services.'], action: 'models' };
    case 'provider_transport_failed':
      return withDiagnostic({ explanation: ['无法连接模型服务。请检查网络和服务地址后重新发送。', 'Could not connect to the model service. Check your network and service URL, then send again.'], action: 'models' });
    case 'provider_http_error':
      return withDiagnostic({ explanation: ['模型服务返回错误。请检查密钥、模型访问权限及服务状态。', 'The model service returned an error. Check the API key, model access, and service status.'], action: 'models' });
    case 'provider_timeout':
      return withDiagnostic({ explanation: ['模型请求超过时限。先检查会话记录与已完成的工具结果，再决定是否重新发送。', 'The model request exceeded its time limit. Inspect the session record and completed tool results before deciding whether to send again.'], action: 'models' });
    case 'provider_stream_invalid':
    case 'provider_stream_missing':
      return withDiagnostic({ explanation: ['模型响应无法读取。请检查服务的接口类型和兼容性。', 'The model response could not be read. Check the service API type and compatibility.'], action: 'models' });
    case 'provider_tool_args_invalid':
      return { explanation: ['模型返回的工具参数无效。请重新发送，或选择其他模型。', 'The model returned invalid tool arguments. Send again or choose another model.'] };
    default:
      return { explanation: ['本轮未能完成。可展开详情查看错误代码。', 'The turn could not complete. Open Details to see the error code.'] };
  }
}
