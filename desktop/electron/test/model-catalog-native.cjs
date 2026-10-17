const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');

const repositoryRoot = process.env.LIGULE_MODEL_CATALOG_REPOSITORY;
const workspace = process.env.LIGULE_MODEL_CATALOG_WORKSPACE;
const evidenceRoot = process.env.LIGULE_MODEL_CATALOG_EVIDENCE;
const shotsRoot = process.env.LIGULE_MODEL_CATALOG_SHOTS;
const userData = process.env.LIGULE_MODEL_CATALOG_USER_DATA;
const endpoint = process.env.LIGULE_MODEL_CATALOG_ENDPOINT;
if ([repositoryRoot, workspace, evidenceRoot, shotsRoot, userData, endpoint].some(value => typeof value !== 'string' || !path.isAbsolute(value) && value !== endpoint)) throw new Error('model_catalog_native_paths_invalid');

const desktopRoot = path.join(repositoryRoot, 'desktop');
const compiledRoot = path.join(desktopRoot, 'electron', 'dist');
const security = require(path.join(compiledRoot, 'security.js'));
const { registerAppScheme, installResourceProtocol, createApplicationWindow } = require(path.join(compiledRoot, 'secure-window.js'));
const { NativeServices } = require(path.join(compiledRoot, 'native.js'));
const { HostController } = require(path.join(compiledRoot, 'host.js'));
const { resolveHostRuntime } = require(path.join(compiledRoot, 'runtime.js'));
const { registerDesktopIpc } = require(path.join(compiledRoot, 'ipc.js'));
const results = [];
let actualLocale;
let window;
let native;
let host;
let detachIpc;
let observedCsp;
let phase = 'startup';
let diagnosticSnapshot;
let rpcId = 0;
const environmentKey = 'LIGULE_MODEL_CATALOG_KEY';
const verifyReopen = process.env.LIGULE_MODEL_CATALOG_VERIFY_REOPEN === '1';

function sendResult(name, status, detail) {
  const result = { name, status, detail };
  results.push(result);
  console.log(JSON.stringify(result));
}

function evaluate(source) {
  assert.ok(window && !window.isDestroyed(), 'native_window_unavailable');
  return window.webContents.executeJavaScript(source, true);
}

async function waitFor(source, code, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(source);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

async function click(source) {
  const done = await evaluate(source);
  if (!done) throw new Error('model_catalog_click_target_missing');
}

async function typeFocusedInput(source, value) {
  window.focus();
  const focused = await evaluate(source);
  if (!focused) throw new Error('model_catalog_input_focus_failed');
  const numberField = await evaluate(`document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'number'`);
  if (numberField) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
    for (let index = 0; index < 32; index += 1) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
    await waitFor(`document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'number' && document.activeElement.value === ''`, 'model_catalog_number_input_clear_failed');
  } else {
    await evaluate(`document.activeElement.select(); true`);
  }
  await window.webContents.insertText(String(value));
}

async function fillModelCell(rowIndex, columnIndex, value) {
  const encodedValue = JSON.stringify(String(value));
  await waitFor(`Boolean(document.querySelectorAll('.model-config-table tbody tr')[${rowIndex}]?.querySelectorAll('input[aria-label]')[${columnIndex}])`, 'model_catalog_input_missing');
  await typeFocusedInput(`(() => {
    const input = document.querySelectorAll('.model-config-table tbody tr')[${rowIndex}]?.querySelectorAll('input[aria-label]')[${columnIndex}];
    if (!input) return false;
    input.focus();
    return true;
  })()`, value);
  await waitFor(`document.querySelectorAll('.model-config-table tbody tr')[${rowIndex}]?.querySelectorAll('input[aria-label]')[${columnIndex}]?.value === ${encodedValue}`, 'model_catalog_input_value_not_adopted');
}

async function fillLabel(prefix, value) {
  const encodedPrefix = JSON.stringify(prefix);
  await waitFor(`!![...document.querySelectorAll('.service-form label')].find(item => new RegExp(${encodedPrefix}, 'iu').test(item.childNodes[0]?.textContent?.trim() ?? ''))`, `model_catalog_label_input_missing:${prefix}`);
  await typeFocusedInput(`(() => {
    const label = [...document.querySelectorAll('.service-form label')].find(item => new RegExp(${encodedPrefix}, 'iu').test(item.childNodes[0]?.textContent?.trim() ?? ''));
    const input = label?.querySelector('input');
    if (!input) return false;
    input.focus();
    return true;
  })()`, value);
  const encodedValue = JSON.stringify(String(value));
  await waitFor(`[...document.querySelectorAll('.service-form label')].find(item => new RegExp(${encodedPrefix}, 'iu').test(item.childNodes[0]?.textContent?.trim() ?? ''))?.querySelector('input')?.value === ${encodedValue}`, `model_catalog_label_value_not_adopted:${prefix}`);
}

