// 协议错误在界面层的稳定文本提取；Host 返回的错误对象与普通异常都要能取出短码与消息。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return isRecord(error) && typeof error.message === 'string' ? error.message : undefined;
}
