// 运行中输入被取消时，只清理仍属于本机、且就是本次请求的问题卡；外控问题由外控面板管理。
export function clearCancelledLocalQuestion<T extends { readonly id: string; readonly external?: boolean }>(
  current: T | null,
  requestId: string | undefined,
  cancelledInteractions: number,
): T | null {
  if (requestId === undefined || cancelledInteractions < 1 || current?.external === true || current?.id !== requestId) return current;
  return null;
}
