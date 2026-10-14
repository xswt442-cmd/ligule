import { app, BrowserWindow, dialog, Menu, Notification, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DesktopNotification } from './api.js';

const STATUS_NOTIFIER_SERVICE = 'org.kde.StatusNotifierWatcher';
const STATUS_NOTIFIER_PATH = '/StatusNotifierWatcher';
const STATUS_NOTIFIER_INTERFACE = 'org.kde.StatusNotifierWatcher';
const STATUS_NOTIFIER_PROPERTY = 'IsStatusNotifierHostRegistered';
const TRAY_POLL_INTERVAL_MS = 2_000;
const DBUS_COMMAND_TIMEOUT_MS = 1_500;
const MAX_TRAY_LABEL_LENGTH = 128;

export interface NativeServicesOptions {
  window: BrowserWindow;
  onQuitRequested: () => void;
  onNotificationOpen: (target: string) => void;
  onFault: (code: string) => void;
  iconPath: string;
}

export class NativeServices {
  private readonly options: NativeServicesOptions;
  private readonly notifications = new Set<Electron.Notification>();
  private readonly tray: Electron.Tray | undefined;
  private readonly trayPoll: NodeJS.Timeout | undefined;
  private trayHidden = false;
  private linuxTrayHostAvailable = false;
  private linuxProbeRunning = false;
  private lastLinuxFault: string | undefined;
  private disposed = false;
  private language: 'zh' | 'en' = 'zh';
  private trayLabel = '';
  private readonly onWindowHide = (): void => {
    if (this.canHide()) this.trayHidden = true;
  };
  private readonly onWindowShow = (): void => {
    this.trayHidden = false;
  };

  constructor(options: NativeServicesOptions) {
    this.options = options;
    options.window.on('hide', this.onWindowHide);
    options.window.on('show', this.onWindowShow);

    try {
      this.tray = new Tray(options.iconPath);
      this.tray.on('click', () => this.restore());
      this.updateTrayMenu();
    } catch {
      this.tray = undefined;
      this.reportFault('tray-unavailable');
    }

    if (process.platform === 'linux') {
      this.trayPoll = setInterval(() => { void this.checkLinuxTrayHost(); }, TRAY_POLL_INTERVAL_MS);
      this.trayPoll.unref();
      void this.checkLinuxTrayHost();
    }
  }

  async defaultWorkspace(): Promise<string> {
    try {
      const directory = join(app.getPath('documents'), 'ligule', 'default-workspace');
      await mkdir(directory, { recursive: true });
      return directory;
    } catch {
      this.reportFault('workspace-default-failed');
      throw new Error('The default workspace could not be prepared');
    }
  }

  async saveExportPath(defaultName: string): Promise<string | null> {
    if (this.disposed || this.options.window.isDestroyed()) {
      this.reportFault('export-dialog-unavailable');
      throw new Error('The export dialog is unavailable');
    }
    if (basename(defaultName) !== defaultName || defaultName === '.' || defaultName === '..') {
      this.reportFault('export-dialog-invalid-name');
      throw new Error('The export file name is invalid');
    }
    try {
      const options: Electron.SaveDialogOptions = {
        defaultPath: join(app.getPath('documents'), defaultName),
      };
      if (process.platform === 'linux') options.properties = ['showOverwriteConfirmation'];
      const result = await dialog.showSaveDialog(this.options.window, options);
      if (this.disposed || this.options.window.isDestroyed()) return null;
      return result.canceled ? null : result.filePath ?? null;
    } catch {
      this.reportFault('export-dialog-failed');
      throw new Error('The export location could not be selected');
    }
  }

  notificationPermission(): boolean {
    if (this.disposed) return false;
    try {
      // Electron 44 只能报告系统通知是否受支持，不能读取操作系统的授权状态。
      return Notification.isSupported();
    } catch {
      this.reportFault('notification-support-check-failed');
      return false;
    }
  }

  async requestNotificationPermission(): Promise<'granted' | 'denied' | 'default'> {
    if (this.disposed || !this.notificationPermission()) {
      this.reportFault('notification-unsupported');
      return 'denied';
    }
    // Electron 44 没有请求或读取操作系统通知授权状态的原生接口。
    this.reportFault('notification-permission-unavailable');
    return 'default';
  }

  async showNotification(notification: DesktopNotification): Promise<void> {
    if (this.disposed) throw new Error('The system notification service is unavailable');
    if (!Notification.isSupported()) {
      this.reportFault('notification-unsupported');
      throw new Error('System notifications are not supported');
    }

    try {
      const options: Electron.NotificationConstructorOptions = {
        title: notification.title,
        body: notification.body,
        urgency: 'normal',
      };
      if (process.platform === 'darwin' || process.platform === 'win32') {
        options.actions = [{ type: 'button', text: notification.openLabel }];
      }
      const nativeNotification = new Notification(options);
      this.notifications.add(nativeNotification);
      nativeNotification.on('click', () => this.openNotificationTarget(notification.target));
      nativeNotification.on('action', () => this.openNotificationTarget(notification.target));
      nativeNotification.on('close', () => this.notifications.delete(nativeNotification));
      await new Promise<void>((resolve, reject) => {
        const shown = (): void => { clear(); resolve(); };
        const failed = (): void => {
          clear();
          this.notifications.delete(nativeNotification);
          nativeNotification.close();
          reject(new Error('System notification was not shown'));
        };
        const timer = setTimeout(failed, 10_000);
        const clear = (): void => {
          clearTimeout(timer);
          nativeNotification.off('show', shown);
          nativeNotification.off('failed', failed);
        };
        nativeNotification.once('show', shown);
        nativeNotification.once('failed', failed);
        nativeNotification.show();
      });
    } catch {
      this.reportFault('notification-show-failed');
      throw new Error('The system notification could not be shown');
    }
  }