async function clickButtonText(pattern, within = 'document') {
  const encoded = JSON.stringify(pattern);
  const clicked = await evaluate(`(() => {
    const root = ${within};
    const button = [...root.querySelectorAll('button')].find(item => new RegExp('^(?:' + ${encoded} + ')$', 'iu').test((item.textContent ?? '').trim()));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`model_catalog_button_missing:${pattern}`);
}

async function clickRowButton(serviceName, pattern) {
  const name = JSON.stringify(serviceName);
  const matcher = JSON.stringify(pattern);
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.service-row')].find(item => item.textContent?.includes(${name}));
    const button = [...(row?.querySelectorAll('button') ?? [])].find(item => new RegExp('^(?:' + ${matcher} + ')$', 'iu').test((item.textContent ?? '').trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`model_catalog_row_button_missing:${serviceName}:${pattern}`);
}

async function rows() {
  return evaluate(`[...document.querySelectorAll('.model-config-table tbody tr')].flatMap(tr => {
    const values = [...tr.querySelectorAll('input')];
    if (values.length < 4) return [];
    return [{ id: values[0].value, name: values[1].value, context: values[2].value, output: values[3].value }];
  })`);
}

async function saveService() {
  await clickButtonText('Save service|保存服务');
  await waitFor(`!document.querySelector('.service-form') && Boolean(document.querySelector('.service-row'))`, 'model_catalog_save_did_not_return_to_list', 20_000);
}

async function selectModelViaPicker(id, name) {
  await waitFor(`Boolean(document.querySelector('button.composer-choice')) && !document.querySelector('button.composer-choice').disabled`, 'model_picker_trigger_not_ready');
  await evaluate(`document.querySelector('button.composer-choice').focus(); true`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(`Boolean(document.querySelector('.model-picker'))`, 'model_picker_not_open');
  const encodedId = JSON.stringify(id);
  const encodedName = JSON.stringify(name);
  await waitFor(`Boolean([...document.querySelectorAll('.model-option')].find(item => item.getAttribute('title') === ${encodedId} && item.textContent?.includes(${encodedName})))`, 'model_picker_option_not_loaded');
  const focused = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.model-option')].find(node => node.getAttribute('title') === ${encodedId} && node.textContent?.includes(${encodedName}));
    if (!item) return false;
    item.focus();
    return document.activeElement === item;
  })()`);
  assert.equal(focused, true, 'model_picker_option_could_not_receive_focus');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(`document.querySelector('button.composer-choice')?.textContent?.includes(${encodedName})`, 'selected_model_display_name_not_shown');
}

async function openEditor(name) {
  const expectedName = JSON.stringify(name);
  await waitFor(`Boolean([...document.querySelectorAll('.service-row')].find(item => item.textContent?.includes(${expectedName})))`, 'model_catalog_service_row_not_loaded');
  await clickRowButton(name, 'Edit|编辑');
  await waitFor(`Boolean(document.querySelector('.service-form'))`, 'model_catalog_editor_did_not_open');
}

async function openModelSettings() {
  await click(`(() => { const button = [...document.querySelectorAll('button.entry')].find(item => /设置|Settings/u.test(item.textContent ?? '')); if (!button) return false; button.click(); return true; })()`);
  await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`, 'settings_dialog_not_open');
  await click(`(() => { const tab = [...document.querySelectorAll('[role="tab"]')].find(item => /模型服务|Model services/u.test(item.textContent ?? '')); if (!tab) return false; tab.click(); return true; })()`);
  await waitFor(`Boolean(document.querySelector('.model-settings'))`, 'model_settings_not_open');
}

async function openNewService() {
  await waitFor(`document.querySelector('button.add-service') && !document.querySelector('button.add-service').disabled`, 'model_catalog_add_service_not_ready');
  await clickButtonText('添加服务|Add service');
  await waitFor(`Boolean(document.querySelector('.service-form'))`, 'model_catalog_new_service_form_missing');
  await fillLabel('服务名称|Service name', 'Catalog one');
  await fillLabel('服务地址|Base URL', endpoint);
  await click(`(() => { const summary = [...document.querySelectorAll('.service-form summary')].find(item => /凭据引用与保存位置|Credential reference and save location/u.test(item.textContent ?? '')); if (!summary) return false; summary.click(); return true; })()`);
  await fillLabel('环境变量名|Environment variable', environmentKey);
}

async function addRow(id, name, context, output, index) {
  const previousCount = (await rows()).length;
  await clickButtonText('添加模型|Add model');
  const rowIndex = index ?? previousCount;
  if (rowIndex !== previousCount) throw new Error('model_catalog_row_index_changed_during_add');
  await waitFor(`document.querySelectorAll('.model-config-table tbody tr input[aria-label]').length >= ${(previousCount + 1) * 4}`, 'new_model_row_not_rendered');
  await fillModelCell(rowIndex, 0, id);
  await fillModelCell(rowIndex, 1, name);
  if (context !== '') await fillModelCell(rowIndex, 2, context);
  if (output !== '') await fillModelCell(rowIndex, 3, output);
}

async function fixtureControl(pathname, payload) {
  const response = pathname === 'state'
    ? await fetch(`${endpoint.replace(/\/v1$/u, '')}/control/state`)
    : await fetch(`${endpoint.replace(/\/v1$/u, '')}/control/${pathname}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
  if (!response.ok) throw new Error(`fixture_control_failed:${pathname}`);
  return response.json();
}

