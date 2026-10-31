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

async function openAgentControlPanel() {
  assertReady();
  return await window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return null;
    };
    const waitForProject = () => wait(() => {
      const input = document.querySelector('.agent-control-panel .grant-basic-grid label:first-child input');
      return input && input.value.trim() !== '' ? input : null;
    }, 15_000);
    if (document.querySelector('.agent-control-panel') !== null) {
      if (await waitForProject() === null) throw new Error('native_feature_agent_control_project_not_loaded');
      return true;
    }
    const settings = await wait(() => [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
      .find(button => /^(设置|Settings)$/u.test(button.textContent?.trim() ?? '')), 30_000);
    if (settings === null) {
      const root = document.querySelector('#root');
      throw new Error('native_feature_settings_button_missing:' + JSON.stringify({
        readyState: document.readyState,
        rootMounted: root !== null && root.childElementCount > 0,
        rootChildren: root?.childElementCount ?? 0,
        bodyText: document.body.innerText.slice(0, 500),
        buttons: [...document.querySelectorAll('button')].slice(0, 20).map(button => ({
          text: button.textContent?.trim() ?? '',
          className: button.className,
          hasPopup: button.getAttribute('aria-haspopup'),
        })),
      }));
    }
    settings.click();
    const controlTab = await wait(() => [...document.querySelectorAll('.sheet-nav [role="tab"]')]
      .find(button => /外部控制|Agent Control/u.test(button.textContent ?? '')), 15_000);
    if (controlTab === null) throw new Error('native_feature_agent_control_tab_missing');
    controlTab.click();
    if (await wait(() => document.querySelector('.agent-control-panel')) === null) {
      throw new Error('native_feature_agent_control_panel_missing');
    }
    if (await waitForProject() === null) throw new Error('native_feature_agent_control_project_not_loaded');
    return true;
  })()`);
}

async function inspectAgentControlDefaults() {
  await openAgentControlPanel();
  return await window.webContents.executeJavaScript(`(async () => {
    const panel = document.querySelector('.agent-control-panel');
    const createDetails = panel.querySelector('.grant-create-fold');
    if (createDetails === null) throw new Error('native_feature_agent_control_create_step_missing');
    createDetails.open = true;
    const name = panel.querySelector('.grant-basic-grid label:nth-child(2) input');
    if (name === null) throw new Error('native_feature_agent_control_name_input_missing');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    valueSetter.call(name, 'Native defaults inspection');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('change', { bubbles: true }));
    const next = [...panel.querySelectorAll('.grant-actions button')].find(button => /继续.*能力|Continue: capabilities/u.test(button.textContent ?? ''));
    if (next === undefined || next.disabled) throw new Error('native_feature_agent_control_capabilities_step_unavailable');
    next.click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && panel.querySelector('.grant-config-grid') === null) await new Promise(resolve => setTimeout(resolve, 20));
    const selects = [...panel.querySelectorAll('.grant-config-grid select')];
    const result = {
      permission: selects.slice(0, 2).map(input => input.value),
      network: selects.slice(2, 4).map(input => input.value),
      policy: selects[4]?.value ?? null,
      allowedPolicies: [...panel.querySelectorAll('.grant-policies input[type="checkbox"]')]
        .filter(input => input.checked).map(input => input.parentElement.textContent.trim()),
      allowOperator: [...panel.querySelectorAll('.grant-confirmation input[type="checkbox"]')]
        .some(input => input.checked),
      expiresAt: '',
    };
    const continueLimits = [...panel.querySelectorAll('.grant-actions button')].find(button => /继续.*风险|Continue: risk review/u.test(button.textContent ?? ''));
    if (continueLimits === undefined || continueLimits.disabled) throw new Error('native_feature_agent_control_default_limits_step_unavailable');
    continueLimits.click();
    while (Date.now() < deadline && panel.querySelector('.grant-lifetime-card input[type="datetime-local"]') === null) await new Promise(resolve => setTimeout(resolve, 20));
    result.expiresAt = panel.querySelector('input[type="datetime-local"]')?.value ?? '';
    const back = [...panel.querySelectorAll('.grant-actions button')].find(button => /返回.*能力|Back: capabilities/u.test(button.textContent ?? ''));
    back?.click();
    while (Date.now() < deadline && panel.querySelector('.grant-config-grid') === null) await new Promise(resolve => setTimeout(resolve, 20));
    const clear = [...panel.querySelectorAll('.grant-actions button')].find(button => /清除草稿|Clear draft/u.test(button.textContent ?? ''));
    clear?.click();
    return result;
  })()`);
}

async function createAndRevokeAgentControlGrant() {
  await openAgentControlPanel();
  return await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 20_000;
    const wait = async predicate => {
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return null;
    };
    const panel = document.querySelector('.agent-control-panel');
    const createDetails = panel.querySelector('.grant-create-fold');
    if (createDetails === null) throw new Error('native_feature_agent_control_create_step_missing');
    createDetails.open = true;
    const name = panel.querySelector('.grant-basic-grid label:nth-child(2) input');
    if (name === null) throw new Error('native_feature_agent_control_name_input_missing');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    valueSetter.call(name, 'Native Agent Control test');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('change', { bubbles: true }));
    const nextBasics = () => [...panel.querySelectorAll('.grant-actions button')]
      .find(button => /继续.*能力|Continue: capabilities/u.test(button.textContent ?? ''));
    if (nextBasics()?.disabled !== false) throw new Error('native_feature_agent_control_capabilities_step_unavailable');
    nextBasics().click();
    const stepDeadline = Date.now() + 2_000;
    while (Date.now() < stepDeadline && panel.querySelector('.grant-config-grid') === null) await new Promise(resolve => setTimeout(resolve, 20));
    const selects = [...panel.querySelectorAll('.grant-config-grid select')];
    const selectValue = (select, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    selectValue(selects[1], 'full-access');
    selectValue(selects[3], 'unrestricted');
    const createButton = () => [...panel.querySelectorAll('.grant-actions button')]
      .find(button => /创建授权|Create grant/u.test(button.textContent ?? ''));
    const continueLimits = () => [...panel.querySelectorAll('.grant-actions button')]
      .find(button => /继续.*风险|Continue: risk review/u.test(button.textContent ?? ''));
    if (continueLimits()?.disabled !== true) throw new Error('native_feature_agent_control_high_limits_were_not_confirmed');
    const riskChecks = await wait(() => {
      const items = [...panel.querySelectorAll('.grant-risk input[type="checkbox"]')];
      return items.length === 3 ? items : null;
    });
    if (riskChecks === null) {
      const currentRiskChecks = [...panel.querySelectorAll('.grant-risk input[type="checkbox"]')];
      const descriptions = currentRiskChecks.map(input => input.closest('label')?.textContent.trim() ?? '');
      throw new Error('native_feature_agent_control_separate_confirmations_missing:' + JSON.stringify(descriptions));
    }
    const confirmationBy = (pattern) => [...panel.querySelectorAll('.grant-risk input[type="checkbox"]')]
      .find(input => pattern.test(input.closest('label')?.textContent ?? ''));
    const confirmations = [
      ['full_access', /(?:全部资源|everything available to this OS account)/iu],
      ['partial_workspace_write', /(?:部分隔离限制|partial-isolation limits)/iu],
      ['unrestricted_network', /(?:不受限网络访问|unrestricted network access)/iu],
    ];
    const setRiskConfirmation = async (name, pattern, checked) => {
      const checkbox = confirmationBy(pattern);
      if (checkbox === undefined) throw new Error('native_feature_agent_control_confirmation_missing:' + name);
      checkbox.click();
      if (await wait(() => confirmationBy(pattern)?.checked === checked) === null) {
        throw new Error('native_feature_agent_control_confirmation_not_applied:' + name + ':' + checked);
      }
    };
    for (const [name, pattern] of confirmations) {
      await setRiskConfirmation(name, pattern, true);
      if (continueLimits()?.disabled !== true) throw new Error('native_feature_agent_control_single_confirmation_was_enough:' + name);
      await setRiskConfirmation(name, pattern, false);
    }
    for (let index = 0; index < confirmations.length; index += 1) {
      const [name, pattern] = confirmations[index];
      await setRiskConfirmation(name, pattern, true);
      if (index < confirmations.length - 1 && continueLimits()?.disabled !== true) {
        throw new Error('native_feature_agent_control_confirmation_was_enough_early:' + name);
      }
    }
    if (await wait(() => continueLimits() && !continueLimits().disabled) === null) throw new Error('native_feature_agent_control_all_limit_confirmations_not_applied');
    continueLimits().click();
    const trustCheck = await wait(() => panel.querySelector('.grant-lifetime-card .grant-risk input[type="checkbox"]'));
    if (trustCheck === null) throw new Error('native_feature_agent_control_workspace_confirmation_missing');
    trustCheck.click();
    if (await wait(() => trustCheck.checked && createButton()?.disabled === false) === null) throw new Error('native_feature_agent_control_workspace_confirmation_not_applied');
    const create = createButton();
    if (create === undefined || create.disabled) throw new Error('native_feature_agent_control_create_disabled');
    create.click();
    const row = await wait(() => [...panel.querySelectorAll('.grant-inspector')]
      .find(item => item.textContent.includes('Native Agent Control test')));
    if (row === null) throw new Error('native_feature_agent_control_grant_missing');
    const details = row.querySelector('details.catalog-fold');
    if (details === null) throw new Error('native_feature_agent_control_grant_details_missing');
    details.open = true;
    const detailText = details.innerText ?? details.textContent ?? '';
    const sourceDisplayed = /(?:来源: 可信界面创建|Source: Trusted UI)/u.test(detailText);
    if (!sourceDisplayed) throw new Error('native_feature_agent_control_source_not_displayed:' + detailText);
    const revoke = [...row.querySelectorAll('button.danger')]
      .find(button => /撤销授权|Revoke grant/u.test(button.textContent ?? ''));
    if (revoke === undefined) throw new Error('native_feature_agent_control_revoke_button_missing');
    revoke.click();
    const confirm = await wait(() => document.querySelector('.confirm-actions button.danger'));
    if (confirm === null) throw new Error('native_feature_agent_control_revoke_confirmation_missing');
    confirm.click();
    if (await wait(() => /已撤销|Revoked/u.test(row.textContent ?? '')) === null) {
      throw new Error('native_feature_agent_control_grant_not_revoked');
    }
    const closeSettings = [...document.querySelectorAll('.sheet-head button.icon-button')]
      .find(button => /关闭设置|Close settings/u.test(button.getAttribute('aria-label') ?? ''));
    if (closeSettings === undefined) throw new Error('native_feature_agent_control_settings_close_missing');
    closeSettings.click();
    if (await wait(() => document.querySelector('.agent-control-panel') === null) === null) {
      throw new Error('native_feature_agent_control_settings_still_open');
    }
    return { created: true, revoked: true, separateConfirmations: true, sourceDisplayed };
  })()`);
}

