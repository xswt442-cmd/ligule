const path = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { app } = require('electron');

const repositoryRoot = process.env.LIGULE_NATIVE_TEST_ROOT;
const userDataRoot = process.env.LIGULE_NATIVE_TEST_USER_DATA;
const documentsRoot = process.env.LIGULE_NATIVE_TEST_DOCUMENTS;
const workspaceRoot = process.env.LIGULE_NATIVE_TEST_WORKSPACE;
if ([repositoryRoot, userDataRoot, documentsRoot, workspaceRoot].some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('native_test_root_invalid');

const desktopRoot = path.join(repositoryRoot, 'desktop');
const compiledRoot = path.join(desktopRoot, 'electron', 'dist');
const security = require(path.join(compiledRoot, 'security.js'));
const { APP_PAGE } = security;
const { registerAppScheme, installResourceProtocol, createApplicationWindow } = require(path.join(compiledRoot, 'secure-window.js'));
const { NativeServices } = require(path.join(compiledRoot, 'native.js'));
const { HostController } = require(path.join(compiledRoot, 'host.js'));
const { resolveHostRuntime } = require(path.join(compiledRoot, 'runtime.js'));
const { registerDesktopIpc } = require(path.join(compiledRoot, 'ipc.js'));

let window;
let native;
let host;
let detachIpc;
let ready = false;
let hostRequestSequence = 0;
const notificationTargets = new Map();
let latestNotification;

function send(message) {
  if (process.connected) process.send(message);
}

function assertReady() {
  if (!ready || window === undefined || window.isDestroyed()) throw new Error('native_test_window_unavailable');
}

function invokePreload(method, ...args) {
  assertReady();
  const expression = `window.liguleDesktop[${JSON.stringify(method)}](${args.map(value => JSON.stringify(value)).join(',')})`;
  return window.webContents.executeJavaScript(expression);
}

async function requestHost(method, params) {
  assertReady();
  const id = `native-features-${++hostRequestSequence}`;
  const frame = JSON.stringify({ id, method, params });
  return await window.webContents.executeJavaScript(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const index = window.__nativeFeatureFrames.findIndex(value => {
        try { return JSON.parse(value).id === ${JSON.stringify(id)}; } catch { return false; }
      });
      if (index >= 0) return JSON.parse(window.__nativeFeatureFrames.splice(index, 1)[0]);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('native_feature_host_response_timeout');
  })()`);
}

async function openExportPanel() {
  assertReady();
  return await window.webContents.executeJavaScript(`(async () => {
    const menu = [...document.querySelectorAll('button')].find(button => ['会话菜单', 'Conversation menu'].includes(button.getAttribute('aria-label')));
    if (menu === undefined) throw new Error('native_feature_session_menu_missing');
    menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    const menuDeadline = Date.now() + 5_000;
    while (Date.now() < menuDeadline) {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(element => /导出 Markdown|Export Markdown/u.test(element.textContent ?? ''));
      if (item !== undefined) {
        item.click();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const panelDeadline = Date.now() + 5_000;
    while (Date.now() < panelDeadline) {
      const button = [...document.querySelectorAll('.dock button.rail-refresh')].find(element => /导出会话|Export session/u.test(element.textContent ?? ''));
      if (button !== undefined) return button.textContent.trim();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const menuItems = [...document.querySelectorAll('[role="menuitem"]')].map(element => element.textContent?.trim() ?? '');
    throw new Error('native_feature_export_panel_missing:' + JSON.stringify({ sessionTitle: document.querySelector('#session-title')?.textContent?.trim() ?? '', menuItems, dock: document.querySelector('.dock')?.innerText ?? '' }));
  })()`);
}

async function clickExportButton() {
  assertReady();
  return await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.dock button.rail-refresh')].find(element => /导出会话|Export session/u.test(element.textContent ?? ''));
    if (button === undefined) throw new Error('native_feature_export_button_missing');
    button.click();
    return button.textContent.trim();
  })()`);
}

async function inspectExportUi() {
  assertReady();
  return await window.webContents.executeJavaScript(`(() => ({
    sessionTitle: document.querySelector('#session-title')?.textContent?.trim() ?? '',
    panelText: document.querySelector('.dock')?.innerText ?? '',
    exportButtonCount: [...document.querySelectorAll('.dock button.rail-refresh')].filter(element => /导出会话|Export session/u.test(element.textContent ?? '')).length,
  }))()`);
}

async function dispatch(command) {
  switch (command.action) {
    case 'save-export-path':
      return await invokePreload('saveExportPath', command.defaultName);
    case 'show-notification':
      return await invokePreload('showNotification', command.notification);
    case 'click-latest-notification': {
      const latest = latestNotification;
      if (latest === undefined) throw new Error('native_feature_notification_missing');
      latest.emit('click');
      return { clicked: true, target: notificationTargets.get(latest) };
    }
    case 'prepare-export-sessions': {
      const first = await requestHost('session.create', { projectRoot: workspaceRoot, workspaceOrigin: 'explicit' });
      if (first.error !== undefined || typeof first.result?.sessionId !== 'string') throw new Error('native_feature_session_a_create_failed');
      const second = await requestHost('session.create', { projectRoot: workspaceRoot, workspaceOrigin: 'explicit' });
      if (second.error !== undefined || typeof second.result?.sessionId !== 'string') throw new Error('native_feature_session_b_create_failed');
      const sessionA = first.result.sessionId;
      const sessionB = second.result.sessionId;
      const labelA = await requestHost('session.label', { sessionId: sessionA, name: 'Export race A' });
      const labelB = await requestHost('session.label', { sessionId: sessionB, name: 'Export race B' });
      if (labelA.error !== undefined || labelB.error !== undefined) throw new Error(`native_feature_session_label_failed:${labelA.error?.code ?? labelB.error?.code ?? 'unknown'}`);
      return { sessionA, sessionB, projectRoot: workspaceRoot };
    }
    case 'session-title':
      assertReady();
      return await window.webContents.executeJavaScript(`document.querySelector('#session-title')?.textContent?.trim() ?? ''`);
    case 'notification-targets':
      assertReady();
      return await window.webContents.executeJavaScript('window.__nativeNotificationTargets ?? []');
    case 'open-export-panel':
      return await openExportPanel();
    case 'click-export':
      return await clickExportButton();
    case 'inspect-export-ui':
      return await inspectExportUi();
    case 'invalid-export-path': {
      const blocker = path.join(documentsRoot, 'native-export-path-blocker');
      await writeFile(blocker, 'preserve this file');
      const target = path.join(blocker, 'should-not-exist.md');
      const response = await requestHost('session.export', { sessionId: command.value, path: target });
      return {
        error: response.error?.code,
        blocker: await readFile(blocker, 'utf8'),
        targetExists: existsSync(target),
      };
    }
    case 'update-tray':
      return await invokePreload('updateTray', 'Native feature test', true, 'en');
    case 'inspect-tray-window': {
      assertReady();
      const canHide = native.canHide();
      if (!canHide) return { canHide, hidden: false, restored: window.isVisible() };
      window.hide();
      const hidden = !window.isVisible();
      native.restore();
      await new Promise(resolve => setTimeout(resolve, 100));
      return { canHide, hidden, restored: window.isVisible() };
    }
    case 'shutdown':
      if (host !== undefined) await host.stop();
      detachIpc?.();
      native?.dispose();
      app.quit();
      return { closing: true };
    default:
      throw new Error('native_test_action_invalid');
  }
}

registerAppScheme();
app.setAppUserModelId('app.ligule.desktop');
app.setPath('userData', userDataRoot);
app.setPath('documents', documentsRoot);
app.enableSandbox();

app.whenReady().then(async () => {
  const iconPath = path.join(desktopRoot, 'icons', 'icon.png');
  const assets = path.join(desktopRoot, 'frontend', 'dist');
  const preload = path.join(compiledRoot, 'preload.js');
  installResourceProtocol(assets);
  window = createApplicationWindow({ preload, iconPath, page: APP_PAGE, development: false });
  native = new NativeServices({
    window,
    onQuitRequested: () => send({ type: 'quit-requested' }),
    onNotificationOpen: target => {
      if (!window.isDestroyed() && security.approvedPage(window.webContents.mainFrame.url, APP_PAGE)) {
        window.webContents.send('ligule:notification-open', target);
      }
      send({ type: 'notification-open', target });
    },
    onFault: code => send({ type: 'native-fault', code }),
    iconPath,
  });
  const showNotification = native.showNotification.bind(native);
  native.showNotification = notification => {
    const addNotification = native.notifications.add.bind(native.notifications);
    native.notifications.add = item => {
      latestNotification = item;
      notificationTargets.set(item, notification.target);
      return addNotification(item);
    };
    let pending;
    try { pending = showNotification(notification); }
    finally { native.notifications.add = addNotification; }
    return pending;
  };
  const saveExportPath = native.saveExportPath.bind(native);
  native.saveExportPath = defaultName => {
    send({ type: 'save-path-requested', defaultName });
    return saveExportPath(defaultName).then(selectedPath => {
      send({ type: 'save-path-completed', defaultName, selectedPath });
      return selectedPath;
    });
  };
  const runtime = resolveHostRuntime({
    repositoryRoot,
    node: path.join(desktopRoot, 'vendor', 'node', 'node.exe'),
    environment: process.env,
  });
  host = new HostController({
    ...runtime,
    hostEntry: runtime.hostEntry,
    cwd: workspaceRoot,
    entry: path.join(compiledRoot, 'host-entry.js'),
    onFrame: frame => {
      if (window !== undefined && !window.isDestroyed()) window.webContents.send('ligule:host-frame', frame);
    },
    onFault: fault => {
      if (window !== undefined && !window.isDestroyed()) window.webContents.send('ligule:host-fault', `host_closed:${fault}`);
    },
  });
  detachIpc = registerDesktopIpc(window, APP_PAGE, host, native, async () => {});
  await host.start();
  await window.loadURL(APP_PAGE);
  window.show();
  await window.webContents.executeJavaScript('Boolean(window.liguleDesktop)');
  await window.webContents.executeJavaScript(`window.__nativeFeatureFrames = []; window.liguleDesktop.onHostFrame(frame => window.__nativeFeatureFrames.push(frame)); true;`);
  await window.webContents.executeJavaScript(`window.__nativeNotificationTargets = []; window.liguleDesktop.onNotificationOpen(target => window.__nativeNotificationTargets.push(target)); true;`);
  ready = true;
  send({ type: 'ready', pid: process.pid, electronVersion: process.versions.electron });
}).catch(error => {
  send({ type: 'startup-failed', message: error instanceof Error ? error.message : 'native_test_startup_failed' });
  app.exit(1);
});

process.on('message', message => {
  if (message === null || typeof message !== 'object' || typeof message.id !== 'string' || typeof message.action !== 'string') return;
  void dispatch(message).then(
    value => send({ type: 'result', id: message.id, value }),
    error => send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : 'native_test_action_failed' }),
  );
});

process.once('disconnect', () => {
  void host?.stop();
  detachIpc?.();
  native?.dispose();
  app.quit();
});