  updateTray(label: string, attention: boolean, language: 'zh' | 'en'): void {
    this.trayLabel = cleanTrayLabel(label);
    this.language = language;
    if (this.tray === undefined || this.tray.isDestroyed()) {
      this.reportFault('tray-unavailable');
      return;
    }
    try {
      const attentionText = language === 'zh' ? '需要处理' : 'Needs attention';
      const tooltip = [this.trayLabel, attention ? attentionText : ''].filter(Boolean).join(' · ');
      this.tray.setToolTip(tooltip || 'ligule');
      if (process.platform === 'darwin') {
        this.tray.setTitle(attention ? `• ${this.trayLabel}` : this.trayLabel);
      }
      this.updateTrayMenu();
    } catch {
      this.reportFault('tray-status-failed');
    }
  }

  canHide(): boolean {
    if (this.disposed || this.tray === undefined || this.tray.isDestroyed()) return false;
    return process.platform !== 'linux' || this.linuxTrayHostAvailable;
  }

  restore(): void {
    if (this.disposed || this.options.window.isDestroyed()) return;
    this.trayHidden = false;
    try {
      if (this.options.window.isMinimized()) this.options.window.restore();
      this.options.window.show();
      this.options.window.focus();
    } catch {
      this.reportFault('window-restore-failed');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.trayPoll !== undefined) clearInterval(this.trayPoll);
    if (!this.options.window.isDestroyed()) {
      this.options.window.off('hide', this.onWindowHide);
      this.options.window.off('show', this.onWindowShow);
    }
    for (const notification of this.notifications) {
      notification.removeAllListeners();
      notification.close();
    }
    this.notifications.clear();
    if (this.tray !== undefined && !this.tray.isDestroyed()) this.tray.destroy();
  }

  private openNotificationTarget(target: string): void {
    if (this.disposed) return;
    this.restore();
    try {
      this.options.onNotificationOpen(target);
    } catch {
      this.reportFault('notification-open-failed');
    }
  }

  private updateTrayMenu(): void {
    if (this.tray === undefined || this.tray.isDestroyed()) return;
    const openLabel = this.language === 'zh' ? '打开 ligule' : 'Open ligule';
    const quitLabel = this.language === 'zh' ? '退出 ligule' : 'Quit ligule';
    const menu = Menu.buildFromTemplate([
      { label: openLabel, click: () => this.restore() },
      { type: 'separator' },
      {
        label: quitLabel,
        click: () => {
          if (!this.disposed) this.options.onQuitRequested();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  private async checkLinuxTrayHost(): Promise<void> {
    if (this.disposed || process.platform !== 'linux' || this.linuxProbeRunning) return;
    this.linuxProbeRunning = true;
    try {
      const output = await getStatusNotifierHost();
      const parsed: unknown = JSON.parse(output);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid StatusNotifierWatcher response');
      }
      const value = parsed as { type?: unknown; data?: unknown };
      if (value.type !== 'b' || typeof value.data !== 'boolean') {
        throw new Error('Invalid StatusNotifierWatcher property');
      }
      this.setLinuxTrayHostAvailable(value.data);
      if (value.data) this.lastLinuxFault = undefined;
      else this.reportLinuxFault('tray-host-unavailable');
    } catch {
      this.setLinuxTrayHostAvailable(false);
      this.reportLinuxFault('tray-host-check-failed');
    } finally {
      this.linuxProbeRunning = false;
    }
  }

  private setLinuxTrayHostAvailable(available: boolean): void {
    const wasAvailable = this.linuxTrayHostAvailable;
    this.linuxTrayHostAvailable = available;
    if (wasAvailable && !available && this.trayHidden) this.restore();
  }

  private reportLinuxFault(code: string): void {
    if (this.lastLinuxFault === code) return;
    this.lastLinuxFault = code;
    this.reportFault(code);
  }

  private reportFault(code: string): void {
    if (this.disposed) return;
    try { this.options.onFault(code); } catch { /* 故障回报失败不能终止 Main 进程。 */ }
  }
}

function cleanTrayLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MAX_TRAY_LABEL_LENGTH);
}

function getStatusNotifierHost(): Promise<string> {
  const args = [
    '--user',
    '--json=short',
    'get-property',
    STATUS_NOTIFIER_SERVICE,
    STATUS_NOTIFIER_PATH,
    STATUS_NOTIFIER_INTERFACE,
    STATUS_NOTIFIER_PROPERTY,
  ];
  return new Promise((resolve, reject) => {
    execFile('busctl', args, {
      encoding: 'utf8',
      timeout: DBUS_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
