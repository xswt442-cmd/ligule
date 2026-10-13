import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const electronDirectory = dirname(testDirectory);
const desktopDirectory = dirname(electronDirectory);
const repositoryRoot = dirname(desktopDirectory);
const workspaceRoot = dirname(dirname(repositoryRoot));
const testRoot = join(desktopDirectory, 'testplace');
const temporaryParent = join(testRoot, 'tmp');
const evidenceParent = join(testRoot, 'readings');
const executable = join(desktopDirectory, 'node_modules', 'electron', 'dist', 'electron.exe');
const harness = join(testDirectory, 'run-real-model.cjs');
const node = join(desktopDirectory, 'vendor', 'node', 'node.exe');
const cli = join(repositoryRoot, 'dist', 'cli.js');
const hostEntry = join(electronDirectory, 'dist', 'host-entry.js');
const frontend = join(desktopDirectory, 'frontend', 'dist', 'index.html');
const electronModules = ['secure-window.js', 'security.js', 'ipc.js', 'host.js', 'runtime.js', 'native.js', 'preload.js', 'host-entry.js']
  .map(name => join(electronDirectory, 'dist', name));
const credentialPath = join(workspaceRoot, 'testplace', 'TESTER.md');
const required = [executable, harness, node, cli, hostEntry, frontend, credentialPath, ...electronModules, join(desktopDirectory, 'assets', 'app-icon.png')];
const missing = required.filter(path => !existsSync(path));
if (process.platform !== 'win32') throw new Error('real_model_harness_requires_windows');
if (missing.length > 0) throw new Error(`real_model_prerequisite_missing:${missing.map(basename).join(',')}`);

