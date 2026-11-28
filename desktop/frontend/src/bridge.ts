import type { DesktopAppInfo } from '../../electron/api';
import type { Transport } from './protocol';

function sendErrorReason(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const coded = (error as { code?: unknown }).code;
    if (typeof coded === 'string' && coded !== '') return coded;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') {
      const matched = message.match(/\b(desktop_[a-z0-9_]+|host_closed)\b/u);
      return matched?.[1] ?? message;
    }
  }
  return 'host_closed';
}

// Preload 只交回固定用途的接口；React 不接触 Electron IPC 或 Node 对象。
export function electronTransport(): Transport {
  const api = window.liguleDesktop;
  if (api === undefined) throw new Error('desktop_bridge_unavailable');
  const faults = new Set<(reason: string) => void>();
  api.onHostFault(reason => { for (const handle of faults) handle(reason); });
  return {
    notifications: {
      permission: api.notificationPermission,
      requestPermission: api.requestNotificationPermission,
      show: api.showNotification,
      onOpen: async handle => api.onNotificationOpen(handle),
      updateTray: api.updateTray,
    },
    send: frame => { void api.sendHostFrame(frame).catch((error: unknown) => { const reason = sendErrorReason(error); for (const handle of faults) handle(reason); }); },
    onFrame: api.onHostFrame,
    onLog: api.onHostLog,
    onFault: handle => { faults.add(handle); return () => { faults.delete(handle); }; },
    restart: api.restartHost,
    defaultWorkspace: api.defaultWorkspace,
    onQuit: api.onQuitRequested,
    quit: api.requestQuit,
  };
}

export async function saveExportPath(defaultName: string): Promise<string | null> {
  const api = window.liguleDesktop;
  if (api === undefined) throw new Error('desktop_bridge_unavailable');
  return await api.saveExportPath(defaultName);
}

export async function selectWorkspaceDirectory(defaultPath: string): Promise<string | null> {
  const api = window.liguleDesktop;
  if (api === undefined) throw new Error('desktop_bridge_unavailable');
  return await api.selectWorkspaceDirectory(defaultPath);
}

export async function readDesktopAppInfo(): Promise<DesktopAppInfo | null> {
  const api = window.liguleDesktop;
  return api === undefined ? null : await api.appInfo();
}
