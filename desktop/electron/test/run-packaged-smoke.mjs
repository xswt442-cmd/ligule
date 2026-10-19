import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { finished } from 'node:stream/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionDirectory } from '../../../core/dist/session/list.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = dirname(dirname(scriptDirectory));
const repositoryRoot = dirname(desktopDirectory);
const appDirectoryArgument = process.argv.indexOf('--app-dir');
const suppliedAppDirectory = appDirectoryArgument >= 0 ? process.argv[appDirectoryArgument + 1] : undefined;
const localInterruption = process.argv.includes('--local-request-interruption');
const realInterruption = process.argv.includes('--real-request-interruption');
const interruptionMode = localInterruption ? 'local' : realInterruption ? 'real' : undefined;
if (localInterruption && realInterruption) throw new Error('packaged_interruption_modes_conflict');
const modelApiKeyName = 'LIGULE_PLAN2_OTHERS_API_KEY';
let modelApiKey = process.env[modelApiKeyName];
delete process.env[modelApiKeyName];
if (realInterruption && (typeof modelApiKey !== 'string' || modelApiKey.length < 8)) {
  throw new Error('packaged_real_interruption_credential_missing');
}
if (!realInterruption) modelApiKey = undefined;
if (appDirectoryArgument >= 0 && (suppliedAppDirectory === undefined || !isAbsolute(suppliedAppDirectory))) {
  throw new Error('--app-dir_requires_an_absolute_directory');
}
const packagedDirectory = suppliedAppDirectory === undefined
  ? defaultPackagedDirectory()
  : resolve(suppliedAppDirectory);
const applicationBundle = process.platform === 'darwin'
  ? packagedDirectory.toLowerCase().endsWith('.app') ? packagedDirectory : join(packagedDirectory, 'ligule.app')
  : packagedDirectory;
const applicationExecutable = process.platform === 'darwin'
  ? join(applicationBundle, 'Contents', 'MacOS', 'ligule')
  : join(applicationBundle, process.platform === 'win32' ? 'ligule.exe' : 'ligule');
const resourcesDirectory = process.platform === 'darwin'
  ? join(applicationBundle, 'Contents', 'Resources')
  : join(applicationBundle, 'resources');
