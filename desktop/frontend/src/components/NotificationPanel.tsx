import { useEffect, useState } from 'react';
import { Switch } from 'radix-ui';
import { NOTIFICATION_KINDS, type NotificationBridge, type NotificationPreferences, type NotificationKind } from '../notifications';
import { useText } from '../locale';
import { Group } from './ui';

export function NotificationPanel({ preferences, bridge, problem, onChange }: {
  preferences: NotificationPreferences;
  bridge?: NotificationBridge;
  problem: string | null;
  onChange: (value: NotificationPreferences) => void;
}) {
  const t = useText();
  const [permission, setPermission] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    let active = true;
    if (bridge !== undefined) void bridge.permission().then(
      granted => { if (active) setPermission(granted); },
      () => { if (active) setFailure('notification_permission_unavailable'); },
    );
    return () => { active = false; };
  }, [bridge]);
  const labels: Record<NotificationKind, [string, string]> = {
    question: ['待回答问题', 'Questions awaiting answers'],
    approval: ['待审批操作', 'Actions awaiting approval'],
    completed: ['本轮结束', 'Turn completed'],
    failed: ['运行失败', 'Run failed'],
    disconnected: ['连接中断', 'Connection interrupted'],
  };
  const request = async () => {
    if (bridge === undefined) return;
    setRequesting(true);
    setFailure(null);
    try { setPermission(await bridge.permission()); }
    catch { setFailure('notification_permission_unavailable'); }
    finally { setRequesting(false); }
  };
  return <>
    <Group title={t('系统通知', 'System notifications')}>
      <div className="notification-option">
        <div><label htmlFor="notifications-enabled">{t('允许通知', 'Enable notifications')}</label><p>{t('前台和后台均提醒。点击通知打开对应会话。', 'Notify in the foreground and background. Click to open the conversation.')}</p></div>
        <Switch.Root id="notifications-enabled" className="notification-switch" checked={preferences.enabled} onCheckedChange={enabled => onChange({ ...preferences, enabled })}><Switch.Thumb /></Switch.Root>
      </div>
      {NOTIFICATION_KINDS.map(kind => <div className="notification-option" key={kind}>
        <label htmlFor={`notifications-${kind}`}>{t(...labels[kind])}</label>
        <Switch.Root id={`notifications-${kind}`} className="notification-switch" checked={preferences[kind]} disabled={!preferences.enabled} onCheckedChange={checked => onChange({ ...preferences, [kind]: checked })}><Switch.Thumb /></Switch.Root>
      </div>)}
    </Group>
    <Group title={t('系统通知支持', 'System notification support')}>
      {bridge === undefined ? <p className="stub">{t('系统通知仅在桌面应用中可用。', 'System notifications are available in the desktop app.')}</p>
        : <>
          <p className="stub">{failure !== null ? t('无法检查系统通知支持，请重试。', 'Could not check notification support. Try again.')
            : permission === null ? t('正在检查系统通知支持…', 'Checking notification support…')
            : permission ? t('系统支持原生通知。是否允许显示由系统设置管理，应用无法直接读取授权状态；勿扰模式也可能隐藏通知。', 'Native notifications are supported. Authorization is managed in system settings and cannot be read by the app; Do Not Disturb may also hide notifications.')
              : t('当前环境不支持系统通知。', 'System notifications are not supported in this environment.')}</p>
          <button type="button" disabled={requesting} onClick={() => void request()}>{t('重新检查', 'Check again')}</button>
        </>}
      {(failure ?? problem) !== null && <div className="session-note" data-tone="bad">
        <p>{t('通知暂不可用。请检查系统通知权限和通知服务。', 'Notifications are unavailable. Check system permission and the notification service.')}</p>
        <details><summary>{t('错误代码', 'Error code')}</summary><code>{failure ?? problem}</code></details>
      </div>}
    </Group>
  </>;
}
