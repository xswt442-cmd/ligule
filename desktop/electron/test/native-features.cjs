const path = require('node:path');
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

async function dispatch(command) {
  switch (command.action) {
    case 'save-export-path':
      return await invokePreload('saveExportPath', command.defaultName);
    case 'show-notification':
      return await invokePreload('showNotification', command.notification);
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
  const assets = path.join(desktopRoot, 'frontend', 'dist');
  const preload = path.join(compiledRoot, 'preload.js');
  const iconPath = path.join(desktopRoot, 'icons', 'icon.png');
  installResourceProtocol(assets);
  window = createApplicationWindow({ preload, iconPath, page: APP_PAGE, development: false });
  native = new NativeServices({
    window,
    onQuitRequested: () => send({ type: 'quit-requested' }),
    onNotificationOpen: target => send({ type: 'notification-open', target }),
    onFault: code => send({ type: 'native-fault', code }),
    iconPath,
  });
  const runtime = resolveHostRuntime({
    repositoryRoot,
    node: path.join(desktopRoot, 'vendor', 'node', 'node.exe'),
    environment: process.env,
  });
  host = new HostController({
    ...runtime,
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
