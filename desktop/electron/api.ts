export interface DesktopNotification {
  title: string;
  body: string;
  target: string;
  openLabel: string;
}

export interface DesktopApi {
  sendHostFrame(frame: string): Promise<void>;
  restartHost(): Promise<void>;
  onHostFrame(handler: (frame: string) => void): () => void;
  onHostLog(handler: (line: string) => void): () => void;
  onHostFault(handler: (code: string) => void): () => void;
  defaultWorkspace(): Promise<string>;
  saveExportPath(defaultName: string): Promise<string | null>;
  requestQuit(): Promise<void>;
  onQuitRequested(handler: () => void): () => void;
  notificationPermission(): Promise<boolean>;
  requestNotificationPermission(): Promise<'granted' | 'denied' | 'default'>;
  showNotification(notification: DesktopNotification): Promise<void>;
  onNotificationOpen(handler: (target: string) => void): () => void;
  updateTray(label: string, attention: boolean, language: 'zh' | 'en'): Promise<void>;
}
