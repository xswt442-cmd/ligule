import { ipcMain, type BrowserWindow } from 'electron';
import { isAbsolute } from 'node:path';
import type { HostController } from './host.js';
import type { NativeServices } from './native.js';
import { assertSender, requiredText, validateDefaultName, validateFrame, validateNotification } from './security.js';

export const CHANNELS = ['ligule:host-send', 'ligule:host-restart', 'ligule:default-workspace', 'ligule:workspace-directory', 'ligule:export-path', 'ligule:quit', 'ligule:notification-permission', 'ligule:notification-request', 'ligule:notification-show', 'ligule:tray-status'] as const;

export function registerDesktopIpc(window: BrowserWindow, page: string, host: HostController, native: NativeServices, quit: () => Promise<void>): () => void {
  let pending = 0;
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertSender(event, window, page);
      if (pending >= 64) throw new Error('desktop_ipc_busy');
      const count = channel === 'ligule:tray-status' ? 3 : ['ligule:host-send', 'ligule:workspace-directory', 'ligule:export-path', 'ligule:notification-show'].includes(channel) ? 1 : 0;
      if (args.length !== count) throw new Error('desktop_ipc_args_invalid');
      pending += 1;
      try {
        switch (channel) {
          case 'ligule:host-send': return await host.send(validateFrame(args[0]));
          case 'ligule:host-restart': return await host.restart();
          case 'ligule:default-workspace': return await native.defaultWorkspace();
          case 'ligule:workspace-directory': {
            const directory = requiredText(args[0], 32_768, 'workspace_directory_invalid');
            if (!isAbsolute(directory)) throw new Error('workspace_directory_invalid');
            return await native.selectWorkspaceDirectory(directory);
          }
          case 'ligule:export-path': return await native.saveExportPath(validateDefaultName(args[0]));
          case 'ligule:quit': return await quit();
          case 'ligule:notification-permission': return native.notificationPermission();
          case 'ligule:notification-request': return await native.requestNotificationPermission();
          case 'ligule:notification-show': return await native.showNotification(validateNotification(args[0]));
          case 'ligule:tray-status': {
            const label = requiredText(args[0], 128, 'desktop_tray_invalid');
            if (typeof args[1] !== 'boolean' || (args[2] !== 'zh' && args[2] !== 'en')) throw new Error('desktop_tray_invalid');
            return native.updateTray(label, args[1], args[2]);
          }
        }
      } finally { pending -= 1; }
    });
  }
  return () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel); };
}
