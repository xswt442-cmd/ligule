const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const repositoryRoot = resolve(__dirname, '../../..');
const desktopRoot = join(repositoryRoot, 'desktop');
const temporaryRoot = process.env.LIGULE_SECURITY_TEMP_ROOT;
const evidenceRoot = process.env.LIGULE_SECURITY_EVIDENCE_ROOT;
const userDataRoot = process.env.LIGULE_SECURITY_USER_DATA;
const workspaceRoot = process.env.LIGULE_SECURITY_WORKSPACE;
const isolatedHome = process.env.LIGULE_HOME;
const results = [];
let mainWindow;
let secondWindow;
let nativeServices;
let host;
let detachIpc;
let reporterError;
let observedCsp;
let sequence = 0;

if ([temporaryRoot, evidenceRoot, userDataRoot, workspaceRoot, isolatedHome].some(value => typeof value !== 'string' || value.length === 0)) {
  throw new Error('native_security_harness_paths_missing');
}

app.setPath('userData', userDataRoot);
app.enableSandbox();
// 证据必须在销毁窗口之后写出；保持应用存活到显式 quit，避免 window-all-closed 提前结束进程而丢失报告。
app.on('window-all-closed', () => {});

const secureWindow = require('../dist/secure-window.js');
const security = require('../dist/security.js');
const ipc = require('../dist/ipc.js');
const { HostController } = require('../dist/host.js');
const { resolveHostRuntime } = require('../dist/runtime.js');
const { NativeServices } = require('../dist/native.js');

secureWindow.registerAppScheme();

function note(sec, status, detail) {
  const item = { sec, status, detail };
  results.push(item);
  console.log(JSON.stringify(item));
}

async function check(sec, action) {
  try {
    const detail = await action();
    note(sec, '通过', detail ?? '真实 Electron 行为符合预期');
  } catch (error) {
    const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : String(error);
    const detail = String(message).split('\n')[0].slice(0, 240);
    note(sec, '失败', detail);
  }
}

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function evaluate(source) {
  assert.ok(mainWindow !== undefined && !mainWindow.isDestroyed(), '主窗口未创建');
  return mainWindow.webContents.executeJavaScript(source, true);
}

async function requestHost(request) {
  const id = request.id;
  const encoded = JSON.stringify(request);
  const source = `(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(encoded)});
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const frame = window.__nativeSecurityFrames.find(value => {
        try { return JSON.parse(value).id === ${JSON.stringify(id)}; } catch { return false; }
      });
      if (frame !== undefined) return JSON.parse(frame);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('host_response_timeout');
  })()`;
  return evaluate(source);
}

function cspHeader(headers) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-security-policy');
  if (entry === undefined) return undefined;
  const value = entry[1];
  return Array.isArray(value) ? value.join('; ') : String(value);
}

async function createApplication() {
  await app.whenReady();
  const assets = join(desktopRoot, 'frontend', 'dist');
  secureWindow.installResourceProtocol(assets);
  session.defaultSession.webRequest.onCompleted({ urls: ['app://ligule/*'] }, details => {
    if (details.url === security.APP_PAGE && details.resourceType === 'mainFrame') observedCsp = cspHeader(details.responseHeaders);
  });

  const preload = join(desktopRoot, 'electron', 'dist', 'preload.js');
  const iconPath = join(desktopRoot, 'assets', 'app-icon.png');
  mainWindow = secureWindow.createApplicationWindow({
    preload,
    iconPath,
    page: security.APP_PAGE,
    development: false,
  });
  nativeServices = new NativeServices({
    window: mainWindow,
    onQuitRequested: () => {},
    onNotificationOpen: () => {},
    onFault: code => console.log(JSON.stringify({ event: 'native-fault', code })),
    iconPath,
  });

  const bundledNode = join(desktopRoot, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const runtime = resolveHostRuntime({ repositoryRoot, node: bundledNode, environment: process.env });
  host = new HostController({
    ...runtime,
    cwd: workspaceRoot,
    entry: join(desktopRoot, 'electron', 'dist', 'host-entry.js'),
    onFrame: frame => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('ligule:host-frame', frame);
    },
    onFault: fault => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('ligule:host-fault', `host_closed:${fault}`);
    },
  });
  detachIpc = ipc.registerDesktopIpc(mainWindow, security.APP_PAGE, host, nativeServices, async () => {});
  await host.start();
  await mainWindow.loadURL(security.APP_PAGE);
  mainWindow.show();
  await evaluate(`(() => {
    window.__nativeSecurityFrames = [];
    window.__nativeSecurityUnsubscribe = window.liguleDesktop.onHostFrame(frame => window.__nativeSecurityFrames.push(frame));
    window.__nativeSecurityViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__nativeSecurityViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    return Object.keys(window.liguleDesktop).sort();
  })()`);
}

