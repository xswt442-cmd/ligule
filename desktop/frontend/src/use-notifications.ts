import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from './locale';
import { notificationOf, notificationTarget, type NotificationBridge, type NotificationKind, type NotificationPreferences, type NotificationTarget } from './notifications';
import { code } from './protocol';

export function useNotifications(
  bridge: NotificationBridge | undefined,
  preferences: NotificationPreferences,
  language: Locale,
  waiting: number,
  running: number,
  report: (message: string) => void,
) {
  const [problem, setProblem] = useState<string | null>(null);
  const [destination, setDestination] = useState<NotificationTarget | null>(null);
  const sessions = useRef(new Map<string, { root: string; name: string }>());
  const latest = useRef({ preferences, language });
  latest.current = { preferences, language };
  const ready = useRef<Promise<unknown>>(Promise.resolve());

  const notify = useCallback((kind: NotificationKind, own?: string, root = '') => {
    const { preferences: current, language: currentLanguage } = latest.current;
    if (bridge === undefined || !current.enabled || !current[kind]) return;
    const known = own === undefined ? undefined : sessions.current.get(own);
    const target = own === undefined ? undefined : { sessionId: own, projectRoot: known?.root ?? root };
    void ready.current.then(async () => {
      if (!await bridge.permission()) throw new Error('notification_permission_not_granted');
      const current = latest.current.preferences;
      if (!current.enabled || !current[kind]) return;
      await bridge.show(notificationOf(kind, currentLanguage, target, known?.name ?? ''));
    }).catch(error => setProblem(code(error)));
  }, [bridge]);

  useEffect(() => {
    if (bridge === undefined) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const listening = bridge.onOpen(value => {
      if (disposed) return;
      try { setDestination(notificationTarget(value)); }
      catch { setProblem('notification_target_invalid'); }
    });
    ready.current = listening;
    void listening.then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => { if (!disposed) setProblem('notification_listener_unavailable'); });
    return () => { disposed = true; stop?.(); };
  }, [bridge]);

  useEffect(() => {
    if (bridge === undefined) return;
    const label = language === 'zh'
      ? `ligule · ${waiting} 项待处理 · ${running} 个运行中`
      : `ligule · ${waiting} awaiting input · ${running} running`;
    void bridge.updateTray(label, waiting > 0, language).catch(error => report(`Tray status update failed: ${code(error)}`));
  }, [bridge, language, report, running, waiting]);

  return { problem, setProblem, destination, setDestination, sessions, notify };
}
