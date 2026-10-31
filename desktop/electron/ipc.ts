import { app, ipcMain, type BrowserWindow } from 'electron';
import { isAbsolute } from 'node:path';
import type { HostController } from './host.js';
import type { NativeServices } from './native.js';
import { assertSender, requiredText, validateDefaultName, validateFrame, validateNotification } from './security.js';

export const CHANNELS = ['ligule:app-info', 'ligule:host-send', 'ligule:host-restart', 'ligule:default-workspace', 'ligule:workspace-directory', 'ligule:export-path', 'ligule:artifact-reveal', 'ligule:quit', 'ligule:notification-permission', 'ligule:notification-request', 'ligule:notification-show', 'ligule:tray-status'] as const;

export function registerDesktopIpc(window: BrowserWindow, page: string, host: HostController, native: NativeServices, quit: () => Promise<void>): () => void {
  let pending = 0;
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertSender(event, window, page);
      if (pending >= 64) throw new Error('desktop_ipc_busy');
      const count = channel === 'ligule:tray-status' ? 3 : ['ligule:host-send', 'ligule:workspace-directory', 'ligule:export-path', 'ligule:artifact-reveal', 'ligule:notification-show'].includes(channel) ? 1 : 0;
      if (args.length !== count) throw new Error('desktop_ipc_args_invalid');
      pending += 1;
      try {
        switch (channel) {
          case 'ligule:app-info': return {
            name: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
            platform: process.platform, architecture: process.arch,
            electronVersion: process.versions.electron ?? 'unknown', build: null,
          };
          case 'ligule:host-send': {
            const frame = validateFrame(args[0]);
            const parsed = JSON.parse(frame) as { id?: unknown };
            if (typeof parsed.id === 'string' && parsed.id.startsWith('desktop-main:')) throw new Error('desktop_ipc_reserved_id');
            return await host.send(frame);
          }
          case 'ligule:host-restart': return await host.restart();
          case 'ligule:default-workspace': return await native.defaultWorkspace();
          case 'ligule:workspace-directory': {
            const directory = requiredText(args[0], 32_768, 'workspace_directory_invalid');
            if (!isAbsolute(directory)) throw new Error('workspace_directory_invalid');
            return await native.selectWorkspaceDirectory(directory);
          }
          case 'ligule:export-path': return await native.saveExportPath(validateDefaultName(args[0]));
          case 'ligule:artifact-reveal': {
            const payload = args[0];
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('artifact_reveal_invalid');
            const item = payload as Record<string, unknown>;
            if (Object.keys(item).length !== 3 || !['projectRoot', 'sessionId', 'artifactKey'].every(key => Object.hasOwn(item, key))
              || typeof item.projectRoot !== 'string' || !isAbsolute(item.projectRoot)
              || typeof item.sessionId !== 'string' || item.sessionId.length > 160 || item.sessionId.length < 1
              || typeof item.artifactKey !== 'string' || !/^[a-f0-9]{64}$/u.test(item.artifactKey)) throw new Error('artifact_reveal_invalid');
            const response = await host.request('artifact.resolve', {
              projectRoot: item.projectRoot, sessionId: item.sessionId, artifactKey: item.artifactKey,
            });
            if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error('artifact_reveal_invalid');
            const target = response as Record<string, unknown>;
            if (target.artifactKey !== item.artifactKey || typeof target.path !== 'string' || !isAbsolute(target.path)) {
              throw new Error('artifact_reveal_invalid');
            }
            await native.revealArtifact(target.path);
            return;
          }
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