const hostNode = join(resourcesDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const hostCli = join(resourcesDirectory, 'app', 'node_modules', '@ligule', 'core', 'dist', 'host', 'desktop-entry.js');
const hostEntry = join(resourcesDirectory, 'host-entry.js');
const testRoot = join(desktopDirectory, 'testplace');
const temporaryParent = join(testRoot, 'tmp');
const evidenceParent = join(testRoot, 'readings');
const requiredFiles = [applicationExecutable, hostNode, hostCli, hostEntry];
const missing = requiredFiles.filter(path => !existsSync(path));
if (missing.length > 0) throw new Error(`packaged_application_resources_missing:${missing.map(path => basename(path)).join(',')}`);

await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryRoot = await mkdtemp(join(temporaryParent, `packaged-smoke-${runId}-`));
const evidenceRoot = await mkdtemp(join(evidenceParent, `packaged-smoke-${runId}-${process.pid}-`));
const userDataDirectory = join(temporaryRoot, 'user-data');
const liguleHome = join(temporaryRoot, 'ligule-home');
const workspace = join(temporaryRoot, 'workspaces', 'project');
process.env.LIGULE_HOME = liguleHome;
const sessionRecordDirectory = sessionDirectory({ boundary: workspace, workspaceRoot: workspace });
const exportDirectory = join(temporaryRoot, 'exports');
const exportPath = join(exportDirectory, 'session.md');
const providerGate = interruptionMode === undefined
  ? undefined
  : await startProviderGate(interruptionMode, modelApiKey);
await Promise.all([
  mkdir(userDataDirectory, { recursive: true }),
  mkdir(liguleHome, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(exportDirectory, { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
]);

if (interruptionMode !== undefined) {
  const config = [
    'boundary = "."',
    '',
    '[model]',
    'api = "chat-completions"',
    `baseURL = ${JSON.stringify(`http://127.0.0.1:${providerGate.port}/v1`)}`,
    'model = "deepseek-flash"',
    `apiKeyEnv = ${JSON.stringify(modelApiKeyName)}`,
    'outputTokens = 1024',
    '',
    '[model.retry]',
    'maxAttempts = 1',
    'baseDelayMs = 1',
    'retry429 = false',
    'retry5xx = false',
    'retryTransport = false',
    '',
    '[loop]',
    'iterations = 2',
    'modelCalls = 2',
    '',
    '[policy]',
    'mode = "ask"',
    '',
  ].join('\n');
  await writeFile(join(liguleHome, 'config.toml'), config, { flag: 'wx', mode: 0o600 });
}

const environment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[key];
for (const key of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(key)) delete environment[key];
}
environment.LIGULE_HOME = liguleHome;
if (interruptionMode !== undefined) {
  environment[modelApiKeyName] = interruptionMode === 'real' ? modelApiKey : 'synthetic-local-provider-key';
}

const results = [];
const processIds = {};
let applicationProcess;
let devTools;
let exitCode = 0;
let processExit;
let timedOut = false;

function defaultPackagedDirectory() {
  if (process.platform === 'win32') return join(desktopDirectory, 'release', 'win-unpacked');
  if (process.platform === 'linux') return join(desktopDirectory, 'release', 'linux-unpacked');
  if (process.platform === 'darwin') {
    const candidates = [
      join(desktopDirectory, 'release', `mac-${process.arch}`),
      join(desktopDirectory, 'release', 'mac'),
    ];
    return candidates.find(directory => existsSync(join(directory, 'ligule.app'))) ?? candidates[0];
  }
  throw new Error(`packaged_smoke_platform_unsupported:${process.platform}`);
}

function record(name, status, detail) {
  const result = { name, status, detail };
  results.push(result);
  console.log(JSON.stringify(result));
}

async function startProviderGate(mode, apiKey) {
  const state = {
    mode,
    requests: 0,
    localActions: [],
    model: undefined,
    maxTokens: undefined,
    upstreamStatus: undefined,
    held: false,
    failure: undefined,
    clientClosed: false,
  };
  let upstreamResponse;
  let upstreamController;
  let upstreamTimer;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/__state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    state.requests += 1;
    response.on('close', () => {
      state.clientClosed = true;
      upstreamController?.abort();
      if (upstreamResponse?.body !== null && upstreamResponse?.body !== undefined) {
        void upstreamResponse.body.cancel().catch(() => {});
      }
    });
    if (state.requests > (mode === 'local' ? 5 : 1)) {
      state.failure = 'duplicate_provider_request';
      response.writeHead(409);
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', () => { state.failure = 'provider_request_read_failed'; });
    request.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        state.failure = 'provider_request_json_invalid';
        return;
      }
      state.model = body.model;
      state.maxTokens = body.max_tokens;
      if (body.model !== 'deepseek-flash' || body.max_tokens !== 1024 || body.stream !== true) {
        state.failure = 'provider_request_metadata_invalid';
        return;
      }
      if (mode === 'local') {
        const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find(item => item.role === 'user') : undefined;
        const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
        const marker = prompt.includes('[LOCAL_APPROVAL_DENY]')
          ? 'deny'
          : prompt.includes('[LOCAL_APPROVAL_ALLOW]')
            ? 'allow'
            : prompt.includes('[LOCAL_PENDING_INTERRUPTION]') ? 'pending' : undefined;
        if (marker === undefined) {
          state.failure = 'local_fixture_prompt_unrecognized';
          return;
        }
        if (marker === 'deny' || marker === 'allow') {
          const lastUserIndex = body.messages.lastIndexOf(lastUser);
          if (body.messages.slice(lastUserIndex + 1).some(item => item.role === 'tool')) {
            const events = [
              { choices: [{ index: 0, delta: { content: '审批处理已完成。' }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
              '[DONE]',
            ];
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
            return;
          }
          state.localActions.push(`approval_${marker}`);
          const arguments_ = marker === 'deny'
            ? { path: 'approval-denied-proof.txt', content: 'DENIED' }
            : { path: 'approval-allowed-proof.txt', content: 'ALLOWED' };
          const events = [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `local-${marker}-call`, type: 'function', function: { name: 'create', arguments: JSON.stringify(arguments_) } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Controlled pending response.' }, finish_reason: null }] })}\n\n`);
        state.localActions.push('pending_response_held');
        state.held = true;
        return;
      }

      try {
        upstreamController = new AbortController();
        upstreamTimer = setTimeout(() => upstreamController?.abort(), 90_000);
        upstreamResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: upstreamController.signal,
        });
        state.upstreamStatus = upstreamResponse.status;
        if (upstreamResponse.status !== 200) {
          state.failure = 'official_provider_http_error';
          state.held = true;
          return;
        }
        state.held = true;
      } catch {
        state.failure = 'official_provider_transport_error';
      } finally {
        clearTimeout(upstreamTimer);
        upstreamTimer = undefined;
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('provider_gate_listen_failed');
  return {
    port: address.port,
    state,
    containsCredential(text) {
      return typeof apiKey === 'string' && apiKey.length > 0 && text.includes(apiKey);
    },
    async close() {
      clearTimeout(upstreamTimer);
      upstreamController?.abort();
      if (upstreamResponse?.body !== null && upstreamResponse?.body !== undefined) {
        await upstreamResponse.body.cancel().catch(() => {});
      }
      server.closeAllConnections();
      await new Promise(resolvePromise => server.close(resolvePromise));
    },
  };
}

async function check(name, action) {
  try {
    const detail = await action();
    record(name, '通过', detail ?? '实测符合预期');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interruptionMode === undefined) {
      record(name, '失败', message.split('\n')[0].slice(0, 300));
    } else {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : interruptionMode === 'local' && error instanceof Error
            ? error.message.toLowerCase().replace(/[^a-z0-9]+/gu, '_').slice(0, 100)
          : 'packaged_interruption_check_failed';
      record(name, '失败', `隔离验收步骤失败，错误码 ${code}`);
    }
    exitCode = 1;
  }
}

function waitUntil(predicate, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      try {
        const result = await predicate();
        if (result) {
          resolvePromise(result);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timeout_waiting_for_${label}`));
          return;
        }
        setTimeout(poll, 150);
      } catch (error) {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(poll, 150);
      }
    };
    void poll();
  });
}

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'devtools_command_failed'));
      else waiter.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('devtools_connection_closed'));
      }
      this.pending.clear();
    });
    socket.addEventListener('error', () => {
      this.closed = true;
    });
  }

  static async connect(address) {
    const socket = new WebSocket(address);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools_websocket_timeout')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools_websocket_failed')); }, { once: true });
    });
    return new DevToolsConnection(socket);
  }

  call(method, params = {}, timeoutMs = 15_000) {
    if (this.closed) return Promise.reject(new Error('devtools_connection_closed'));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`devtools_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 15_000) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (response.exceptionDetails !== undefined) {
      const exception = response.exceptionDetails.exception;
      throw new Error(exception?.description ?? response.exceptionDetails.text ?? 'renderer_evaluation_failed');
    }
    return response.result?.value;
  }
}

async function connectDevTools() {
  const activePortPath = join(userDataDirectory, 'DevToolsActivePort');
  await waitUntil(async () => {
    if (applicationProcess.exitCode !== null) throw new Error(`packaged_app_exited:${applicationProcess.exitCode}`);
    const content = await readFile(activePortPath, 'utf8').catch(() => '');
    const port = Number(content.split(/\r?\n/u)[0]);
    return Number.isInteger(port) && port > 0 ? port : false;
  }, 35_000, 'DevToolsActivePort');
  const content = await readFile(activePortPath, 'utf8');
  const port = Number(content.split(/\r?\n/u)[0]);
  const page = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);
    if (response === undefined || !response.ok) return false;
    const targets = await response.json();
    return targets.find(target => target.type === 'page' && target.url === 'app://ligule/index.html') ?? false;
  }, 35_000, 'packaged_app_page');
  devTools = await DevToolsConnection.connect(page.webSocketDebuggerUrl);
  await devTools.call('Page.enable');
  await devTools.call('Runtime.enable');
  return page;
}

async function processSnapshot() {
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "$all = Get-CimInstance Win32_Process; $all | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='parentPid';Expression={$_.ParentProcessId}},@{Name='executable';Expression={$_.ExecutablePath}},@{Name='commandLine';Expression={$_.CommandLine}} | ConvertTo-Json -Compress -Depth 3";
    const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (output === '') return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), commandLine: match[3] }];
  });
}

