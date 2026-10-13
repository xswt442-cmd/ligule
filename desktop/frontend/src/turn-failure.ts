export type TurnFailure = {
  explanation: [string, string];
  action?: 'models';
};

// 轮次记录只保存稳定错误码；界面解释已知原因，未知错误保留通用提示与原码。
export function turnFailure(code: string): TurnFailure {
  switch (code) {
    case 'provider_credential_missing':
      return { explanation: ['当前模型未配置 API Key。请在模型服务中设置密钥或检查环境变量。', 'No API key is configured for this model. Set a key in Model services or check its environment variable.'], action: 'models' };
    case 'provider_model_required':
    case 'provider_base_url_required':
    case 'provider_base_url_invalid':
      return { explanation: ['模型配置不完整或地址无效。请检查模型服务。', 'The model configuration is incomplete or its URL is invalid. Check Model services.'], action: 'models' };
    case 'provider_transport_failed':
      return { explanation: ['无法连接模型服务。请检查网络和服务地址后重新发送。', 'Could not connect to the model service. Check your network and service URL, then send again.'], action: 'models' };
    case 'provider_http_error':
      return { explanation: ['模型服务返回错误。请检查密钥、模型访问权限及服务状态。', 'The model service returned an error. Check the API key, model access, and service status.'], action: 'models' };
    case 'provider_stream_invalid':
    case 'provider_stream_missing':
      return { explanation: ['模型响应无法读取。请检查服务的接口类型和兼容性。', 'The model response could not be read. Check the service API type and compatibility.'], action: 'models' };
    case 'provider_tool_args_invalid':
      return { explanation: ['模型返回的工具参数无效。请重新发送，或选择其他模型。', 'The model returned invalid tool arguments. Send again or choose another model.'] };
    default:
      return { explanation: ['本轮未能完成。可展开详情查看错误代码。', 'The turn could not complete. Open Details to see the error code.'] };
  }
}
