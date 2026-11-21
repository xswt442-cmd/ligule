// 撤销确认与打开面板时的授权快照绑定：版本在打开时固定，后续列表响应不能改变这次撤销。
export type ControlGrantSnapshot = {
  readonly version: string;
  readonly grants: readonly { readonly id: string }[];
};

export function controlRevokeBinding(
  snapshot: ControlGrantSnapshot,
  grantId: string,
): { readonly grantId: string; readonly version: string } | null {
  return snapshot.grants.some((grant) => grant.id === grantId) ? { grantId, version: snapshot.version } : null;
}
