const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { app, session } = require('electron');

const repositoryRoot = resolve(__dirname, '../../..');
const desktopRoot = join(repositoryRoot, 'desktop');
const workspaceRoot = process.env.LIGULE_REAL_MODEL_WORKSPACE;
const evidenceRoot = process.env.LIGULE_REAL_MODEL_EVIDENCE;
const userDataRoot = process.env.LIGULE_REAL_MODEL_USER_DATA;
const isolatedHome = process.env.LIGULE_HOME;
const results = [];
let mainWindow;
let nativeServices;
let host;
let detachIpc;
let observedCsp;
let sessionId;
let sequence = 0;
let failed = false;
let phase = 'load_application';
// 同一个窗口驱动 harness 既服务真实模型验收，也服务本地 stub 模型回归；标签只影响报告文字，不改变被测行为。
const providerLabel = process.env.LIGULE_MODEL_PROVIDER_LABEL ?? '真实模型';
const evidenceName = process.env.LIGULE_MODEL_EVIDENCE_NAME ?? 'real-model';

if ([workspaceRoot, evidenceRoot, userDataRoot, isolatedHome].some(value => typeof value !== 'string' || value.length === 0)) {
  throw new Error('real_model_harness_paths_missing');
}

app.setPath('userData', userDataRoot);
app.enableSandbox();
// 证据必须在销毁窗口之后写出；保持应用存活到显式 quit，避免 window-all-closed 提前结束进程而写出空报告。
app.on('window-all-closed', () => {});
const secureWindow = require('../dist/secure-window.js');
const security = require('../dist/security.js');
const ipc = require('../dist/ipc.js');
const { HostController } = require('../dist/host.js');
const { resolveHostRuntime } = require('../dist/runtime.js');
const { NativeServices } = require('../dist/native.js');
secureWindow.registerAppScheme();

function note(name, status, detail, code) {
  const item = { name, status, detail, ...(code === undefined ? {} : { code }) };
  results.push(item);
  console.log(JSON.stringify(item));
}

function stableErrorCode(error) {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string' && /^[A-Za-z]{3,30}$/u.test(error.name)) return `native_${error.name.toLowerCase()}`;
  if (error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const message = error.message;
    const electronCode = /\b(ERR_[A-Z_]{3,60})\b/u.exec(message)?.[1];
    if (electronCode !== undefined) return electronCode.toLowerCase();
    return /^[a-z][a-z0-9_]{2,80}$/u.test(message) ? message : 'unexpected_error';
  }
  return 'unexpected_error';
}

function safeErrorLocation(error) {
  const stack = error !== null && typeof error === 'object' && 'stack' in error && typeof error.stack === 'string' ? error.stack : '';
  const locations = stack.split('\n').slice(1, 6).flatMap(line => {
    const match = /(?:\((?:.*[\\/])?([^\\/:]+):(\d+):(\d+)\)|at (?:.*[\\/])?([^\\/:]+):(\d+):(\d+))/u.exec(line);
    if (match === null) return [];
    return [`${match[1] ?? match[4]}:${match[2] ?? match[5]}`];
  });
  return locations.length === 0 ? 'location_unknown' : locations.join(',');
}

async function check(name, action) {
  try {
    const detail = await action();
    note(name, '通过', detail);
  } catch (error) {
    failed = true;
    note(name, '失败', `交互未达到预期，位置 ${safeErrorLocation(error)}；只记录稳定错误码。`, stableErrorCode(error));
  }
}

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function evaluate(source) {
  assert.ok(mainWindow !== undefined && !mainWindow.isDestroyed(), 'real_window_unavailable');
  return await mainWindow.webContents.executeJavaScript(source, true);
}

async function requestHost(method, params = {}) {
  const id = nextId('real-model-rpc');
  const encoded = JSON.stringify({ id, method, params });
  const result = await evaluate(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(encoded)});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = window.__realModelFrames.find(frame => frame.id === ${JSON.stringify(id)});
      if (response !== undefined) return response;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    throw new Error('real_model_host_rpc_timeout');
  })()`);
  if (result.errorCode !== undefined) throw Object.assign(new Error('host_rpc_failed'), { code: result.errorCode });
  return result;
}

async function sessionSummary() {
  if (typeof sessionId !== 'string') throw Object.assign(new Error('real_model_session_missing'), { code: 'real_model_session_missing' });
  const record = await requestHost('session.read', { sessionId, fullResults: true });
  const status = await requestHost('status.get', { sessionId });
  return {
    running: status.running,
    turns: record.events.filter(event => event.kind === 'turn').map(event => ({ status: event.status, code: event.code })),
    tools: record.events.filter(event => event.kind === 'tool').map(event => ({ tool: event.tool, kind: event.resultKind, code: event.resultCode })),
    deltaCount: await evaluate(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.sessionId === ${JSON.stringify(sessionId)}).length`),
  };
}