async function recordReport(exitCode) {
  const report = {
    platform: process.platform,
    release: require('node:os').release(),
    electron: process.versions.electron,
    node: process.versions.node,
    hostNode: require('node:child_process').execFileSync(join(desktopRoot, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'), ['--version'], { encoding: 'utf8' }).trim(),
    applicationPage: security.APP_PAGE,
    csp: observedCsp ?? null,
    exitCode,
    results,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, 'native-security.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(evidenceRoot, 'native-security.log'), `${results.map(item => `${item.sec} ${item.status}: ${item.detail}`).join('\n')}\n`, 'utf8');
}

async function runChecks() {
  const preferences = mainWindow.webContents.getLastWebPreferences();
  await check('SEC-01/10 preferences', async () => {
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.nodeIntegrationInWorker, false);
    assert.equal(preferences.webviewTag, false);
    assert.equal(preferences.webSecurity, true);
    assert.equal(preferences.allowRunningInsecureContent, false);
    return '真实 BrowserWindow 的 sandbox、contextIsolation 与 Node/WebView 权限设置符合约束';
  });

  await check('SEC-01 preload bridge', async () => {
    const result = await evaluate(`({
      node: typeof process !== 'undefined' || typeof require !== 'undefined' || typeof module !== 'undefined',
      electron: typeof ipcRenderer !== 'undefined' || typeof contextBridge !== 'undefined',
      fs: typeof window.require === 'function' || typeof window.process !== 'undefined',
      keys: Object.keys(window.liguleDesktop).sort(),
    })`);
    assert.equal(result.node, false);
    assert.equal(result.electron, false);
    assert.equal(result.fs, false);
    assert.deepEqual(result.keys, [
      'defaultWorkspace', 'notificationPermission', 'onHostFault', 'onHostFrame', 'onHostLog',
      'onNotificationOpen', 'onQuitRequested', 'requestNotificationPermission', 'requestQuit',
      'restartHost', 'saveExportPath', 'sendHostFrame', 'showNotification', 'updateTray',
    ]);
    return '真实 Preload 只暴露固定桌面 API，页面没有 Node 或 Electron 原语';
  });

  await check('SEC-10 CSP response', async () => {
    assert.match(observedCsp ?? '', /default-src 'self'/u);
    assert.match(observedCsp ?? '', /script-src 'self'/u);
    assert.match(observedCsp ?? '', /object-src 'none'/u);
    assert.doesNotMatch(observedCsp ?? '', /script-src[^;]*(?:unsafe-inline|unsafe-eval)/u);
    return `真实 app:// 主文档响应带生产 CSP：${observedCsp}`;
  });

  await check('SEC-02 second-window sender rejection', async () => {
    secondWindow = secureWindow.createApplicationWindow({
      preload: join(desktopRoot, 'electron', 'dist', 'preload.js'),
      iconPath: join(desktopRoot, 'assets', 'app-icon.png'),
      page: security.APP_PAGE,
      development: false,
    });
    await secondWindow.loadURL(security.APP_PAGE);
    await secondWindow.webContents.executeJavaScript(`location.assign('https://example.invalid/'); true`).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(secondWindow.webContents.getURL(), security.APP_PAGE);
    const secondaryResult = await secondWindow.webContents.executeJavaScript(`(async () => {
      const api = window.liguleDesktop;
      const operations = [
        () => api.sendHostFrame(${JSON.stringify(JSON.stringify({ id: nextId('secondary'), method: 'desktop.security.probe', params: {} }))}),
        () => api.restartHost(),
        () => api.defaultWorkspace(),
        () => api.saveExportPath('ligule-security.md'),
        () => api.requestQuit(),
        () => api.notificationPermission(),
        () => api.requestNotificationPermission(),
        () => api.showNotification({ title: 'ligule', body: '本轮已完成', target: '', openLabel: '打开会话' }),
        () => api.updateTray('ligule', false, 'zh'),
      ];
      const results = [];
      for (const operation of operations) {
        try { await operation(); results.push('accepted'); }
        catch (error) { results.push(String(error)); }
      }
      return results;
    })()`);
    assert.equal(secondaryResult.length, ipc.CHANNELS.length);
    for (const result of secondaryResult) assert.match(result, /desktop_sender_rejected/u);
    const clipboard = await secondWindow.webContents.executeJavaScript(`(async () => {
      try { await navigator.clipboard.writeText('rejected secondary window'); return 'accepted'; }
      catch (error) { return error.name; }
    })()`);
    assert.equal(clipboard, 'NotAllowedError');
    secondWindow.destroy();
    secondWindow = undefined;
    return '第二个真实窗口的恶意导航被阻止；相同 Preload 的全部九个 IPC 动作均被 sender 校验拒绝';
  });

  await check('SEC-02 iframe bridge and CSP', async () => {
    const iframeResult = await evaluate(`(async () => {
      const frame = document.createElement('iframe');
      frame.src = 'app://ligule/index.html';
      document.body.appendChild(frame);
      await new Promise(resolve => setTimeout(resolve, 300));
      let bridge;
      try { bridge = typeof frame.contentWindow.liguleDesktop; } catch { bridge = 'inaccessible'; }
      return { bridge, violations: window.__nativeSecurityViolations };
    })()`);
    assert.ok(['undefined', 'inaccessible'].includes(iframeResult.bridge), JSON.stringify(iframeResult));
    assert.ok(iframeResult.violations.some(item => item.directive.startsWith('frame-src')), JSON.stringify(iframeResult));
    return '嵌入页没有桥，真实 CSP 阻止 iframe 文档加载';
  });

  await check('SEC-09 browser clipboard permissions', async () => {
    const readPermission = await evaluate(`navigator.permissions.query({ name: 'clipboard-read' }).then(value => value.state)`);
    assert.equal(readPermission, 'denied');
    await evaluate(`navigator.clipboard.writeText('Ligule secure clipboard write check')`);
    return '受管理顶层页面可写入测试文本；clipboard-read 权限为 denied，未读取个人剪贴板';
  });

  await check('SEC-03 IPC frame rejection and live Host', async () => {
    const result = await evaluate(`(async () => {
      const oversized = JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024) });
      const attempts = ['{', '{}\\n{}', oversized];
      const errors = [];
      for (const frame of attempts) {
        try { await window.liguleDesktop.sendHostFrame(frame); errors.push('accepted'); }
        catch (error) { errors.push(String(error)); }
      }
      return errors;
    })()`);
    assert.equal(result.length, 3);
    for (const error of result) assert.match(error, /desktop_frame_invalid/u);
    const response = await requestHost({ id: nextId('sec03-live'), method: 'desktop.security.unknown', params: {} });
    assert.equal(response.error.code, 'protocol_method_unknown');
    return '错误 JSON、多行与超大帧均被 IPC 拒绝，随后实际 Host 对有效帧返回协议错误';
  });

  await check('SEC-04 script, popup, and navigation restrictions', async () => {
    const inline = await evaluate(`(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.__nativeSecurityInlineRan = true';
      document.head.appendChild(script);
      const popup = window.open('javascript:window.__nativeSecurityPopupRan=true');
      await new Promise(resolve => setTimeout(resolve, 200));
      return { inline: window.__nativeSecurityInlineRan === true, popup: window.__nativeSecurityPopupRan === true, returnedPopup: popup !== null, violations: window.__nativeSecurityViolations };
    })()`);
    assert.equal(inline.inline, false);
    assert.equal(inline.popup, false);
    assert.ok(inline.violations.some(item => item.directive.startsWith('script-src')));
    const count = BrowserWindow.getAllWindows().length;
    await evaluate(`window.open('https://example.invalid/','_blank')`);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(BrowserWindow.getAllWindows().length, count);
    await evaluate(`location.assign('https://example.invalid/'); true`).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(mainWindow.webContents.getURL(), security.APP_PAGE);
    return '内联脚本未执行、危险弹窗未创建，主页面导航仍停留在固定 app:// 页面';
  });

  await check('SEC-05 Host input guards and unmatched approval reply', async () => {
    const missingWorkspace = await requestHost({
      id: nextId('bad-workspace'),
      method: 'session.create',
      params: { projectRoot: join(workspaceRoot, 'missing-project'), workspaceOrigin: 'explicit' },
    });
    assert.equal(missingWorkspace.error.code, 'host_project_root_missing');

    const forgedOrigin = await requestHost({
      id: nextId('bad-origin'),
      method: 'session.create',
      params: { projectRoot: workspaceRoot, workspaceOrigin: 'forged' },
    });
    assert.equal(forgedOrigin.error.code, 'workspace_origin_unknown');

    const created = await requestHost({ id: nextId('create-session'), method: 'session.create', params: { projectRoot: workspaceRoot } });
    assert.equal(typeof created.result.sessionId, 'string');
    const invalidMode = await requestHost({
      id: nextId('bad-mode'),
      method: 'session.open',
      params: { sessionId: created.result.sessionId, projectRoot: workspaceRoot, mode: 'not-a-real-mode' },
    });
    assert.equal(invalidMode.error.code, 'mode_unknown');

    await evaluate(`window.liguleDesktop.sendHostFrame(${JSON.stringify(JSON.stringify({ id: 'unmatched-approval-test', result: { decision: 'allow' } }))})`);
    const stillResponsive = await requestHost({ id: nextId('after-unmatched'), method: 'desktop.security.unknown', params: {} });
    assert.equal(stillResponsive.error.code, 'protocol_method_unknown');
    return '实际 Host 拒绝不存在工作区、伪 workspaceOrigin 和未知 mode；未匹配的伪审批响应没有建立授权，后续 Host RPC 仍响应';
  });
}

async function cleanup() {
  try {
    const image = await mainWindow?.webContents.capturePage();
    if (image !== undefined) writeFileSync(join(evidenceRoot, 'native-security.png'), image.toPNG());
  } catch { reporterError = '真实窗口截图保存失败'; }
  try { if (secondWindow !== undefined && !secondWindow.isDestroyed()) secondWindow.destroy(); } catch {}
  try { if (host !== undefined) await host.stop(); } catch { reporterError = 'Host 停止失败'; }
  try { if (detachIpc !== undefined) detachIpc(); } catch { reporterError = 'IPC 清理失败'; }
  try { if (nativeServices !== undefined) nativeServices.dispose(); } catch { reporterError = 'NativeServices 清理失败'; }
  try { if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch {}
}

(async () => {
  let exitCode = 0;
  try {
    await createApplication();
    await runChecks();
    if (results.some(result => result.status === '失败')) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    const detail = error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'harness启动失败';
    note('HARNESS', '失败', detail);
  } finally {
    await cleanup();
    if (reporterError !== undefined) {
      exitCode = 1;
      note('EVIDENCE', '失败', reporterError);
    }
    try { await recordReport(exitCode); } catch { exitCode = 1; }
    process.exitCode = exitCode;
    app.quit();
  }
})();