function descendantOf(processList, childPid, ancestorPid) {
  const byPid = new Map(processList.map(item => [Number(item.pid), item]));
  let current = byPid.get(Number(childPid));
  const seen = new Set();
  while (current !== undefined && !seen.has(Number(current.pid))) {
    const parent = Number(current.parentPid);
    if (parent === Number(ancestorPid)) return true;
    seen.add(Number(current.pid));
    current = byPid.get(parent);
  }
  return false;
}

async function hostProcessFor(mainPid) {
  const expectedNode = resolve(hostNode);
  return waitUntil(async () => {
    const processes = await processSnapshot();
    return processes.find(item => {
      if (Number(item.pid) === Number(mainPid)) return false;
      const commandLine = typeof item.commandLine === 'string' ? item.commandLine.toLowerCase() : '';
      const executable = typeof item.executable === 'string' ? resolve(item.executable) : '';
      const sameRuntime = process.platform === 'win32'
        ? executable.toLowerCase() === expectedNode.toLowerCase()
        : commandLine.includes(expectedNode.toLowerCase());
      return sameRuntime
        && commandLine.includes('host-entry.js')
        && descendantOf(processes, item.pid, mainPid);
    }) ?? false;
  }, 25_000, 'packaged_node_host_process');
}

async function hostProcessGone(pid) {
  return waitUntil(async () => !(await processSnapshot()).some(item => Number(item.pid) === Number(pid)), 15_000, 'old_host_process_exit');
}

function killHostImmediately(pid) {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFileSync(taskkill, ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

async function prepareIsolatedWorkspace() {
  const preflightEnvironment = { ...environment };
  delete preflightEnvironment[modelApiKeyName];
  const preflight = spawn(hostNode, [hostEntry, hostCli], {
    cwd: resolve(resourcesDirectory, 'app'),
    env: preflightEnvironment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  processIds.preflightHost = preflight.pid;
  const preflightExit = new Promise((resolvePromise, reject) => {
    preflight.once('error', reject);
    preflight.once('exit', (code, signal) => {
      processIds.preflightHostExitCode = code;
      resolvePromise({ code, signal });
    });
  });
  const response = new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('preflight_host_rpc_timeout')), 20_000);
    preflight.stdout.setEncoding('utf8');
    preflight.stdout.on('data', chunk => {
      output += chunk;
      let end = output.indexOf('\n');
      while (end >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        if (line !== '') {
          try {
            const frame = JSON.parse(line);
            if (frame.id === 'packaged-workspace-default') {
              clearTimeout(timer);
              resolvePromise(frame);
            }
          } catch {}
        }
        end = output.indexOf('\n');
      }
    });
    preflight.once('error', reject);
  });
  preflight.stderr.on('data', () => {
    // 读取并丢弃 Host 的标准错误输出，避免子进程因管道缓冲区已满而阻塞。
  });
  preflight.stdin.write(`${JSON.stringify({
    id: 'packaged-workspace-default',
    method: 'workspace.default.set',
    params: { directory: workspace, name: 'Packaged smoke project' },
  })}\n`);
  const frame = await response;
  if (frame.error !== undefined) throw new Error(`preflight_workspace_failed:${frame.error.code ?? 'host_error'}`);
  preflight.stdin.end();
  preflight.disconnect();
  const { code, signal } = await preflightExit;
  if (code !== 0) throw new Error(`preflight_host_exit:${code}:${signal ?? ''}`);
  return frame.result;
}

let rpcSequence = 0;
async function hostCall(method, params = {}) {
  rpcSequence += 1;
  const id = `packaged-smoke-${rpcSequence}`;
  const frame = JSON.stringify({ id, method, params });
  const expression = `(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const raw = window.__packagedSmokeFrames.find(value => {
        try { return JSON.parse(value).id === ${JSON.stringify(id)}; } catch { return false; }
      });
      if (raw !== undefined) return JSON.parse(raw);
      const fault = window.__packagedSmokeFaults[0];
      if (fault !== undefined) throw new Error(fault);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    throw new Error('host_rpc_timeout');
  })()`;
  const response = await devTools.evaluate(expression, 25_000);
  if (response?.error !== undefined) throw new Error(`${response.error.code ?? 'host_error'}:${response.error.message ?? ''}`);
  if (response?.id !== id) throw new Error('host_response_id_mismatch');
  return response;
}