async function waitForSessionIdle(timeoutMs, failureCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await sessionSummary();
    if (summary.running === false) return summary;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw Object.assign(new Error(failureCode), { code: failureCode });
}

function cspHeader(headers) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-security-policy');
  if (entry === undefined) return undefined;
  return Array.isArray(entry[1]) ? entry[1].join('; ') : String(entry[1]);
}

async function createApplication() {
  phase = 'wait_for_electron';
  await app.whenReady();
  phase = 'install_app_protocol';
  secureWindow.installResourceProtocol(join(desktopRoot, 'frontend', 'dist'));
  session.defaultSession.webRequest.onCompleted({ urls: ['app://ligule/*'] }, details => {
    if (details.url === security.APP_PAGE && details.resourceType === 'mainFrame') observedCsp = cspHeader(details.responseHeaders);
  });

  phase = 'create_secure_window';
  mainWindow = secureWindow.createApplicationWindow({
    preload: join(desktopRoot, 'electron', 'dist', 'preload.js'),
    iconPath: join(desktopRoot, 'assets', 'app-icon.png'),
    page: security.APP_PAGE,
    development: false,
  });
  phase = 'create_native_services';
  nativeServices = new NativeServices({
    window: mainWindow,
    onQuitRequested: () => {},
    onNotificationOpen: () => {},
    onFault: () => {},
    iconPath: join(desktopRoot, 'assets', 'app-icon.png'),
  });
  phase = 'resolve_host_runtime';
  const node = join(desktopRoot, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const runtime = resolveHostRuntime({ repositoryRoot, node, environment: process.env });
  host = new HostController({
    ...runtime,
    entry: join(desktopRoot, 'electron', 'dist', 'host-entry.js'),
    onFrame: frame => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('ligule:host-frame', frame);
    },
    onFault: () => {},
  });
  phase = 'register_production_ipc';
  detachIpc = ipc.registerDesktopIpc(mainWindow, security.APP_PAGE, host, nativeServices, async () => {});
  phase = 'start_node_host';
  await host.start();
  phase = 'load_application_page';
  await mainWindow.loadURL(security.APP_PAGE);
  mainWindow.show();
  phase = 'subscribe_to_host_frames';
  await evaluate(`(() => {
    window.__realModelFrames = [];
    window.liguleDesktop.onHostFrame(raw => {
      try {
        const frame = JSON.parse(raw);
        const safe = {};
        if (typeof frame.id === 'string') safe.id = frame.id;
        if (typeof frame.method === 'string') safe.method = frame.method;
        if (typeof frame.notify === 'string') safe.notify = frame.notify;
        if (typeof frame.sessionId === 'string') safe.sessionId = frame.sessionId;
        if (frame.result && typeof frame.result.sessionId === 'string') safe.createdSessionId = frame.result.sessionId;
        if (frame.error && typeof frame.error.code === 'string') safe.errorCode = frame.error.code;
        if (frame.event && typeof frame.event.type === 'string') safe.deltaType = frame.event.type;
        if (frame.method === 'approval.request') safe.approvalTool = frame.params?.tool;
        if (frame.result && typeof frame.id === 'string' && frame.id.startsWith('real-model-rpc-')) {
          if (typeof frame.result.running === 'boolean') safe.running = frame.result.running;
          if (Array.isArray(frame.result.workspaces)) safe.workspaces = frame.result.workspaces.map(item => ({ identity: item.identity, directory: item.directory }));
          if (Array.isArray(frame.result.events)) safe.events = frame.result.events.map(event => ({
            kind: event.kind,
            status: event.status,
            code: event.code,
            tool: event.tool,
            resultKind: event.result?.kind,
            resultFailed: event.result?.failed === true,
            resultHasSkillProof: JSON.stringify(event.result?.content ?? null).includes('SKILL_LOAD_PROOF'),
            resultHasSchemaDigest: JSON.stringify(event.result?.content ?? null).includes('schemaDigest'),
            resultHasMcpProof: JSON.stringify(event.result?.content ?? null).includes('echo: MCP_LOADING_PROOF'),
            resultCode: event.result?.code,
          }));
        }
        window.__realModelFrames.push(safe);
      } catch {}
    });
    return { href: location.href, methods: Object.keys(window.liguleDesktop).sort() };
  })()`);
}

