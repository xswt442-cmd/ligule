import type { Locale } from './locale';

export const NOTIFICATION_KINDS = ['question', 'approval', 'completed', 'failed', 'disconnected'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationPreferences = { enabled: boolean } & Record<NotificationKind, boolean>;
export type NotificationTarget = { sessionId: string; projectRoot: string };
export type NativeNotification = { title: string; body: string; target: string; openLabel: string };
export type NotificationBridge = {
  permission: () => Promise<boolean>;
  requestPermission: () => Promise<'granted' | 'denied' | 'default'>;
  show: (notification: NativeNotification) => Promise<void>;
  onOpen: (handler: (target: string) => void) => Promise<() => void>;
  updateTray: (label: string, attention: boolean, language: Locale) => Promise<void>;
};

export const defaultNotifications: NotificationPreferences = {
  enabled: true, question: true, approval: true, completed: true, failed: true, disconnected: true,
};

export function notificationsFrom(value: unknown): NotificationPreferences {
  const given = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(defaultNotifications).map(([key, fallback]) => [
    key, typeof given[key] === 'boolean' ? given[key] : fallback,
  ])) as NotificationPreferences;
}

export function notificationOf(kind: NotificationKind, locale: Locale, target?: NotificationTarget, name = ''): NativeNotification {
  const labels: Record<NotificationKind, [string, string]> = {
    question: ['需要你的回答', 'Your answer is needed'],
    approval: ['有操作等待审批', 'An action needs approval'],
    completed: ['本轮已完成', 'Turn completed'],
    failed: ['本轮运行失败', 'Turn failed'],
    disconnected: ['连接已中断', 'Connection interrupted'],
  };
  const label = labels[kind][locale === 'zh' ? 0 : 1];
  // 通知只使用产品状态与会话名称，不带密钥、命令、模型正文或提问内容。
  return {
    title: 'ligule',
    body: name === '' ? label : `${name} · ${label}`,
    target: target === undefined ? '' : JSON.stringify(target),
    openLabel: locale === 'zh' ? '打开会话' : 'Open conversation',
  };
}

export function notificationTarget(value: string): NotificationTarget | null {
  if (value === '') return null;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('notification_target_invalid');
  const item = parsed as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || item.sessionId === '' || typeof item.projectRoot !== 'string') throw new Error('notification_target_invalid');
  return { sessionId: item.sessionId, projectRoot: item.projectRoot };
}