async function waitFixtureDiscovery(count, status) {
  const deadline = Date.now() + 25_000;
  let state;
  while (Date.now() < deadline) {
    state = await fixtureControl('state');
    if (state.discoveryRequests.length > count) {
      const request = state.discoveryRequests.at(-1);
      assert.equal(request.authorized, true);
      assert.equal(request.status, status);
      return request;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fixture_model_discovery_timeout:${state?.discoveryRequests.length ?? 0}`);
}

async function hostCall(method, params = {}) {
  const id = `model-catalog-rpc-${++rpcId}`;
  const frame = JSON.stringify({ id, method, params });
  const result = await evaluate(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const item = window.__modelCatalogFrames.find(frame => frame.id === ${JSON.stringify(id)});
      if (item) return item;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('model_catalog_config_snapshot_timeout');
  })()`);
  if (result.error) throw new Error(result.error.code ?? 'model_catalog_config_get_failed');
  return result.result;
}

function preferencesText(settings, text) {
  const draftValues = Object.values(settings.drafts ?? {}).flatMap(items => Object.values(items));
  const queueValues = Object.values(settings.queued ?? {}).flatMap(items => Object.values(items).flatMap(value => Array.isArray(value) ? value : []));
  return [...draftValues, ...queueValues].some(value => value.includes(text));
}

async function waitForPreferencesText(...texts) {
  const deadline = Date.now() + 20_000;
  let document;
  while (Date.now() < deadline) {
    document = await hostCall('prefs.read');
    if (texts.every(text => preferencesText(document.settings, text))) return document;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`model_catalog_preferences_text_not_saved:${texts.join(',')}`);
}

async function configSnapshot() { return hostCall('config.get'); }

async function activeSessionId() {
  return await waitFor(`window.__modelCatalogFrames.find(frame => typeof frame.result?.sessionId === 'string')?.result.sessionId`, 'session_create_response_missing');
}

async function waitFixtureRequest(count) {
  const deadline = Date.now() + 25_000;
  let state;
  while (Date.now() < deadline) {
    state = await fixtureControl('state');
    if (state.requests.length > count) return state.requests.at(-1);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fixture_model_request_timeout:${state?.requests.length ?? 0}`);
}

async function waitSessionIdle(sessionId) {
  const deadline = Date.now() + 20_000;
  let status;
  while (Date.now() < deadline) {
    status = await hostCall('status.get', { sessionId });
    if (status.running === false) return status;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('model_catalog_session_remained_running');
}

async function screenshot(name) {
  const image = await window.webContents.capturePage();
  writeFileSync(path.join(shotsRoot, name), image.toPNG());
}

function fileDigest() {
  const configPath = path.join(process.env.LIGULE_HOME, 'config.toml');
  try { return crypto.createHash('sha256').update(readFileSync(configPath)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function createApp() {
  registerAppScheme();
  app.setPath('userData', userData);
  app.enableSandbox();
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const assets = path.join(desktopRoot, 'frontend', 'dist');
  const iconPath = path.join(desktopRoot, 'assets', 'app-icon.png');
  installResourceProtocol(assets);
  session.defaultSession.webRequest.onCompleted({ urls: ['app://ligule/*'] }, details => {
    if (details.url === security.APP_PAGE && details.resourceType === 'mainFrame') {
      const headers = details.responseHeaders ?? {};
      const item = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-security-policy');
      observedCsp = item?.[1]?.join('; ') ?? '';
    }
  });
  window = createApplicationWindow({ preload: path.join(compiledRoot, 'preload.js'), iconPath, page: security.APP_PAGE, development: false });
  window.setSize(1360, 940);
  native = new NativeServices({ window, onQuitRequested: () => {}, onNotificationOpen: () => {},
    onFault: code => { if (!window.isDestroyed()) window.webContents.send('ligule:host-log', code); }, iconPath });
  const runtime = resolveHostRuntime({ repositoryRoot, node: path.join(desktopRoot, 'vendor', 'node', 'node.exe'), environment: process.env });
  host = new HostController({ ...runtime, hostEntry: runtime.hostEntry, entry: path.join(compiledRoot, 'host-entry.js'), cwd: workspace,
    onFrame: frame => { if (window && !window.isDestroyed()) window.webContents.send('ligule:host-frame', frame); },
    onFault: fault => { if (window && !window.isDestroyed()) window.webContents.send('ligule:host-fault', `host_closed:${fault}`); } });
  detachIpc = registerDesktopIpc(window, security.APP_PAGE, host, native, async () => {});
  await host.start();
  await window.loadURL(security.APP_PAGE);
  window.show();
  window.focus();
  await waitFor(`Boolean(window.liguleDesktop)`, 'secure_preload_unavailable');
  await evaluate(`window.__modelCatalogFrames = []; window.liguleDesktop.onHostFrame(raw => { try { window.__modelCatalogFrames.push(JSON.parse(raw)); } catch {} }); true`);
  await waitFor(`Boolean(document.querySelector('.new-run')) && Boolean(document.querySelector('button.entry'))`, 'application_ui_not_ready', 20_000);
  await waitFor(`Boolean(document.querySelector('textarea.composer-input')) && !document.querySelector('textarea.composer-input').readOnly`, 'application_settings_not_ready', 20_000);
  actualLocale = await waitFor(`['zh-CN', 'en'].includes(document.documentElement.lang) ? document.documentElement.lang : false`, 'application_locale_not_ready');
}

async function runScenarios() {
  const windowPrefs = window.webContents.getLastWebPreferences();
  assert.equal(windowPrefs.sandbox, true);
  assert.equal(windowPrefs.contextIsolation, true);
  assert.equal(windowPrefs.nodeIntegration, false);
  assert.ok(observedCsp?.includes("default-src 'self'"));

  phase = 'settings_and_manual_model';
  await openModelSettings();
  await openNewService();
  await addRow('model-a', 'Alpha display', '128000', '16384', 0);
  await screenshot('model-catalog-normal-window.png');
  await window.setSize(760, 940);
  await waitFor(`Boolean(document.querySelector('.model-table-scroll'))`, 'model_catalog_table_scroll_missing');
  await screenshot('model-catalog-narrow-window.png');
  const narrow = await evaluate(`(() => { const box = document.querySelector('.model-table-scroll'); return { clientWidth: box.clientWidth, scrollWidth: box.scrollWidth, overflowX: getComputedStyle(box).overflowX }; })()`);
  assert.ok(narrow.scrollWidth > narrow.clientWidth, 'narrow_model_table_must_scroll_horizontally');
  await window.setSize(1360, 940);
  sendResult('native_model_table_layout_and_manual_row', '通过', `真实 Electron 正常窗口与窄窗口截图已写出；窄表格 scrollWidth=${narrow.scrollWidth}、clientWidth=${narrow.clientWidth}；手动模型含 name/context/output`);

  phase = 'discovery_preserves_existing_and_failure';
  await clickButtonText('Fetch and add models|获取可用模型并填入');
  await waitFor(`document.querySelector('.model-settings .inline-notice[role="alert"] details code')?.textContent === 'model_discovery_credential_unbound'`, 'unbound_discovery_not_rejected');
  const unboundCode = await evaluate(`document.querySelector('.model-settings .inline-notice[role="alert"] details code')?.textContent ?? ''`);
  let catalogRows = await rows();
  assert.deepEqual(catalogRows, [{ id: 'model-a', name: 'Alpha display', context: '128000', output: '16384' }]);
  sendResult('native_discovery_requires_saved_service_binding', '通过', `未保存服务的目录请求被 Host 拒绝（${unboundCode}），手动模型参数仍保留；随后服务经 UI 保存建立用户层端点/环境变量引用绑定`);

  await saveService();
  await openEditor('Catalog one');
  const beforeBoundDiscovery = (await fixtureControl('state')).discoveryRequests.length;
  await clickButtonText('Fetch and add models|获取可用模型并填入');
  await waitFixtureDiscovery(beforeBoundDiscovery, 200);
  await waitFor(`document.querySelectorAll('.model-config-table tbody tr input[aria-label]').length >= 8`, 'model_discovery_did_not_add_ids');
  catalogRows = await rows();
  assert.deepEqual(catalogRows.map(item => item.id), ['model-a', 'model-b']);
  assert.equal(catalogRows[0].name, 'Alpha display');
  assert.equal(catalogRows[0].context, '128000');
  assert.equal(catalogRows[0].output, '16384');
  await fixtureControl('discovery', { failure: true });
  const beforeDiscoveryFailure = (await fixtureControl('state')).discoveryRequests.length;
  await clickButtonText('Fetch and add models|获取可用模型并填入');
  await waitFixtureDiscovery(beforeDiscoveryFailure, 503);
  await waitFor(`document.querySelector('.model-settings .inline-notice[role="alert"] details code')?.textContent === 'model_discovery_failed'`, 'discovery_failure_not_reported');
  catalogRows = await rows();
  assert.deepEqual(catalogRows.map(({ id, name, context, output }) => ({ id, name, context, output })), [
    { id: 'model-a', name: 'Alpha display', context: '128000', output: '16384' },
    { id: 'model-b', name: '', context: '', output: '' },
  ]);
  await fixtureControl('discovery', { failure: false });
  const beforeDiscoveryRetry = (await fixtureControl('state')).discoveryRequests.length;
  await clickButtonText('Fetch and add models|获取可用模型并填入');
  await waitFixtureDiscovery(beforeDiscoveryRetry, 200);
  await waitFor(`Boolean(document.querySelector('.inline-notice[role="status"]'))`, 'discovery_retry_status_missing');
  await saveService();
  sendResult('native_model_discovery_merge_and_failure_retention', '通过', '真实 Host 的 loopback GET /models 返回 model-a/model-b；获取成功保留 A 的手动参数；503 后 A/B 数据仍在，重试后通过界面保存');

  phase = 'edit_delete_and_native_persistence';
  let catalog = await configSnapshot();
  let first = catalog.services.find(service => service.name === 'Catalog one');
  assert.ok(first, 'saved_service_not_visible_through_host');
  await openEditor('Catalog one');
  catalogRows = await rows();
  assert.deepEqual(catalogRows.map(item => item.id), ['model-a', 'model-b']);
  const deleteAccessibleName = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.model-config-table tbody tr')].find(item => item.querySelector('input')?.value === 'model-b');
    const button = row?.querySelector('button[aria-label]');
    if (!button) return false;
    button.focus();
    return document.activeElement === button ? button.getAttribute('aria-label') : false;
  })()`);
  assert.equal(typeof deleteAccessibleName, 'string', 'model_delete_button_accessible_name_or_focus_missing');
  assert.notEqual(deleteAccessibleName, '');
  await evaluate(`(() => {
    window.__modelCatalogDeleteKeys = [];
    const button = document.activeElement;
    button.addEventListener('keydown', event => window.__modelCatalogDeleteKeys.push({ type: 'keydown', key: event.key, code: event.code }));
    button.addEventListener('keyup', event => window.__modelCatalogDeleteKeys.push({ type: 'keyup', key: event.key, code: event.code }));
    button.addEventListener('click', () => window.__modelCatalogDeleteKeys.push({ type: 'click' }));
    return true;
  })()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const deleteKeyEvents = await evaluate(`window.__modelCatalogDeleteKeys ?? []`);
  await waitFor(`![...document.querySelectorAll('.model-config-table tbody tr')].some(row => row.querySelector('input')?.value === 'model-b')`, 'keyboard_model_delete_did_not_activate');
  await addRow('model-c', 'Gamma display', '64000', '1024', 1);
  await saveService();
  catalog = await configSnapshot();
  first = catalog.services.find(service => service.name === 'Catalog one');
  assert.deepEqual(first.models, ['model-a', 'model-c']);
  assert.deepEqual(first.modelSettings.find(item => item.id === 'model-a'), { id: 'model-a', name: 'Alpha display', contextTokens: 128000, outputTokens: 16384 });
  sendResult('native_model_add_delete_and_keyboard_accessibility', '通过', `B 行的可访问删除按钮以真实窗口 Space 键激活（${JSON.stringify(deleteKeyEvents)}）；界面手动添加 C，真实 config.set 保存并经 Host 读回 A/C`);

  phase = 'invalid_inputs_never_modify_disk';
  await openEditor('Catalog one');
  const beforeInvalid = fileDigest();
  await fillModelCell(0, 2, '9007199254740992');
  await clickButtonText('Save service|保存服务');
  await waitFor(`Boolean(document.querySelector('[role="alert"]'))`, 'unsafe_integer_not_reported');
  assert.equal(await evaluate(`document.querySelector('.service-form') !== null`), true);
  assert.equal(fileDigest(), beforeInvalid, 'unsafe_integer_changed_user_config');
  await fillModelCell(0, 2, '128000');
  await fillModelCell(0, 3, '128001');
  await clickButtonText('Save service|保存服务');
  await waitFor(`Boolean(document.querySelector('[role="alert"]'))`, 'output_context_invalid_not_reported');
  assert.equal(fileDigest(), beforeInvalid, 'output_exceeding_context_changed_user_config');
  await fillModelCell(0, 3, '16384');
  await fillModelCell(1, 0, 'model-a');
  await clickButtonText('Save service|保存服务');
  await waitFor(`Boolean(document.querySelector('[role="alert"]'))`, 'duplicate_model_id_not_reported');
  assert.equal(fileDigest(), beforeInvalid, 'duplicate_model_id_changed_user_config');
  await fillModelCell(1, 0, 'model-c');
  await fillModelCell(1, 3, '1024');
  sendResult('native_invalid_models_do_not_write_config', '通过', 'unsafe integer、outputTokens > contextTokens、重复模型 ID 均显示界面错误；用户配置 SHA-256 在每次拒绝前后未变化');

  phase = 'unsaved_leave_prompt';
  await fillLabel('服务名称|Service name', 'Catalog one draft');
  await clickButtonText('Back to services|返回列表');
  await waitFor(`Boolean(document.querySelector('[role="dialog"]')) && /Discard unsaved changes|放弃未保存的修改/u.test(document.body.innerText)`, 'unsaved_leave_prompt_missing');
  await screenshot('model-catalog-unsaved-leave-prompt.png');
  await clickButtonText('Keep editing|继续编辑');
  assert.equal(await evaluate(`document.querySelector('.service-form') !== null`), true);
  await clickButtonText('Back to services|返回列表');
  await waitFor(`/Discard unsaved changes|放弃未保存的修改/u.test(document.body.innerText)`, 'unsaved_leave_prompt_missing_on_retry');
  await clickButtonText('Discard changes|放弃这些修改');
  await waitFor(`!document.querySelector('.service-form')`, 'unsaved_leave_did_not_close_editor');
  assert.equal(fileDigest(), beforeInvalid, 'discarding_edits_changed_user_config');
  sendResult('native_unsaved_model_editor_leave_prompt', '通过', '返回服务列表时显示未保存提示；Stay 保持表单，Leave 丢弃草稿且磁盘摘要未改变');

  phase = 'service_identity_isolation_and_default_override';
  await openNewService();
  await fillLabel('服务名称|Service name', 'Catalog two');
  await addRow('model-a', 'Separate Alpha', '96000', '4096', 0);
  await saveService();
  catalog = await configSnapshot();
  const second = catalog.services.find(service => service.name === 'Catalog two');
  assert.ok(second && second.id !== first.id);
  assert.deepEqual(second.modelSettings[0], { id: 'model-a', name: 'Separate Alpha', contextTokens: 96000, outputTokens: 4096 });
  await openEditor('Catalog one');
  await fillModelCell(1, 2, '');
  await fillModelCell(1, 3, '');
  await saveService();
  catalog = await configSnapshot();
  first = catalog.services.find(service => service.name === 'Catalog one');
  assert.deepEqual(first.models, ['model-a', 'model-c']);
  assert.equal(first.modelSettings.some(item => item.id === 'model-c' && (item.contextTokens !== undefined || item.outputTokens !== undefined)), false);
  const other = catalog.services.find(service => service.name === 'Catalog two');
  assert.deepEqual(other.modelSettings[0], { id: 'model-a', name: 'Separate Alpha', contextTokens: 96000, outputTokens: 4096 });
  sendResult('native_service_model_settings_isolation_and_default_fallback', '通过', '两个服务各自保存同一模型 ID 的不同名称/context/output；清空服务一 C 的 token override 后字段缺省，服务二 A 参数保持不变');

  phase = 'saved_catalog_reopen_and_display_names';
  await click(`(() => { const close = document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]'); if (!close) return false; close.click(); return true; })()`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'settings_dialog_did_not_close');
  await openModelSettings();
  await waitFor(`[...document.querySelectorAll('.service-default-select option')].some(option => option.textContent.includes('Alpha display')) && [...document.querySelectorAll('.service-default-select option')].some(option => option.textContent.includes('Separate Alpha'))`, 'default_model_choices_do_not_show_display_names');
  await openEditor('Catalog one');
  catalogRows = await rows();
  assert.deepEqual(catalogRows.map(item => item.id), ['model-a', 'model-c']);
  assert.equal(catalogRows.find(item => item.id === 'model-c').context, '');
  assert.equal(catalogRows.find(item => item.id === 'model-c').output, '');
  await clickButtonText('Back to services|返回列表');
  await openEditor('Catalog two');
  catalogRows = await rows();
  assert.deepEqual(catalogRows, [{ id: 'model-a', name: 'Separate Alpha', context: '96000', output: '4096' }]);
  await clickButtonText('Back to services|返回列表');
  await openEditor('Catalog one');
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await screenshot('model-catalog-final-table.png');
  catalogRows = await rows();
  assert.deepEqual(catalogRows.map(item => item.id), ['model-a', 'model-c']);
  assert.ok(await evaluate(`Boolean([...document.querySelectorAll('.service-form label input')].some(input => input.value === ${JSON.stringify(endpoint)}))`), 'final_table_endpoint_not_visible');
  await clickButtonText('Back to services|返回列表');
  await click(`(() => { const close = document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]'); if (!close) return false; close.click(); return true; })()`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'settings_dialog_did_not_close_again');
  sendResult('native_save_close_reopen_model_settings', '通过', 'Settings 关闭后再次打开，两服务目录及第二服务同 ID 的独立参数从 Host 和真实表格读回');

  phase = 'real_model_selection_and_wire_budget';
  await clickButtonText('New conversation|新建会话');
  await waitFor(`document.querySelector('textarea.composer-input') && !document.querySelector('textarea.composer-input').readOnly`, 'composer_not_ready', 20_000);
  await selectModelViaPicker('model-a', 'Alpha display');
  const preTurnConfig = await configSnapshot();
  assert.equal(preTurnConfig.model.outputTokens, undefined, 'global_output_budget_should_be_unset_for_fallback_check');
  const sendPrompt = async value => {
    await typeFocusedInput(`(() => { const input = document.querySelector('textarea.composer-input'); if (!input) return false; input.focus(); return true; })()`, value);
    await waitFor(`Boolean(document.querySelector('button.send')) && !document.querySelector('button.send').disabled`, 'composer_send_disabled');
    await click(`(() => { document.querySelector('button.send')?.click(); return true; })()`);
  };
  const beforeFirstRequest = (await fixtureControl('state')).requests.length;
  await sendPrompt('Verify the selected model ID and output budget.');
  const firstSessionId = await activeSessionId();
  const firstRequest = await waitFixtureRequest(beforeFirstRequest);
  assert.equal(firstRequest.model, 'model-a');
  assert.equal(firstRequest.maxTokens, 16384);
  await waitSessionIdle(firstSessionId);
  await waitFor(`document.body.innerText.includes('fixture-response:model-a:16384')`, 'first_fixture_response_not_rendered', 20_000);
  let fixture = await fixtureControl('state', {});
  assert.equal(fixture.requests.at(-1)?.model, 'model-a');
  assert.equal(fixture.requests.at(-1)?.maxTokens, 16384);
  await selectModelViaPicker('model-c', 'Gamma display');
  const beforeSecondRequest = (await fixtureControl('state')).requests.length;
  await sendPrompt('Verify a second model uses its inherited output budget.');
  const secondRequest = await waitFixtureRequest(beforeSecondRequest);
  assert.equal(secondRequest.model, 'model-c');
  assert.equal(secondRequest.maxTokens, 8192);
  await waitSessionIdle(firstSessionId);
  await waitFor(`document.body.innerText.includes('fixture-response:model-c:8192')`, 'second_fixture_response_not_rendered', 20_000);
  fixture = await fixtureControl('state', {});
  assert.equal(fixture.requests.at(-1)?.model, 'model-c');
  assert.equal(fixture.requests.at(-1)?.maxTokens, 8192);
  await selectModelViaPicker('model-a', 'Separate Alpha');
  const beforeThirdRequest = (await fixtureControl('state')).requests.length;
  await sendPrompt('Verify that an identical model ID in another service keeps its own budget.');
  const thirdRequest = await waitFixtureRequest(beforeThirdRequest);
  assert.equal(thirdRequest.model, 'model-a');
  assert.equal(thirdRequest.maxTokens, 4096);
  await waitSessionIdle(firstSessionId);
  await waitFor(`document.body.innerText.includes('fixture-response:model-a:4096')`, 'third_fixture_response_not_rendered', 20_000);
  fixture = await fixtureControl('state', {});
  assert.equal(fixture.requests.at(-1)?.model, 'model-a');
  assert.equal(fixture.requests.at(-1)?.maxTokens, 4096);
  await screenshot('model-catalog-selected-model.png');
  sendResult('native_model_picker_and_wire_budget', '通过', '模型选择显示 name；loopback POST /chat/completions 实际收到服务一 model-a/max_tokens=16384、model-c默认max_tokens=8192，以及服务二同ID model-a/max_tokens=4096；均由Host返回协议fixture SSE（无推理）');

  phase = 'host_restart_preferences_retry';
  await fixtureControl('hang', { hang: true });
  const beforeHang = (await fixtureControl('state')).requests.length;
  await sendPrompt('Hold this synthetic model turn while preserving input.');
  const hangingRequest = await waitFixtureRequest(beforeHang);
  assert.equal(hangingRequest.model, 'model-a');
  await waitFor(`Boolean(document.querySelector('button.stop-button'))`, 'hung_model_turn_not_running');
  await sendPrompt('queued item survives local Host restart');
  await waitFor(`document.querySelector('.queue')?.innerText.includes('queued item survives local Host restart')`, 'queued_item_not_visible');
  await typeFocusedInput(`(() => { const input = document.querySelector('textarea.composer-input'); if (!input) return false; input.focus(); return true; })()`, 'draft survives local Host restart');
  await waitFor(`document.querySelector('textarea.composer-input')?.value === 'draft survives local Host restart'`, 'draft_value_not_adopted');
  await waitForPreferencesText('draft survives local Host restart', 'queued item survives local Host restart');
  await new Promise(resolve => setTimeout(resolve, 50));
  const hostPid = host.pid;
  assert.equal(typeof hostPid, 'number');
  process.kill(hostPid);
  await waitFor(`[...document.querySelectorAll('.banner[role="alert"] button')].some(button => /Reconnect|重新连接/u.test(button.textContent ?? ''))`, 'host_reconnect_banner_missing', 20_000);
  const prefsAlert = `([...document.querySelectorAll('.banner[role="alert"]')].find(alert => [...alert.querySelectorAll('button')].some(button => /^(?:Retry|重试)$/u.test((button.textContent ?? '').trim()))) ?? null)`;
  await click(`(() => { const button = [...document.querySelectorAll('.banner[role="alert"] button')].find(item => /Reconnect|重新连接/u.test(item.textContent ?? '')); if (!button) return false; button.click(); return true; })()`);
  await waitFor(`! [...document.querySelectorAll('.banner[role="alert"] button')].some(button => /Reconnect|重新连接/u.test(button.textContent ?? ''))`, 'host_reconnect_did_not_complete', 40_000);
  await fixtureControl('hang', { hang: false });
  let prefsFailureCode = '';
  const prefsRetryDeadline = Date.now() + 2_000;
  while (Date.now() < prefsRetryDeadline && prefsFailureCode === '') {
    prefsFailureCode = await evaluate(`(${prefsAlert})?.querySelector('details code')?.textContent ?? ''`);
    if (prefsFailureCode === '') await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (prefsFailureCode !== '') {
    await evaluate(`{ const details = (${prefsAlert})?.querySelector('details'); if (!details) throw new Error('prefs_failure_details_missing'); details.open = true; } true`);
    await screenshot('model-catalog-host-prefs-failure.png');
    await click(`(() => { const button = [...document.querySelectorAll('.banner[role="alert"] button')].find(item => /^(?:Retry|重试)$/u.test((item.textContent ?? '').trim())); if (!button) return false; button.click(); return true; })()`);
    await waitFor(`![...document.querySelectorAll('.banner[role="alert"] button')].some(button => /^(?:Retry|重试)$/u.test((button.textContent ?? '').trim()))`, 'prefs_retry_did_not_clear_failure', 20_000);
  }
  const preferencesDocument = await waitForPreferencesText('draft survives local Host restart', 'queued item survives local Host restart');
  const persisted = preferencesDocument.settings;
  const persistedDrafts = Object.values(persisted.drafts ?? {}).flatMap(items => Object.values(items));
  const persistedQueued = Object.values(persisted.queued ?? {}).flatMap(items => Object.values(items).flatMap(value => Array.isArray(value) ? value : []));
  assert.ok(persistedDrafts.some(value => value.includes('draft survives local Host restart')) || persistedQueued.some(value => value.includes('draft survives local Host restart')));
  assert.ok(persistedDrafts.some(value => value.includes('queued item survives local Host restart')) || persistedQueued.includes('queued item survives local Host restart'));
  const composerValue = await evaluate(`document.querySelector('textarea.composer-input')?.value ?? ''`);
  assert.ok(composerValue.includes('draft survives local Host restart'));
  assert.ok(composerValue.includes('queued item survives local Host restart'));
  await screenshot('model-catalog-host-prefs-recovered.png');
  await fixtureControl('hang', { hang: false });
  sendResult('host_restart_preferences_retry_details', '通过', `Host PID ${hostPid} 本地断连重启；${prefsFailureCode === '' ? '重连后未出现偏好错误，Retry 分支未触发' : `偏好错误码 ${prefsFailureCode}，Details 已展开并执行 Retry`}；正式 prefs.read 与当前窗口均保留草稿和排队文本，重连按界面既定规则将队列收回草稿`);
}

async function verifyPersistedStateAfterProcessReopen() {
  phase = 'process_reopen_preferences';
  await waitFor(`Boolean(document.querySelector('textarea.composer-input')) && !document.querySelector('textarea.composer-input').readOnly`, 'reopened_composer_not_ready', 30_000);
  await waitFor(`document.querySelector('textarea.composer-input')?.value.includes('draft survives local Host restart') && document.querySelector('textarea.composer-input')?.value.includes('queued item survives local Host restart')`, 'draft_or_recovered_queue_not_restored_after_process_reopen', 30_000);
  const preferencesDocument = await hostCall('prefs.read');
  const persistedDrafts = Object.values(preferencesDocument.settings.drafts ?? {}).flatMap(items => Object.values(items));
  assert.ok(persistedDrafts.some(value => value.includes('draft survives local Host restart') && value.includes('queued item survives local Host restart')));
  await screenshot('model-catalog-host-prefs-after-process-reopen.png');
  sendResult('native_close_reopen_reads_saved_draft_and_queue', '通过', '前一具真实 Electron/Main 与 Host 已关闭并清理锁；新 Electron 进程用同一隔离 LIGULE_HOME 和 userData 启动，真实 UI 与 prefs.read 读回草稿和收回的排队文本');
}

async function cleanup() {
  const pid = host?.pid;
  try { await host?.stop(); }
  catch (error) { sendResult('test_owned_host_cleanup', '失败', error instanceof Error ? error.message : 'host_stop_failed'); }
  try { detachIpc?.(); } catch {}
  try { native?.dispose(); } catch {}
  try { if (window && !window.isDestroyed()) window.destroy(); } catch {}
  if (pid !== undefined) {
    try { process.kill(pid, 0); sendResult('test_owned_host_cleanup', '失败', `Host PID ${pid}仍存在`); }
    catch (error) { if (error.code !== 'ESRCH') sendResult('test_owned_host_cleanup', '失败', `Host PID ${pid}退出状态无法确认：${error.code ?? 'unknown'}`); }
  }
  if (window && !window.isDestroyed()) sendResult('test_owned_window_cleanup', '失败', 'Electron 测试窗口仍然存在');
  const locks = require('node:fs').readdirSync(process.env.LIGULE_HOME, { recursive: true, withFileTypes: true })
    .filter(entry => entry.name.endsWith('.lock'))
    .map(entry => entry.name);
  if (locks.length > 0) sendResult('test_owned_session_lock_cleanup', '失败', `仍有 ${locks.length} 个测试会话锁文件`);
}

(async () => {
  let exitCode = 0;
  try {
    await createApp();
    if (verifyReopen) await verifyPersistedStateAfterProcessReopen();
    else await runScenarios();
    if (results.some(item => item.status === '失败')) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    try {
      diagnosticSnapshot = await evaluate(`(() => ({
        locale: document.documentElement.lang,
        hasWindowFocus: document.hasFocus(),
        activeElement: document.activeElement?.tagName ?? null,
        serviceInputs: [...document.querySelectorAll('.service-form input')].map(input => ({
          type: input.type, label: input.getAttribute('aria-label'), value: input.type === 'password' ? '<redacted>' : input.value,
          placeholder: input.placeholder, disabled: input.disabled, active: document.activeElement === input,
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.innerText),
      }))()`);
      await screenshot('model-catalog-failure.png');
    } catch {}
    sendResult('native_model_catalog_acceptance', '失败', `${error instanceof Error ? error.message : String(error)} (phase=${phase})${diagnosticSnapshot === undefined ? '' : `; UI diagnostics=${JSON.stringify(diagnosticSnapshot)}`}`);
  } finally {
    await cleanup();
    if (results.some(item => item.status === '失败')) exitCode = 1;
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(path.join(evidenceRoot, verifyReopen ? 'model-catalog-reopen.json' : 'model-catalog.json'), `${JSON.stringify({
      platform: process.platform,
      release: require('node:os').release(),
      locale: actualLocale,
      electron: process.versions.electron,
      hostNode: require('node:child_process').execFileSync(path.join(desktopRoot, 'vendor', 'node', 'node.exe'), ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
      window: 'real Electron BrowserWindow; secure production app:// page and Preload',
      provider: 'loopback HTTP protocol fixture; no real model inference',
      workspace: 'isolated temporary workspace',
      observedCsp: typeof observedCsp === 'string' && observedCsp.includes("default-src 'self'") && observedCsp.includes("script-src 'self'"),
      diagnosticSnapshot,
      exitCode,
      results,
    }, null, 2)}\n`, 'utf8');
    process.exitCode = exitCode;
    app.quit();
  }
})();