async function waitFor(expression, timeoutMs, failureCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw Object.assign(new Error(failureCode), { code: failureCode });
}

async function allowApproval(tool, previousCount, failureCode) {
  const expected = JSON.stringify(tool);
  await waitFor(
    `window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${previousCount}`
      + ` && document.querySelector('.approval .row-tool')?.textContent.trim() === ${expected}`,
    15_000,
    failureCode,
  );
  const clicked = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.approval')].find(item => item.querySelector('.row-tool')?.textContent.trim() === ${expected});
    const button = card?.querySelector('button[data-tone="allow"]');
    if (button === undefined || button === null) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw Object.assign(new Error(`${tool}_approval_action_missing`), { code: `${tool.replace(/[^a-z0-9]+/giu, '_')}_approval_action_missing` });
}

async function enterAndSend(text) {
  await waitFor(`document.querySelector('textarea.composer-input') && !document.querySelector('textarea.composer-input').readOnly`, 20_000, 'composer_locked');
  const escaped = JSON.stringify(text);
  await evaluate(`(() => {
    const input = document.querySelector('textarea.composer-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${escaped});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${escaped} }));
    return true;
  })()`);
  const ready = await waitFor(`document.querySelector('button.send') && !document.querySelector('button.send').disabled`, 8_000, 'composer_input_not_adopted').catch(() => false);
  if (!ready) {
    const state = await evaluate(`(() => {
      const input = document.querySelector('textarea.composer-input');
      const send = document.querySelector('button.send');
      return { inputPresent: input !== null, readOnly: input?.readOnly ?? true, valueLength: input?.value.length ?? 0, sendPresent: send !== null, sendDisabled: send?.disabled ?? true };
    })()`);
    const code = state.readOnly ? 'composer_locked' : state.valueLength === 0 ? 'composer_input_event_ignored' : 'composer_send_disabled';
    throw Object.assign(new Error(code), { code });
  }
  await evaluate(`document.querySelector('button.send').click(); true`);
}

