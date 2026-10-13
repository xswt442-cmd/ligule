import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = dirname(dirname(scriptDirectory));
const repositoryRoot = dirname(desktopDirectory);
const appDirectoryArgument = process.argv.indexOf('--app-dir');
const suppliedAppDirectory = appDirectoryArgument >= 0 ? process.argv[appDirectoryArgument + 1] : undefined;
if (appDirectoryArgument >= 0 && (suppliedAppDirectory === undefined || !isAbsolute(suppliedAppDirectory))) {
  throw new Error('--app-dir_requires_an_absolute_directory');
}
const packagedDirectory = suppliedAppDirectory === undefined
  ? join(desktopDirectory, 'release', 'win-unpacked')
  : resolve(suppliedAppDirectory);
const applicationExecutable = join(packagedDirectory, 'ligule.exe');
const resourcesDirectory = join(packagedDirectory, 'resources');
const hostNode = join(resourcesDirectory, 'node', 'node.exe');
const hostCli = join(resourcesDirectory, 'app', 'dist', 'cli.js');
const hostEntry = join(resourcesDirectory, 'host-entry.js');
const testRoot = join(desktopDirectory, 'testplace');
const temporaryParent = join(testRoot, 'tmp');
const evidenceParent = join(testRoot, 'readings');
const requiredFiles = [applicationExecutable, hostNode, hostCli, hostEntry];
const missing = requiredFiles.filter(path => !existsSync(path));
if (process.platform !== 'win32') throw new Error('packaged_smoke_requires_windows');
if (missing.length > 0) throw new Error(`packaged_application_resources_missing:${missing.map(path => basename(path)).join(',')}`);

await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryRoot = await mkdtemp(join(temporaryParent, `packaged-smoke-${runId}-`));
const evidenceRoot = join(evidenceParent, `packaged-smoke-${runId}`);
const userDataDirectory = join(temporaryRoot, 'user-data');
const liguleHome = join(temporaryRoot, 'ligule-home');
const workspace = join(temporaryRoot, 'workspaces', 'project');
const exportDirectory = join(temporaryRoot, 'exports');
const exportPath = join(exportDirectory, 'session.md');
await Promise.all([
  mkdir(userDataDirectory, { recursive: true }),
  mkdir(liguleHome, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(exportDirectory, { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
]);

const environment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[key];
for (const key of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(key)) delete environment[key];
}
environment.LIGULE_HOME = liguleHome;

const results = [];
const processIds = {};
let applicationProcess;
let devTools;
let exitCode = 0;
let processExit;
let timedOut = false;

function record(name, status, detail) {
  const result = { name, status, detail };
  results.push(result);
  console.log(JSON.stringify(result));
}

async function check(name, action) {
  try {
    const detail = await action();
    record(name, '通过', detail ?? '实测符合预期');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(name, '失败', message.split('\n')[0].slice(0, 300));
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
  const expectedNode = resolve(hostNode).toLowerCase();
  return waitUntil(async () => {
    const processes = await processSnapshot();
    return processes.find(item => {
      if (Number(item.pid) === Number(mainPid)) return false;
      const executable = typeof item.executable === 'string' ? resolve(item.executable).toLowerCase() : '';
      const commandLine = typeof item.commandLine === 'string' ? item.commandLine.toLowerCase() : '';
      return executable === expectedNode
        && commandLine.includes('host-entry.js')
        && descendantOf(processes, item.pid, mainPid);
    }) ?? false;
  }, 25_000, 'packaged_node_host_process');
}

async function hostProcessGone(pid) {
  return waitUntil(async () => !(await processSnapshot()).some(item => Number(item.pid) === Number(pid)), 15_000, 'old_host_process_exit');
}

async function prepareIsolatedWorkspace() {
  const preflight = spawn(hostNode, [hostEntry, hostCli], {
    cwd: resolve(resourcesDirectory, 'app'),
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
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
    // Host stderr 只排空，不把其内容写进证据。
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

async function captureEvidence() {
  if (devTools === undefined || devTools.closed) return;
  const image = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(evidenceRoot, 'packaged-smoke.png'), Buffer.from(image.data, 'base64'));
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

async function remainingSessionLocks() {
  const files = await enumerateFiles(join(liguleHome, 'sessions'));
  return files.filter(path => /\.jsonl\.lock(?:[\\/]|$)/iu.test(path));
}

async function startApplication() {
  const stdout = createWriteStream(join(evidenceRoot, 'stdout.log'));
  const stderr = createWriteStream(join(evidenceRoot, 'stderr.log'));
  applicationProcess = spawn(applicationExecutable, [
    `--user-data-dir=${userDataDirectory}`,
    '--remote-debugging-port=0',
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  applicationProcess.stdout.pipe(stdout);
  applicationProcess.stderr.pipe(stderr);
  processExit = new Promise(resolvePromise => applicationProcess.once('close', (code, signal) => resolvePromise({ code, signal })));
  processIds.main = applicationProcess.pid;
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
    const oldPid = processIds.initialHost;
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

  await check('clipboard write permission from the packaged secure page', async () => {
    const value = `Ligule packaged smoke ${Date.now()}`;
    const result = await devTools.evaluate(`(async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return { available: false };
      await navigator.clipboard.writeText(${JSON.stringify(value)});
      return { available: true };
    })()`);
    if (result.available !== true) throw new Error('clipboard_writeText_unavailable');
    return 'navigator.clipboard.writeText 接受测试文本；没有读取系统剪贴板';
  });

  record(
    'unanswered Host promise across restart',
    '未执行',
    '隔离环境没有真实模型服务，无法建立可复现的未答 run.start；没有伪造模型或 Host 响应',
  );

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

  const stdout = createWriteStream(join(evidenceRoot, 'stdout.log'));
  const stderr = createWriteStream(join(evidenceRoot, 'stderr.log'));
  applicationProcess = spawn(applicationExecutable, [
    `--user-data-dir=${userDataDirectory}`,
    '--remote-debugging-port=0',
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  applicationProcess.stdout.pipe(stdout);
  applicationProcess.stderr.pipe(stderr);
  processExit = new Promise(resolvePromise => applicationProcess.once('close', (code, signal) => resolvePromise({ code, signal })));
  processIds.main = applicationProcess.pid;
  const deadline = setTimeout(() => { timedOut = true; applicationProcess.kill(); }, 150_000);
  try {
    await runChecks();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record('packaged smoke harness', '失败', message.split('\n')[0].slice(0, 300));
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
    stdout.end();
    stderr.end();
  }
}

await run();

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
