import type { Transport } from './protocol';

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
    send: frame => { void api.sendHostFrame(frame).catch(() => { for (const handle of faults) handle('host_closed'); }); },
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