async function recordReport(exitCode) {
  const report = {
    platform: process.platform,
    release: require('node:os').release(),
    electron: process.versions.electron,
    hostNode: require('node:child_process').execFileSync(join(desktopRoot, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node'), ['--version'], { encoding: 'utf8', windowsHide: process.platform === 'win32' }).trim(),
    applicationPage: security.APP_PAGE,
    provider: providerLabel,
    workspace: workspaceRoot,
    policy: 'ask',
    cspObserved: typeof observedCsp === 'string' && observedCsp.includes("default-src 'self'") && observedCsp.includes("script-src 'self'"),
    sessionId,
    exitCode,
    results,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, `${evidenceName}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(evidenceRoot, `${evidenceName}.log`), `${results.map(item => `${item.name} ${item.status}${item.code === undefined ? '' : ` ${item.code}`}: ${item.detail}`).join('\n')}\n`, 'utf8');
}

async function runChecks() {
  const preferences = mainWindow.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);

  const workspaceRegistration = await requestHost('workspaces.list');
  assert.ok(workspaceRegistration.workspaces.some(item => resolve(item.directory) === resolve(workspaceRoot)), 'isolated_workspace_not_registered');

  await check(`${providerLabel}工具审批拒绝`, async () => {
    await enterAndSend('请调用 create 工具，在项目根目录创建 model-denial-proof.txt，内容只写 DENIED。必须先调用工具，再简短说明结果。');
    await waitFor(`window.__realModelFrames.some(frame => typeof frame.createdSessionId === 'string')`, 15_000, 'session_create_response_missing');
    sessionId = await evaluate(`window.__realModelFrames.find(frame => typeof frame.createdSessionId === 'string').createdSessionId`);
    await waitFor(`window.__realModelFrames.some(frame => frame.method === 'approval.request') || window.__realModelFrames.some(frame => typeof frame.errorCode === 'string')`, 100_000, 'model_approval_wait_timeout');
    const request = await evaluate(`window.__realModelFrames.find(frame => frame.method === 'approval.request') ?? null`);
    if (request === null) {
      const error = await evaluate(`window.__realModelFrames.find(frame => typeof frame.errorCode === 'string')?.errorCode ?? 'model_request_failed'`);
      throw Object.assign(new Error('real_model_request_failed'), { code: error });
    }
    assert.equal(request.approvalTool, 'create', 'model_did_not_request_create_tool');
    await waitFor(`document.querySelector('.approval button[data-tone="deny"]')`, 15_000, 'approval_card_not_rendered');
    await evaluate(`document.querySelector('.approval button[data-tone="deny"]').click(); true`);
    await waitFor(`window.__realModelFrames.some(frame => frame.notify === 'event' && frame.sessionId === ${JSON.stringify(sessionId)})`, 15_000, 'approval_reply_event_missing');
    const summary = await waitForSessionIdle(25_000, 'approval_turn_did_not_finish');
    const fileExists = await require('node:fs/promises').access(join(workspaceRoot, 'model-denial-proof.txt')).then(() => true, () => false);
    assert.equal(fileExists, false, 'denied_tool_created_file');
    assert.equal(summary.tools.some(item => item.tool === 'create' && item.kind === 'refusal'), true, 'denied_tool_refusal_not_recorded');
    return `真实 Host 请求 create 审批；界面拒绝后记录 refusal，目标文件不存在`;
  });

  await check(`${providerLabel}工具审批允许`, async () => {
    if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
    const target = join(workspaceRoot, 'model-allow-proof.txt');
    await require('node:fs/promises').rm(target, { force: true });
    const before = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length`);
    await enterAndSend('请调用 create 工具，在项目根目录创建 model-allow-proof.txt，内容只写 ALLOWED。必须先调用工具，再简短说明结果。');
    await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${before}`, 100_000, 'model_approval_wait_timeout');
    await waitFor(`document.querySelector('.approval button[data-tone="allow"]')`, 15_000, 'approval_card_not_rendered');
    await evaluate(`document.querySelector('.approval button[data-tone="allow"]').click(); true`);
    // 允许后 Host 需要先执行工具再收尾；轮询到「本轮已结束且已记录 result」再断言，避免读到上一轮的状态。
    const deadline = Date.now() + 30_000;
    let summary = null;
    while (Date.now() < deadline) {
      summary = await sessionSummary();
      if (summary.running === false && summary.tools.some(item => item.tool === 'create' && item.kind === 'result')) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    }
    assert.equal(summary?.tools.some(item => item.tool === 'create' && item.kind === 'result'), true, 'approved_tool_result_not_recorded');
    const content = await require('node:fs/promises').readFile(target, 'utf8').catch(() => null);
    assert.equal(content?.trim(), 'ALLOWED', 'approved_tool_did_not_write_file');
    return '真实 Host 请求 create 审批；界面允许后由 Host 写入目标文件并记录 result';
  });

  const stubControl = process.env.LIGULE_STUB_CONTROL;
  if (typeof stubControl === 'string' && stubControl !== '') {
    await check(`${providerLabel}Skill 与 MCP 装载`, async () => {
      if (typeof sessionId !== 'string') throw Object.assign(new Error('skill_mcp_session_unavailable'), { code: 'skill_mcp_session_unavailable' });
      const approvalCount = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length`);
      await enterAndSend('执行 desktop-skill-mcp-load-proof：激活 desktop-smoke Skill，按其说明检查 MCP echo，并完成加载验证。');
      await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${approvalCount}`, 60_000, 'skill_activation_approval_missing');
      const skillApproval = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').at(-1)?.approvalTool ?? null`);
      if (skillApproval !== 'skill') throw Object.assign(new Error('skill_activation_approval_not_requested'), { code: 'skill_activation_approval_not_requested' });
      await allowApproval('skill', approvalCount, 'skill_mcp_approval_card_missing');
      await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${approvalCount + 1}`, 60_000, 'mcp_inspect_approval_missing');
      const inspectApproval = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').at(-1)?.approvalTool ?? null`);
      if (inspectApproval !== 'mcp.inspect') throw Object.assign(new Error('mcp_inspect_approval_not_requested'), { code: 'mcp_inspect_approval_not_requested' });
      await allowApproval('mcp.inspect', approvalCount + 1, 'mcp_inspect_approval_card_missing');
      await waitFor(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').length > ${approvalCount + 2}`, 60_000, 'mcp_call_approval_missing');
      const mcpApproval = await evaluate(`window.__realModelFrames.filter(frame => frame.method === 'approval.request').at(-1)?.approvalTool ?? null`);
      if (mcpApproval !== 'mcp:fixture/echo') throw Object.assign(new Error('mcp_effective_capability_approval_not_requested'), { code: 'mcp_effective_capability_approval_not_requested' });
      await allowApproval('mcp:fixture/echo', approvalCount + 2, 'mcp_approval_card_missing');
      await waitForSessionIdle(60_000, 'skill_mcp_turn_did_not_finish');

      const record = await requestHost('session.read', { sessionId, fullResults: true });
      const events = record.events ?? [];
      const skill = events.findLast(event => event.kind === 'tool' && event.tool === 'skill');
      const inspect = events.findLast(event => event.kind === 'tool' && event.tool === 'mcp.inspect');
      const call = events.findLast(event => event.kind === 'tool' && event.tool === 'mcp.call');
      if (skill?.resultKind !== 'result' || skill.resultFailed) throw Object.assign(new Error('skill_activation_result_missing'), { code: 'skill_activation_result_missing' });
      if (skill.resultHasSkillProof !== true) throw Object.assign(new Error('project_skill_body_not_loaded'), { code: 'project_skill_body_not_loaded' });
      if (inspect?.resultKind !== 'result' || inspect.resultFailed) throw Object.assign(new Error('mcp_stdio_tool_definition_not_loaded'), { code: 'mcp_stdio_tool_definition_not_loaded' });
      if (inspect.resultHasSchemaDigest !== true) throw Object.assign(new Error('mcp_definition_digest_missing'), { code: 'mcp_definition_digest_missing' });
      if (call?.resultKind !== 'result' || call.resultFailed) throw Object.assign(new Error('mcp_tool_call_not_completed'), { code: 'mcp_tool_call_not_completed' });
      if (call.resultHasMcpProof !== true) throw Object.assign(new Error('mcp_fixture_result_missing'), { code: 'mcp_fixture_result_missing' });

      const response = await fetch(`${stubControl}/state`);
      const state = await response.json();
      for (const [key, code] of [
        ['catalogLoaded', 'skill_mcp_catalog_not_loaded'],
        ['skillActivated', 'skill_mcp_skill_not_activated'],
        ['mcpDefinitionLoaded', 'skill_mcp_definition_not_loaded'],
        ['mcpCallSucceeded', 'skill_mcp_call_not_completed'],
      ]) {
        if (state.skillMcpProof?.[key] !== true) throw Object.assign(new Error(code), { code });
      }
      return '真实 Electron 窗口通过 Node Host 装载项目 Skill，启动 stdio MCP fixture、读取 echo 定义并完成经审批的工具调用';
    });
  }

  await check(`${providerLabel}流式取消`, async () => {
    if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
    await enterAndSend('请用中文连续写一篇很长的说明，至少输出三千字，不要调用工具。');
    const initial = await evaluate(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.deltaType === 'text').length`);
    await waitFor(`window.__realModelFrames.filter(frame => frame.notify === 'delta' && frame.deltaType === 'text').length > ${initial}`, 60_000, 'model_text_stream_missing');
    await waitFor(`document.querySelector('button.stop-button')`, 5_000, 'turn_stop_control_missing');
    await evaluate(`document.querySelector('button.stop-button').click(); true`);
    const summary = await waitForSessionIdle(20_000, 'cancelled_turn_did_not_finish');
    assert.equal(summary.turns.at(-1)?.status, 'cancelled', 'cancelled_turn_terminal_status_invalid');
    return `收到真实 text 增量 ${summary.deltaCount ?? 1} 次后按界面停止；Host 写入 cancelled 终态`;
  });

  // 只在本地 stub 提供方下执行：真实提供方无法按需制造「请求已发出、永远没有答案」的那一刻。
  if (typeof stubControl === 'string' && stubControl !== '') {
    await check(`${providerLabel}宿主崩溃后的界面重连`, async () => {
      if (typeof sessionId !== 'string') throw Object.assign(new Error('approval_session_unavailable'), { code: 'approval_session_unavailable' });
      const control = async (path, body) => {
        const response = await fetch(`${stubControl}${path}`, body === undefined
          ? {}
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return response.json();
      };
      await control('/hang', { hang: true });
      const before = (await control('/state')).requests;
      await enterAndSend('请写一篇很长的说明，先不要结束。');
      await waitFor(`document.querySelector('button.stop-button') !== null`, 25_000, 'crash_turn_not_running');
      const receivedDeadline = Date.now() + 20_000;
      let received = before;
      while (Date.now() < receivedDeadline) {
        received = (await control('/state')).requests;
        if (received > before) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
      }
      assert.equal(received > before, true, 'model_request_not_received');
      const killedPid = host.pid;
      assert.equal(typeof killedPid, 'number', 'host_pid_unavailable');
      process.kill(killedPid);
      // 页面可能有不止一条 role="alert" 横幅（例如偏好保存失败也带一个重试按钮），
      // 所以按按钮文字定位断连横幅，不能取第一条横幅的第一个按钮。
      const reconnectButton = `[...document.querySelectorAll('.banner[role="alert"] button')].find((button) => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null`;
      await waitFor(`${reconnectButton} !== null`, 30_000, 'disconnected_banner_missing');
      const clickAt = Date.now();
      await evaluate(`{ const button = (${reconnectButton}); button.click(); button.click(); } true`);
      let cleared = false;
      while (Date.now() < clickAt + 45_000) {
        if (await evaluate(`${reconnectButton} === null`)) { cleared = true; break; }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
      }
      if (!cleared) throw Object.assign(new Error('reconnect_did_not_recover'), { code: 'reconnect_did_not_recover' });
      if (await evaluate(`/无法启动后端|Could not start the host/u.test(document.body.innerText)`)) {
        throw Object.assign(new Error('repeated_reconnect_started_another_lifecycle'), { code: 'repeated_reconnect_started_another_lifecycle' });
      }
      // 横幅消失只说明壳已经换了一具进程：`session.open` 可能还在路上，接回原来那一份之前
      // `session.read` 会答 session_not_open。等 Host 真的持有这一份会话再断言，最多 25 秒。
      const reopenDeadline = Date.now() + 25_000;
      let reopened = false;
      while (Date.now() < reopenDeadline) {
        try {
          await requestHost('session.read', { sessionId, fullResults: false });
          reopened = true;
          break;
        } catch (error) {
          if (stableErrorCode(error) !== 'session_not_open') throw error;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      }
      if (!reopened) {
        console.log(`CRASH-DIAG post=${JSON.stringify(await evaluate(`document.body.innerText.replace(/\\s+/gu, ' ').slice(0, 700)`))}`);
        throw Object.assign(new Error('session_reopen_timeout'), { code: 'session_reopen_timeout' });
      }
      const summary = await waitForSessionIdle(30_000, 'recovered_session_not_idle');
      const after = (await control('/state')).requests;
      await control('/hang', { hang: false });
      assert.equal(after, received, 'reconnect_replayed_the_request');
      const last = summary.turns.at(-1) ?? {};
      assert.notEqual(last.status, 'running', 'pending_turn_not_settled');
      return `硬杀 Host（PID ${killedPid}）后界面出现断连横幅并重连成功；未决那一轮终态 ${last.status ?? '无'}${last.code === undefined ? '' : `/${last.code}`}，重连没有重发模型请求`;
    });
  }
}

async function cleanup() {
  try { await host?.stop(); } catch { failed = true; }
  try { detachIpc?.(); } catch { failed = true; }
  try { nativeServices?.dispose(); } catch { failed = true; }
  try { if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch { failed = true; }
}

(async () => {
  let exitCode = 0;
  try {
    await createApplication();
    phase = 'run_model_checks';
    await runChecks();
    if (failed) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    const code = stableErrorCode(error);
    note(`${providerLabel}验收启动`, '失败', `阶段 ${phase}，位置 ${safeErrorLocation(error)}。`, code);
  } finally {
    await cleanup();
    if (failed) exitCode = 1;
    try { await recordReport(exitCode); } catch (error) {
      exitCode = 1;
      note('证据写入', '失败', `脱敏报告写入位置 ${safeErrorLocation(error)}。`, stableErrorCode(error));
      try {
        writeFileSync(join(evidenceRoot, `${evidenceName}.json`), `${JSON.stringify({ platform: process.platform, electron: process.versions.electron, exitCode, results }, null, 2)}\n`, 'utf8');
      } catch {}
    }
    process.exitCode = exitCode;
    app.quit();
  }
})();