async function notifyHost(method, params = {}) {
  rpcSequence += 1;
  const id = `packaged-smoke-${rpcSequence}`;
  const frame = JSON.stringify({ id, method, params });
  const sent = await devTools.evaluate(`(async () => {
    await window.liguleDesktop.sendHostFrame(${JSON.stringify(frame)});
    return true;
  })()`, 10_000);
  if (sent !== true) throw new Error('host_notification_not_sent');
}

async function providerGateState() {
  if (providerGate === undefined) throw new Error('provider_gate_missing');
  const response = await fetch(`http://127.0.0.1:${providerGate.port}/__state`);
  if (!response.ok) throw new Error('provider_gate_status_unavailable');
  return await response.json();
}

async function captureEvidence(name = 'packaged-smoke.png') {
  if (devTools === undefined || devTools.closed) return;
  const image = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(evidenceRoot, name), Buffer.from(image.data, 'base64'), { flag: 'wx' });
}

async function enumerateFiles(root) {
  const results = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else results.push(path);
    }
  };
  await visit(root);
  return results;
}

async function sessionJsonl(sessionId) {
  const files = (await enumerateFiles(sessionRecordDirectory)).filter(path => path.endsWith('.jsonl'));
  for (const path of files) {
    const content = await readFile(path, 'utf8');
    const records = content.split(/\r?\n/u).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (records.some(record => record.sessionId === sessionId || record.id === sessionId)) return { path, content, records };
  }
  throw new Error('persisted_interrupted_session_missing');
}

async function startUiSession(input) {
  const target = JSON.stringify(input);
  await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('composer_controls_missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) throw new Error('composer_value_setter_missing');
    setter.call(textarea, ${target});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    const send = document.querySelector('button.send');
    return textarea instanceof HTMLTextAreaElement
      && send instanceof HTMLButtonElement
      && textarea.value === ${target}
      && !textarea.readOnly
      && !send.disabled;
  })()`), 10_000, 'composer_send_ready');
  await devTools.evaluate(`document.querySelector('button.send').click(); true`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const files = (await enumerateFiles(sessionRecordDirectory)).filter(path => path.endsWith('.jsonl'));
    for (const path of files) {
      const records = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const user = records.find(record => record.kind === 'user' && record.text === input);
      if (user !== undefined) {
        const header = records.find(record => record.kind === 'session');
        if (typeof header?.sessionId === 'string') return header.sessionId;
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw new Error('ui_session_start_timeout');
}

async function setInitialPermission(profile, network) {
  await devTools.evaluate(`document.querySelector('button.permission-trigger')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`document.querySelector('.permission-panel select') instanceof HTMLSelectElement`), 10_000, 'initial_permission_picker_open');
  const changed = await devTools.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.permission-panel select')];
    if (selects.length !== 2 || selects.some(select => !(select instanceof HTMLSelectElement))) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(selects[0], ${JSON.stringify(profile)});
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    setter.call(selects[1], ${JSON.stringify(network)});
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (changed !== true) throw new Error('initial_permission_controls_missing');
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const apply = document.querySelector('.permission-actions .primary-button');
    return apply instanceof HTMLButtonElement && !apply.disabled;
  })()`), 10_000, 'initial_permission_change_ready');
  await devTools.evaluate(`document.querySelector('.permission-actions .primary-button')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`!document.querySelector('.permission-panel')`), 10_000, 'initial_permission_applied');
  await devTools.evaluate(`document.querySelector('button.permission-trigger')?.click(); true`);
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.permission-panel select')];
    return selects.length === 2 && selects[0].value === ${JSON.stringify(profile)} && selects[1].value === ${JSON.stringify(network)};
  })()`), 10_000, 'initial_permission_applied_value');
  await devTools.evaluate(`document.querySelector('.permission-panel button[aria-label="收起权限"], .permission-panel button[aria-label="Close permissions"]')?.click(); true`);
}

async function remainingSessionLocks() {
  const files = await enumerateFiles(sessionRecordDirectory);
  return files.filter(path => /\.jsonl\.lock(?:[\\/]|$)/iu.test(path));
}

async function runInterruptedRequest(sessionId, alreadyStarted = false) {
  if (interruptionMode === undefined || providerGate === undefined) throw new Error('packaged_interruption_not_configured');
  const activeHost = await hostProcessFor(applicationProcess.pid);
  const initialHostPid = Number(activeHost.pid);
  if (typeof initialHostPid !== 'number') throw new Error('packaged_host_pid_missing');
  processIds.interruptedHost = initialHostPid;
  if (!alreadyStarted) {
    await notifyHost('run.start', {
      sessionId,
      input: '[LOCAL_PENDING_INTERRUPTION] 请用中文写一篇较长的说明，至少 800 字，不要调用工具。测试会在模型答复交给 Host 前中断本轮。',
    });
  }

  const gate = await waitUntil(async () => {
    const state = await providerGateState();
    return state.held || state.failure !== undefined ? state : false;
  }, 95_000, 'provider_request_held');
  if (gate.failure !== undefined) throw Object.assign(new Error('provider_gate_failed'), { code: gate.failure });
  const expectedRequests = interruptionMode === 'local' ? 5 : 1;
  if (gate.requests !== expectedRequests || gate.model !== 'deepseek-flash' || gate.maxTokens !== 1024) {
    throw Object.assign(new Error('provider_gate_request_metadata_invalid'), { code: 'provider_gate_request_metadata_invalid' });
  }
  if (interruptionMode === 'real' && gate.upstreamStatus !== 200) {
    throw Object.assign(new Error('official_provider_response_not_accepted'), { code: 'official_provider_response_not_accepted' });
  }
  const active = await hostCall('status.get', { sessionId });
  if (active.result?.running !== true) throw new Error('packaged_run_not_pending_before_host_kill');
  await captureEvidence('packaged-interruption-pending.png');

  killHostImmediately(initialHostPid);
  await hostProcessGone(initialHostPid);
  processIds.interruptedHost = initialHostPid;
  const reconnectSelector = `([...document.querySelectorAll('.banner[role="alert"] button')]
    .find(button => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null)`;
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 30_000, 'packaged_disconnect_banner');
  await captureEvidence('packaged-interruption-disconnected.png');
  await devTools.evaluate(`(${reconnectSelector}).click(); true`);
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} === null`), 30_000, 'packaged_reconnect_banner_clear');
  await devTools.evaluate('window.__packagedSmokeFaults.length = 0; true');
  const newHost = await hostProcessFor(applicationProcess.pid);
  processIds.reconnectedHost = Number(newHost.pid);
  if (Number(newHost.pid) === initialHostPid) throw new Error('packaged_host_pid_not_replaced');

  let reconnectReadError;
  await waitUntil(async () => {
    try {
      const ready = await hostCall('session.read', { sessionId, fullResults: true });
      return ready.result?.header?.projectRoot === workspace;
    } catch (error) {
      reconnectReadError = error instanceof Error ? error.message : String(error);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      return false;
    }
  }, 30_000, 'reconnected_host_rpc_ready').catch(() => {
    const safe = reconnectReadError?.toLowerCase().replace(/[^a-z0-9]+/gu, '_').slice(0, 80);
    throw new Error(safe ? `reconnected_host_rpc_${safe}` : 'reconnected_host_rpc_timeout');
  });
  const read = await hostCall('session.read', { sessionId, fullResults: true });
  const status = await hostCall('status.get', { sessionId });
  const events = read.result?.events ?? [];
  const turns = events.filter(event => event.kind === 'turn');
  if (status.result?.running !== false) throw new Error('interrupted_session_still_running_after_reopen');
  const expectedTurns = interruptionMode === 'local' ? 3 : 1;
  if (turns.length !== expectedTurns || turns.at(-1)?.status !== 'interrupted' || turns.at(-1)?.code !== 'host_restarted') {
    const observed = turns.length === expectedTurns ? `${turns.at(-1)?.status}_${turns.at(-1)?.code ?? 'none'}` : `turn_count_${turns.length}`;
    throw Object.assign(new Error('interrupted_session_terminal_record_invalid'), { code: `session_${observed}` });
  }
  if (events.some(event => event.kind === 'tool' && event.seq > turns.at(-1).userSeq)) {
    throw new Error('interrupted_model_call_dispatched_a_tool');
  }
  const persisted = await sessionJsonl(sessionId);
  const persistedTurns = persisted.records.filter(event => event.kind === 'turn');
  if (persistedTurns.length !== expectedTurns || persistedTurns.at(-1)?.status !== 'interrupted' || persistedTurns.at(-1)?.code !== 'host_restarted') {
    throw new Error('persisted_interrupted_turn_invalid');
  }
  if (interruptionMode === 'real' && providerGate.containsCredential(persisted.content)) {
    throw new Error('synthetic_credential_in_session');
  }

  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
  const after = await providerGateState();
  if (after.requests !== expectedRequests || after.held !== true) throw new Error('provider_request_replayed_after_host_restart');
  if (interruptionMode === 'real' && after.clientClosed !== true) throw new Error('held_official_response_not_closed_after_host_kill');
  await captureEvidence('packaged-interruption-reconnected.png');
  return `${interruptionMode === 'real' ? '官方模型单次请求 HTTP 200，响应由本地 gate 暂扣' : '本地 HTTP SSE 请求已收到并保持未终止'}；Host ${initialHostPid} 被终止，Session 写入唯一 interrupted/host_restarted，重连后请求数仍为 ${expectedRequests}`;
}

