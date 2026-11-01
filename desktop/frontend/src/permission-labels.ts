import type { PermissionNetwork, PermissionProfile } from './status';

export type Translate = (chinese: string, english: string) => string;

export function profileLabel(profile: PermissionProfile, t: Translate): string {
  if (profile === 'read-only') return t('只读', 'Read only');
  if (profile === 'workspace-write') return t('工作区可写', 'Workspace write');
  return t('完全访问', 'Full access');
}

export function networkLabel(network: PermissionNetwork, t: Translate): string {
  if (network === 'policy') return t('按策略限制', 'Policy controlled');
  if (network === 'unrestricted') return t('不受限', 'Unrestricted');
  return t('禁用', 'Disabled');
}