function credentialsOf(contents) {
  const lines = contents.split(/\r?\n/u);
  const endpointLine = lines[8] ?? '';
  const credentialLine = lines[18] ?? '';
  const modelRow = lines[26] ?? '';
  const endpoint = endpointLine.match(/https?:\/\/[^\s)`]+/u)?.[0];
  const credential = credentialLine.split(/[:：]/u).at(-1)?.trim().replace(/^`|`$/gu, '');
  const model = modelRow.split('|').map(value => value.trim().replace(/^`|`$/gu, '')).find(value => value === 'Agents-A1');
  if (endpoint === undefined || credential === undefined || credential.length < 8 || model === undefined) {
    throw new Error('real_model_authorized_credential_record_invalid');
  }
  const parsed = new URL(endpoint);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('real_model_endpoint_invalid');
  }
  return { endpoint: endpoint.replace(/\/+$/u, ''), credential, model };
}

const authorized = credentialsOf(await readFile(credentialPath, 'utf8'));
await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryRoot = await mkdtemp(join(temporaryParent, `real-model-${runId}-`));
const evidenceRoot = join(evidenceParent, `real-model-${runId}`);
const isolatedHome = join(temporaryRoot, 'ligule-home');
const userData = join(temporaryRoot, 'electron-user-data');
const workspace = join(temporaryRoot, 'workspaces', 'project');
await Promise.all([
  mkdir(isolatedHome, { recursive: true }),
  mkdir(userData, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
]);
await writeFile(join(isolatedHome, 'config.toml'), [
  '[model]',
  'api = "chat-completions"',
  `baseURL = ${JSON.stringify(authorized.endpoint)}`,
  `model = ${JSON.stringify(authorized.model)}`,
  'apiKeyEnv = "LIGULE_API_KEY"',
  '',
  '[policy]',
  'mode = "ask"',
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 });

const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(name)) delete environment[name];
}
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[name];
environment.LIGULE_HOME = isolatedHome;
environment.LIGULE_API_KEY = authorized.credential;
environment.LIGULE_REAL_MODEL_WORKSPACE = workspace;
environment.LIGULE_REAL_MODEL_EVIDENCE = evidenceRoot;
environment.LIGULE_REAL_MODEL_USER_DATA = userData;

async function registerIsolatedWorkspace() {
  const preflight = spawn(node, [hostEntry, cli], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  preflight.stderr.on('data', () => {});
  let output = '';
  let responseTimer;
  const response = new Promise((resolvePromise, reject) => {
    responseTimer = setTimeout(() => {
      preflight.kill();
      reject(new Error('real_model_workspace_registration_timeout'));
    }, 20_000);
    preflight.once('error', error => { clearTimeout(responseTimer); reject(error); });
    preflight.stdout.setEncoding('utf8');
    preflight.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > 1024 * 1024) {
        clearTimeout(responseTimer);
        reject(new Error('real_model_workspace_registration_frame_too_large'));
        return;
      }
      let end = output.indexOf('\n');
      while (end >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === 'real-model-workspace-default') {
            clearTimeout(responseTimer);
            resolvePromise(frame);
          }
        } catch {}
        end = output.indexOf('\n');
      }
    });
  });
  const exit = new Promise((resolvePromise, reject) => {
    preflight.once('error', reject);
    preflight.once('exit', (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
  preflight.stdin.write(`${JSON.stringify({
    id: 'real-model-workspace-default',
    method: 'workspace.default.set',
    params: { directory: workspace, name: 'Real model verification' },
  })}\n`);
  try {
    const frame = await response;
    if (frame.error !== undefined) throw new Error(`real_model_workspace_registration_failed:${frame.error.code ?? 'host_error'}`);
    preflight.stdin.end();
    preflight.disconnect();
    const processExit = await exit;
    if (processExit.exitCode !== 0) throw new Error('real_model_workspace_registration_host_exit');
  } catch (error) {
    clearTimeout(responseTimer);
    if (preflight.exitCode === null) preflight.kill();
    await exit.catch(() => {});
    throw error;
  }
}

try {
  await registerIsolatedWorkspace();
} catch (error) {
  delete authorized.credential;
  delete environment.LIGULE_API_KEY;
  throw error;
}
delete authorized.credential;
delete authorized.endpoint;

const child = spawn(executable, [`--user-data-dir=${userData}`, harness], {
  cwd: repositoryRoot,
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
delete environment.LIGULE_API_KEY;
let standardOutput = '';
let standardError = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { standardOutput += chunk; });
child.stderr.on('data', chunk => { standardError += chunk; });
const timeout = setTimeout(() => child.kill(), 240_000);
const { code, signal } = await new Promise((resolvePromise, reject) => {
  child.once('error', reject);
  child.once('close', (exitCode, exitSignal) => resolvePromise({ code: exitCode, signal: exitSignal }));
});
clearTimeout(timeout);

const reportPath = join(evidenceRoot, 'real-model.json');
let harnessReport;
try {
  harnessReport = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  harnessReport = null;
}
const safeLines = standardOutput.split(/\r?\n/u).filter(line => line.startsWith('{')).flatMap(line => {
  try {
    const value = JSON.parse(line);
    if (typeof value.name === 'string' && typeof value.status === 'string') {
      return [{
        name: value.name,
        status: value.status,
        code: typeof value.code === 'string' ? value.code : undefined,
        detail: typeof value.detail === 'string' ? value.detail : undefined,
      }];
    }
  } catch {}
  return [];
});
standardOutput = '';
standardError = '';
const runReport = {
  command: 'node desktop/electron/test/run-real-model.mjs',
  platform: process.platform,
  electron: JSON.parse(await readFile(join(desktopDirectory, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  hostNode: (await import('node:child_process')).execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
  applicationPid: child.pid,
  exitCode: code,
  signal,
  harness: harnessReport,
  results: safeLines,
};
await writeFile(join(evidenceRoot, 'run.json'), `${JSON.stringify(runReport, null, 2)}\n`, 'utf8');
const relativeTemporary = relative(testRoot, temporaryRoot);
if (relativeTemporary === '' || relativeTemporary === '..' || relativeTemporary.startsWith(`..${sep}`)) {
  throw new Error('real_model_temp_path_escaped_testplace');
}

if (code === 0 && harnessReport !== null && harnessReport.results?.every(item => item.status === '通过' || item.status === '未执行')) {
  await rm(temporaryRoot, { recursive: true, force: true });
} else {
  console.error(`real model temporary data retained: ${relative(testRoot, temporaryRoot)}`);
}
if (code !== 0 || harnessReport === null || harnessReport.results?.some(item => item.status === '失败')) {
  console.error(`real model verification did not pass; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
  process.exitCode = 1;
} else {
  console.log(`real model verification completed; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
}
