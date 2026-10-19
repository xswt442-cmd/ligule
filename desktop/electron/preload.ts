import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { DesktopApi, DesktopNotification } from './api.js';

// 沙盒 Preload 只依赖 Electron；公开接口不传递原生事件对象，也不允许调用动态通道。
if (process.isMainFrame) {
  const subscriptions = new Set<() => void>();
  type EventChannel = 'ligule:host-frame' | 'ligule:host-log' | 'ligule:host-fault' | 'ligule:quit-requested' | 'ligule:notification-open';
  const subscribe = (channel: EventChannel, handler: (value: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, value: string): void => handler(value);
    const unsubscribe = (): void => {
      ipcRenderer.removeListener(channel, listener);
      subscriptions.delete(unsubscribe);
    };
    ipcRenderer.on(channel, listener);
    subscriptions.add(unsubscribe);
    return unsubscribe;
  };
  window.addEventListener('pagehide', () => {
    for (const unsubscribe of subscriptions) unsubscribe();
  }, { once: true });
  const bridge: DesktopApi = {
    sendHostFrame: (frame: string) => ipcRenderer.invoke('ligule:host-send', frame),
    restartHost: () => ipcRenderer.invoke('ligule:host-restart'),
    onHostFrame: handler => subscribe('ligule:host-frame', handler),
    onHostLog: handler => subscribe('ligule:host-log', handler),
    onHostFault: handler => subscribe('ligule:host-fault', handler),
    defaultWorkspace: () => ipcRenderer.invoke('ligule:default-workspace'),
    selectWorkspaceDirectory: (directory: string) => ipcRenderer.invoke('ligule:workspace-directory', directory),
    saveExportPath: (name: string) => ipcRenderer.invoke('ligule:export-path', name),
    requestQuit: () => ipcRenderer.invoke('ligule:quit'),
    onQuitRequested: handler => subscribe('ligule:quit-requested', handler),
    notificationPermission: () => ipcRenderer.invoke('ligule:notification-permission'),
    requestNotificationPermission: () => ipcRenderer.invoke('ligule:notification-request'),
    showNotification: (notification: DesktopNotification) => ipcRenderer.invoke('ligule:notification-show', notification),
    onNotificationOpen: handler => subscribe('ligule:notification-open', handler),
    updateTray: (label, attention, language) => ipcRenderer.invoke('ligule:tray-status', label, attention, language),
  };
  contextBridge.exposeInMainWorld('liguleDesktop', bridge);
}
