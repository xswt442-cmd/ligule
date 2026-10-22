export interface DesktopNotification {
  title: string;
  body: string;
  target: string;
  openLabel: string;
}

export interface DesktopAppInfo {
  readonly name: string;
  readonly version: string;
  readonly packaged: boolean;
  readonly platform: string;
  readonly architecture: string;
  readonly electronVersion: string;
  readonly build: { readonly id?: string; readonly date?: string } | null;
}

export interface DesktopApi {
  appInfo(): Promise<DesktopAppInfo>;
  sendHostFrame(frame: string): Promise<void>;
  restartHost(): Promise<void>;
  onHostFrame(handler: (frame: string) => void): () => void;
  onHostLog(handler: (line: string) => void): () => void;
  onHostFault(handler: (code: string) => void): () => void;
  defaultWorkspace(): Promise<string>;
  selectWorkspaceDirectory(defaultPath: string): Promise<string | null>;
  saveExportPath(defaultName: string): Promise<string | null>;
  requestQuit(): Promise<void>;
  onQuitRequested(handler: () => void): () => void;
  notificationPermission(): Promise<boolean>;
  requestNotificationPermission(): Promise<'granted' | 'denied' | 'default'>;
  showNotification(notification: DesktopNotification): Promise<void>;
  onNotificationOpen(handler: (target: string) => void): () => void;
  updateTray(label: string, attention: boolean, language: 'zh' | 'en'): Promise<void>;
}