async function runNoSessionReconnect() {
  const initialHost = Number(processIds.initialHost);
  if (!Number.isSafeInteger(initialHost)) throw new Error('initial_host_pid_missing');
  await waitUntil(async () => await devTools.evaluate(`(() => {
    const textarea = document.querySelector('textarea.composer-input');
    const workspace = document.querySelector('button.workspace-choice');
    const model = document.querySelector('button.composer-choice');
    const prefsFailure = [...document.querySelectorAll('.center .banner[role="alert"]')]
      .some(banner => /无法保存更改|Could not save changes/u.test(banner.textContent ?? ''));
    return textarea instanceof HTMLTextAreaElement
      && workspace instanceof HTMLButtonElement
      && model instanceof HTMLButtonElement
      && !textarea.readOnly
      && !workspace.disabled
      && !model.disabled
      && !prefsFailure;
  })()`), 30_000, 'initial_preferences_ready');
  const currentWorkspace = await devTools.evaluate(`document.querySelector('button.workspace-choice')?.title ?? ''`);
  if (currentWorkspace !== workspace) {
    await devTools.evaluate(`document.querySelector('button.workspace-choice').click(); true`);
    await waitUntil(async () => await devTools.evaluate(`([...document.querySelectorAll('[role="option"]')].some(option => option.title === ${JSON.stringify(workspace)}))`), 15_000, 'default_workspace_option_loaded');
    await devTools.evaluate(`([...document.querySelectorAll('[role="option"]')].find(option => option.title === ${JSON.stringify(workspace)})?.click(), true)`);
    await waitUntil(async () => await devTools.evaluate(`document.querySelector('button.workspace-choice')?.title === ${JSON.stringify(workspace)}`), 15_000, 'default_workspace_selected');
  }
  if (interruptionMode !== undefined) {
    await waitUntil(async () => await devTools.evaluate(`(document.querySelector('button.composer-choice')?.textContent ?? '').includes('deepseek-flash')`), 15_000, 'interruption_model_loaded');
  }
  killHostImmediately(initialHost);
  await hostProcessGone(initialHost);
  const reconnectSelector = `([...document.querySelectorAll('.banner[role="alert"] button')]
    .find(button => /重新连接|Reconnect/u.test(button.textContent ?? '')) ?? null)`;
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} !== null`), 30_000, 'empty_session_disconnect_banner');
  await captureEvidence('packaged-empty-session-disconnected.png');
  await devTools.evaluate(`(${reconnectSelector}).click(); true`);
  await waitUntil(async () => await devTools.evaluate(`${reconnectSelector} === null`), 30_000, 'empty_session_reconnect_banner_clear');
  await devTools.evaluate('window.__packagedSmokeFaults.length = 0; true');
  const newHost = await hostProcessFor(applicationProcess.pid);
  const newPid = Number(newHost.pid);
  if (newPid === initialHost) throw new Error('empty_session_host_pid_not_replaced');
  await waitUntil(async () => {
    try {
      const roster = await hostCall('workspaces.list');
      return Array.isArray(roster.result?.workspaces);
    } catch {
      return false;
    }
  }, 30_000, 'empty_session_host_rpc_ready');
  processIds.emptySessionReconnectHost = newPid;
  await captureEvidence('packaged-empty-session-reconnected.png');
  return `没有选中会话时终止 Host ${initialHost}，UI 重连后横幅清除，Host RPC 可用（新 Host ${newPid}）`;
}

async function runLocalApproval(sessionId, decision, alreadyStarted = false) {
  if (interruptionMode !== 'local' || providerGate === undefined) throw new Error('local_approval_fixture_not_configured');
  const marker = decision === 'deny' ? '[LOCAL_APPROVAL_DENY]' : '[LOCAL_APPROVAL_ALLOW]';
  const expectedRequest = decision === 'deny' ? 1 : 3;
  const proofPath = join(workspace, decision === 'deny' ? 'approval-denied-proof.txt' : 'approval-allowed-proof.txt');
  if (!alreadyStarted) await notifyHost('run.start', { sessionId, input: `${marker} 通过 create 工具写入审批验收文件。` });
  const gate = await waitUntil(async () => {
    const current = await providerGateState();
    return current.requests >= expectedRequest || current.failure !== undefined ? current : false;
  }, 30_000, `local_${decision}_provider_request`);
  if (gate.failure !== undefined || gate.requests !== expectedRequest || gate.localActions.at(-1) !== `approval_${decision}`) {
    throw new Error(`local_${decision}_provider_fixture_failed`);
  }
  await waitUntil(async () => await devTools.evaluate(`document.querySelector('.approval-actions button[data-tone="${decision}"]') !== null`), 30_000, `local_${decision}_approval_card`);
  await devTools.evaluate(`document.querySelector('.approval-actions button[data-tone="${decision}"]').click(); true`);
  await waitUntil(async () => (await hostCall('status.get', { sessionId })).result?.running === false, 30_000, `local_${decision}_run_completion`);
  if (decision === 'deny') {
    if (existsSync(proofPath)) throw new Error('denied_approval_created_file');
  } else if (await readFile(proofPath, 'utf8') !== 'ALLOWED') {
    throw new Error('allowed_approval_file_content_invalid');
  }
  return decision === 'deny'
    ? '通过 packaged 审批卡拒绝后，目标文件不存在'
    : '通过 packaged 审批卡允许后，真实 create 工具写入目标文件且内容正确';
}

async function startApplication() {
  const stdout = interruptionMode === undefined ? createWriteStream(join(evidenceRoot, 'stdout.log')) : undefined;
  const stderr = interruptionMode === undefined ? createWriteStream(join(evidenceRoot, 'stderr.log')) : undefined;
  applicationProcess = spawn(applicationExecutable, [
    `--user-data-dir=${userDataDirectory}`,
    '--remote-debugging-port=0',
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
  if (stdout !== undefined) applicationProcess.stdout.pipe(stdout);
  else applicationProcess.stdout.on('data', () => {});
  if (stderr !== undefined) applicationProcess.stderr.pipe(stderr);
  else applicationProcess.stderr.on('data', () => {});
  delete environment[modelApiKeyName];
  modelApiKey = undefined;
  processExit = new Promise(resolvePromise => applicationProcess.once('close', (code, signal) => resolvePromise({ code, signal })));
  processIds.main = applicationProcess.pid;
  return { stdout, stderr };
}

async function recordReport() {
  const report = {
    platform: process.platform,
    release: (await import('node:os')).release(),
    command: `${relative(repositoryRoot, applicationExecutable)} --user-data-dir=<isolated desktop/testplace/tmp> --remote-debugging-port=0`,
    applicationPid: processIds.main,
    hostNodeVersion: execFileSync(hostNode, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
    applicationPage: 'app://ligule/index.html',
    processIds,
    providerGate: providerGate === undefined ? undefined : {
      mode: providerGate.state.mode,
      requests: providerGate.state.requests,
      model: providerGate.state.model,
      maxTokens: providerGate.state.maxTokens,
      upstreamStatus: providerGate.state.upstreamStatus,
      held: providerGate.state.held,
      localActions: providerGate.state.localActions,
      failure: providerGate.state.failure,
      clientClosed: providerGate.state.clientClosed,
    },
    results,
    exitCode,
    timedOut,
  };
  await writeFile(join(evidenceRoot, 'packaged-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(evidenceRoot, 'packaged-smoke.log'), `${results.map(result => `${result.name} ${result.status}: ${result.detail}`).join('\n')}\n`, 'utf8');
}

async function runChecks() {
  await check('packaged application and pinned Host', async () => {
    const page = await connectDevTools();
    const appInfo = await devTools.evaluate(`({
      href: location.href,
      origin: location.origin,
      secure: isSecureContext,
      api: typeof window.liguleDesktop,
      methods: Object.keys(window.liguleDesktop ?? {}).sort(),
    })`);
    if (appInfo.href !== 'app://ligule/index.html') throw new Error(`unexpected_application_page:${appInfo.href}`);
    if (appInfo.origin !== 'app://ligule') throw new Error(`unexpected_application_origin:${appInfo.origin}`);
    if (appInfo.secure !== true || appInfo.api !== 'object') throw new Error('packaged_preload_api_unavailable');
    const requiredMethods = ['sendHostFrame', 'restartHost', 'onHostFrame', 'onHostFault', 'requestQuit'];
    for (const method of requiredMethods) if (!appInfo.methods.includes(method)) throw new Error(`preload_api_missing:${method}`);
    await devTools.evaluate(`(() => {
      window.__packagedSmokeFrames = [];
      window.__packagedSmokeFaults = [];
      window.liguleDesktop.onHostFrame(frame => window.__packagedSmokeFrames.push(frame));
      window.liguleDesktop.onHostFault(fault => window.__packagedSmokeFaults.push(fault));
      return true;
    })()`);
    const host = await hostProcessFor(applicationProcess.pid);
    processIds.initialHost = Number(host.pid);
    processIds.hostExecutable = host.executable;
    processIds.hostCommandLine = host.commandLine;
    return `来源 ${appInfo.origin}，Host PID ${host.pid} 使用 ${reportVersion(hostNode)}`;
  });

  let sessionId;
  await check('reconnect the packaged Host with no selected session', async () => {
    return await runNoSessionReconnect();
  });
  await check('create session through the packaged Preload and Host', async () => {
    const created = await hostCall('session.create', { projectRoot: workspace, workspaceOrigin: 'explicit' });
    sessionId = created.result?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('host_session_create_missing_id');
    const label = await hostCall('session.label', { sessionId, name: 'Packaged smoke record' });
    if (label.result?.name !== 'Packaged smoke record') throw new Error('host_session_label_not_saved');
    const roster = await hostCall('workspaces.list');
    if (!roster.result?.workspaces?.some(item => resolve(item.directory).toLowerCase() === resolve(workspace).toLowerCase())) {
      throw new Error('isolated_workspace_not_registered_by_host');
    }
    return `Host 创建会话 ${sessionId} 并登记隔离工作区`;
  });

  await check('read session and query status through the packaged Host', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const read = await hostCall('session.read', { sessionId, fullResults: true });
    if (read.result?.header?.projectRoot === undefined) throw new Error('session_read_missing_header');
    const status = await hostCall('status.get', { sessionId });
    if (status.result?.sessionId !== sessionId || status.result?.running !== false) throw new Error('session_status_invalid');
    return `读取会话头和状态，事件数 ${status.result.eventCount}`;
  });

  await check('export through Host RPC to the isolated test path', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const exported = await hostCall('session.export', { sessionId, path: exportPath });
    const content = await readFile(exportPath, 'utf8');
    if (!exported.result?.written?.includes(exportPath)) throw new Error('host_export_path_not_reported');
    if (!content.includes(sessionId) || !content.includes(workspace)) throw new Error('host_export_content_invalid');
    return `仅通过 Host session.export 写入隔离路径，字节数 ${(await stat(exportPath)).size}`;
  });

  await check('export over an existing target through Host RPC', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const before = await stat(exportPath).then(item => item.size, () => 0);
    const twice = await hostCall('session.export', { sessionId, path: exportPath });
    const content = await readFile(exportPath, 'utf8');
    if (!twice.result?.written?.includes(exportPath)) throw new Error('host_export_path_not_reported');
    if (!content.includes(sessionId) || !content.includes(workspace)) throw new Error('host_export_content_invalid');
    const after = Buffer.byteLength(content, 'utf8');
    if (after !== before) throw new Error(`host_export_existing_target_length_drift:${before}->${after}`);
    return `同一路径第二次导出由 Host 覆盖而非追加，长度保持 ${after} 字节`;
  });

  await check('restart the real packaged Host and recover the session', async () => {
    if (sessionId === undefined) throw new Error('session_not_created');
    const oldHost = await hostProcessFor(applicationProcess.pid);
    const oldPid = Number(oldHost.pid);
    await devTools.evaluate('window.liguleDesktop.restartHost()');
    await hostProcessGone(oldPid);
    const newHost = await hostProcessFor(applicationProcess.pid);
    const newPid = Number(newHost.pid);
    processIds.restartedHost = newPid;
    if (newPid === oldPid) throw new Error('host_pid_did_not_change_after_restart');
    await hostCall('session.open', { sessionId, projectRoot: workspace });
    const read = await hostCall('session.read', { sessionId, fullResults: true });
    const status = await hostCall('status.get', { sessionId });
    if (read.result?.header?.projectRoot === undefined || status.result?.sessionId !== sessionId) {
      throw new Error('old_session_record_not_recovered');
    }
    return `Host PID ${oldPid} 已结束；新 PID ${newPid} 接回旧会话并读回记录`;
  });

  if (interruptionMode === undefined) {
    await check('clipboard write permission from the packaged secure page', async () => {
      await devTools.call('Page.bringToFront');
      await waitUntil(async () => await devTools.evaluate('document.hasFocus()'), 5_000, 'packaged_window_focus');
      const value = `Ligule packaged smoke ${Date.now()}`;
      const result = await devTools.evaluate(`(async () => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return { available: false };
        await navigator.clipboard.writeText(${JSON.stringify(value)});
        return { available: true };
      })()`);
      if (result.available !== true) throw new Error('clipboard_writeText_unavailable');
      return 'navigator.clipboard.writeText 接受测试文本；没有读取系统剪贴板';
    });
  } else {
    record('clipboard write permission from the packaged secure page', '未执行', '请求中断验收不触碰系统剪贴板');
  }

  if (interruptionMode === undefined) {
    record(
      'unanswered Host promise across restart',
      '未执行',
      '隔离环境没有真实模型服务，无法建立可复现的未答 run.start；没有伪造模型或 Host 响应',
    );
  } else {
    if (interruptionMode === 'local') {
      await check('local model tool approval denial and allowance', async () => {
        if (sessionId === undefined) throw new Error('session_not_created');
        await setInitialPermission('workspace-write', 'policy');
        sessionId = await startUiSession('[LOCAL_APPROVAL_DENY] 通过 create 工具写入审批验收文件。');
        const denied = await runLocalApproval(sessionId, 'deny', true);
        const allowed = await runLocalApproval(sessionId, 'allow');
        return `以工作区可写、网络按 Policy 限制创建会话；${denied}；${allowed}`;
      });
    } else if (interruptionMode === 'real') {
      await check('start the official model request from the selected UI session', async () => {
        sessionId = await startUiSession('请用中文写一段较长的说明，不要调用工具。测试会在模型完整答复交给 Host 前中断本轮。');
        return `通过 packaged UI composer 创建并选中 Session ${sessionId}，由真实 UI 发送唯一官方模型请求`;
      });
    }
    await check('pending provider request, Host interruption, and session recovery', async () => {
      if (sessionId === undefined) throw new Error('session_not_created');
      return await runInterruptedRequest(sessionId, interruptionMode === 'real');
    });
  }

  await check('capture packaged window evidence', async () => {
    await captureEvidence();
    return '保存实际 packaged BrowserWindow 截图';
  });
}

function reportVersion(nodePath) {
  return execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
}

async function closeApplication() {
  if (applicationProcess === undefined || applicationProcess.exitCode !== null) return;
  if (devTools !== undefined && !devTools.closed) {
    try { await devTools.evaluate('window.liguleDesktop.requestQuit()', 10_000); } catch {}
  }
  let gracefulTimer;
  const graceful = await Promise.race([
    processExit.then(() => true),
    new Promise(resolvePromise => { gracefulTimer = setTimeout(() => resolvePromise(false), 25_000); }),
  ]);
  clearTimeout(gracefulTimer);
  if (!graceful && applicationProcess.exitCode === null) {
    timedOut = true;
    applicationProcess.kill();
    let killTimer;
    await Promise.race([processExit, new Promise(resolvePromise => { killTimer = setTimeout(resolvePromise, 15_000); })]);
    clearTimeout(killTimer);
  }
}

async function run() {
  await check('isolate default workspace through a real Node 24 Host RPC', async () => {
    const result = await prepareIsolatedWorkspace();
    const registered = result.workspaces?.find(item => resolve(item.directory).toLowerCase() === resolve(workspace).toLowerCase());
    if (registered === undefined || result.default !== registered.identity) throw new Error('host_default_workspace_mismatch');
    return `预检 Host PID ${processIds.preflightHost} 通过 workspace.default.set 登记隔离工作区并正常退出`;
  });
  if (exitCode !== 0) {
    record('packaged application launch', '未执行', '隔离工作区预检失败；未启动 packaged application');
    await recordReport();
    return;
  }

  const { stdout, stderr } = await startApplication();
  const deadline = setTimeout(() => { timedOut = true; applicationProcess.kill(); }, 150_000);
  try {
    await runChecks();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interruptionMode === undefined) {
      record('packaged smoke harness', '失败', message.split('\n')[0].slice(0, 300));
    } else {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : error instanceof Error && /^[a-z][a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : 'packaged_interruption_harness_failed';
      record('packaged smoke harness', '失败', `隔离验收步骤失败，错误码 ${code}`);
    }
    exitCode = 1;
  } finally {
    await closeApplication();
    clearTimeout(deadline);
    if (applicationProcess.exitCode !== null) processIds.applicationExitCode = applicationProcess.exitCode;
    try {
      const locks = await remainingSessionLocks();
      if (applicationProcess.exitCode === 0 && locks.length === 0) {
        record('Host session lock cleanup', '通过', '退出后隔离数据根中没有遗留 .jsonl.lock');
      } else {
        record('Host session lock cleanup', applicationProcess.exitCode === null || locks.length > 0 ? '失败' : '未执行', `exit=${applicationProcess.exitCode}; locks=${locks.length}`);
        if (applicationProcess.exitCode !== 0) exitCode = 1;
      }
    } catch (error) {
      record('Host session lock cleanup', '失败', error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
    if (timedOut || applicationProcess.exitCode !== 0) exitCode = 1;
    try { await recordReport(); } catch { exitCode = 1; }
    devTools?.socket.close();
    stdout?.end();
    stderr?.end();
    try {
      await Promise.all([stdout, stderr].filter(stream => stream !== undefined).map(stream => finished(stream)));
    } catch {
      exitCode = 1;
    }
  }
}

try {
  await run();
} finally {
  await providerGate?.close();
}

const relativeTemporary = relative(testRoot, temporaryRoot);
if (relativeTemporary === '' || relativeTemporary === '..' || relativeTemporary.startsWith(`..${sep}`) || resolve(testRoot, relativeTemporary) !== temporaryRoot) {
  throw new Error('packaged_smoke_temp_path_escaped_testplace');
}
if (exitCode === 0 && applicationProcess?.exitCode === 0) {
  await rm(temporaryRoot, { recursive: true, force: true });
} else {
  console.error(`packaged smoke temporary data retained at ${relative(testRoot, temporaryRoot)}`);
}

console.log(`${exitCode === 0 ? 'packaged smoke completed' : 'packaged smoke failed'}; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
process.exitCode = exitCode;
