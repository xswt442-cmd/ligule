import { app, BrowserWindow, protocol, shell } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Session, WebContents } from 'electron';
import { APP_PAGE, DEV_PAGE, developmentCsp, PRODUCTION_CSP, approvedPage, resourcePath } from './security.js';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const configuredSessions = new WeakMap<Session, string>();
let appSchemeRegistered = false;
let resourceProtocolRoot: string | undefined;

export function registerAppScheme(): void {
  if (appSchemeRegistered) return;
  if (app.isReady()) throw new Error('desktop_app_scheme_registered_too_late');
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  }]);
  appSchemeRegistered = true;
}

export function installResourceProtocol(assets: string): void {
  if (!app.isReady()) throw new Error('desktop_resource_protocol_registered_too_early');
  const root = resolve(assets);
  if (resourceProtocolRoot !== undefined) {
    if (resourceProtocolRoot !== root) throw new Error('desktop_resource_protocol_conflict');
    return;
  }

  protocol.handle('app', async request => {
    if (request.method !== 'GET') return resourceResponse('Method not allowed', 405, 'text/plain; charset=utf-8');
    try {
      const canonicalRoot = await realpath(root);
      const requestedPath = resourcePath(canonicalRoot, request.url);
      const canonicalPath = await realpath(requestedPath);
      if (!isWithin(canonicalRoot, canonicalPath)) return resourceResponse('Forbidden', 403, 'text/plain; charset=utf-8');
      const contents = await readFile(canonicalPath);
      const contentType = MIME_TYPES[extname(canonicalPath).toLowerCase()] ?? 'application/octet-stream';
      return resourceResponse(new Uint8Array(contents), 200, contentType);
    } catch {
      return resourceResponse('Resource unavailable', 404, 'text/plain; charset=utf-8');
    }
  });
  resourceProtocolRoot = root;
}

export interface ApplicationWindowOptions {
  preload: string;
  iconPath: string;
  page: string;
  development: boolean;
  nonce?: string;
}

export function createApplicationWindow(options: ApplicationWindowOptions): BrowserWindow {
  const expectedPage = options.development ? DEV_PAGE : APP_PAGE;
  if (options.page !== expectedPage) throw new Error('desktop_page_rejected');
  if (!isAbsolute(options.preload) || !isAbsolute(options.iconPath)) throw new Error('desktop_resource_path_invalid');
  const csp = options.development ? developmentCsp(options.nonce) : PRODUCTION_CSP;

  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    show: false,
    title: 'ligule',
    icon: options.iconPath,
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: options.development,
    },
  });
  window.removeMenu();

  const contents = window.webContents;
  contents.on('will-navigate', (event, address) => {
    if (!approvedPage(address, options.page)) event.preventDefault();
  });
  contents.on('will-redirect', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isProjectHelpLink(url)) {
      void shell.openExternal(url).catch(() => {
        if (!window.isDestroyed() && approvedPage(contents.mainFrame.url, options.page)) {
          contents.send('ligule:host-log', 'desktop_external_link_failed');
        }
      });
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  installSessionSecurity(contents.session, contents, options.page, options.development, csp);
  return window;
}

function installSessionSecurity(targetSession: Session, owner: WebContents, page: string, development: boolean, csp: string): void {
  const configuredCsp = configuredSessions.get(targetSession);
  if (configuredCsp !== undefined) {
    if (configuredCsp !== csp) throw new Error('desktop_security_session_conflict');
    return;
  }

  // 仅允许受管理的顶层页面写入剪贴板文本；读取剪贴板和其他浏览器权限一律拒绝。
  const canWriteClipboard = (contents: WebContents | null, permission: string, mainFrame: boolean, url?: string): boolean =>
    contents === owner && !owner.isDestroyed() && permission === 'clipboard-sanitized-write' && mainFrame
    && typeof url === 'string' && approvedPage(url, page) && approvedPage(owner.mainFrame.url, page);
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(canWriteClipboard(contents, permission, details.isMainFrame, details.requestingUrl)));
  targetSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    canWriteClipboard(contents, permission, details.isMainFrame, details.requestingUrl));
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const responseCsp = development && isDevelopmentServer(details.url) ? csp : PRODUCTION_CSP;
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
    );
    responseHeaders['Content-Security-Policy'] = [responseCsp];
    responseHeaders['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders });
  });
  configuredSessions.set(targetSession, csp);
}

function resourceResponse(body: BodyInit, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Security-Policy': PRODUCTION_CSP,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isDevelopmentServer(address: string): boolean {
  try {
    return new URL(address).origin === new URL(DEV_PAGE).origin;
  } catch {
    return false;
  }
}

function isProjectHelpLink(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === ''
      && ((url.hostname === 'github.com'
          && (url.pathname === '/xswt442-cmd/ligule' || url.pathname.startsWith('/xswt442-cmd/ligule/')))
        || (url.hostname === 'www.npmjs.com' && url.pathname === '/package/ligule'));
  } catch {
    return false;
  }
}