async function dispatch(command) {
  switch (command.action) {
    case 'save-export-path':
      return await invokePreload('saveExportPath', command.defaultName);
    case 'open-workspace-picker':
      assertReady();
      return await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 15_000;
        const waitForChoice = async () => {
          while (Date.now() < deadline) {
            const choice = document.querySelector('button.workspace-choice');
            if (choice && !choice.disabled) return choice;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return null;
        };
        let button = await waitForChoice();
        if (button === null) {
          const newConversation = document.querySelector('button.new-run');
          if (newConversation === null) throw new Error('native_feature_new_conversation_button_missing');
          newConversation.click();
          button = await waitForChoice();
        }
        if (button === null) throw new Error('native_feature_workspace_choice_unavailable:' + JSON.stringify({
          title: document.querySelector('#session-title')?.textContent?.trim() ?? '',
          newConversation: document.querySelector('button.new-run')?.outerHTML ?? null,
          settingsReady: document.querySelector('button.workspace-choice')?.outerHTML ?? null,
        }));
        if (!document.querySelector('.workspace-picker')) button.click();
        while (Date.now() < deadline) {
          if (document.querySelector('.workspace-picker')) return true;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('native_feature_workspace_picker_missing:' + document.body.innerText.slice(-1200));
      })()`);
    case 'click-workspace-browse':
      assertReady();
      return await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const button = [...document.querySelectorAll('.workspace-picker form button[type="button"]')]
            .find(item => /浏览|Browse/u.test(item.textContent ?? ''));
          if (button && !button.disabled) { button.click(); return true; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const picker = document.querySelector('.workspace-picker');
        throw new Error('native_feature_workspace_browse_unavailable:' + JSON.stringify({
          pickerOpen: picker !== null,
          text: picker?.innerText ?? document.body.innerText.slice(-1200),
          buttons: [...(picker?.querySelectorAll('button') ?? [])].map(button => ({ text: button.textContent.trim(), disabled: button.disabled, type: button.type })),
        }));
      })()`);
    case 'inspect-agent-control-defaults':
      return await inspectAgentControlDefaults();
    case 'create-agent-control-grant':
      return await createAndRevokeAgentControlGrant();
    case 'list-agent-control-grants':
      return await requestHost('agent-control.list', {});
    case 'workspace-choice-path':
      assertReady();
      return await window.webContents.executeJavaScript(`document.querySelector('button.workspace-choice')?.title ?? ''`);
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
  const selectWorkspaceDirectory = native.selectWorkspaceDirectory.bind(native);
  native.selectWorkspaceDirectory = defaultPath => {
    send({ type: 'workspace-directory-requested' });
    return selectWorkspaceDirectory(defaultPath).then(selectedPath => {
      send({ type: 'workspace-directory-completed', selectedPath });
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
