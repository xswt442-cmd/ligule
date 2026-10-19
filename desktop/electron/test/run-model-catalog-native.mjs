import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(dirname(testDirectory)));
const desktopRoot = join(repositoryRoot, 'desktop');
const node = join(desktopRoot, 'vendor', 'node', 'node.exe');
const electron = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const hostEntry = join(desktopRoot, 'electron', 'dist', 'host-entry.js');
const cli = join(repositoryRoot, 'core', 'dist', 'host', 'desktop-entry.js');
const harness = join(testDirectory, 'model-catalog-native.cjs');
const required = [node, electron, hostEntry, cli, harness, join(desktopRoot, 'frontend', 'dist', 'index.html'), ...['secure-window.js', 'security.js', 'ipc.js', 'host.js', 'runtime.js', 'native.js', 'preload.js'].map(name => join(desktopRoot, 'electron', 'dist', name))];
const missing = required.filter(path => !existsSync(path));
if (process.platform !== 'win32') throw new Error('model_catalog_native_requires_windows');
if (missing.length > 0) throw new Error(`model_catalog_native_prerequisite_missing:${missing.map(basename).join(',')}`);

const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryParent = join(desktopRoot, 'testplace', 'tmp');
const argumentPath = (name, fallback) => {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  return value === undefined ? fallback : value;
};
const evidenceParent = argumentPath('evidence-dir', join(desktopRoot, 'testplace', 'readings', 'model-catalog'));
const shotsParent = argumentPath('shots-dir', join(desktopRoot, 'testplace', 'shots', 'model-catalog'));
const evidenceRoot = join(evidenceParent, runId);
const shotsRoot = join(shotsParent, runId);
await Promise.all([mkdir(temporaryParent, { recursive: true }), mkdir(evidenceRoot, { recursive: true }), mkdir(shotsRoot, { recursive: true })]);
const temporaryRoot = await mkdtemp(join(temporaryParent, `model-catalog-${runId}-`));
const temporaryRelative = relative(resolve(temporaryParent), resolve(temporaryRoot));
if (temporaryRelative === '' || temporaryRelative === '..' || temporaryRelative.startsWith(`..${sep}`)) {
  throw new Error('model_catalog_temp_path_escaped_testplace');
}
const isolatedHome = join(temporaryRoot, 'ligule-home');
const userData = join(temporaryRoot, 'electron-user-data');
const workspace = join(temporaryRoot, 'workspace');
await Promise.all([mkdir(isolatedHome, { recursive: true }), mkdir(userData, { recursive: true }), mkdir(workspace, { recursive: true })]);

const requests = [];
const discoveryRequests = [];
let discoveryFailure = false;
let hangRequests = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/control/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requests, discoveryRequests, hang: hangRequests }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/control/discovery') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    discoveryFailure = body.failure === true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ failure: discoveryFailure }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/control/hang') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    hangRequests = body.hang === true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ hang: hangRequests }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const authorized = request.headers.authorization === 'Bearer model-catalog-synthetic-key';
    discoveryRequests.push({ authorized, status: !authorized ? 401 : discoveryFailure ? 503 : 200 });
  }
  if (request.headers.authorization !== 'Bearer model-catalog-synthetic-key') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"synthetic credential missing"}}');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    if (discoveryFailure) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"synthetic discovery failure"}}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ model: body.model, maxTokens: body.max_tokens, stream: body.stream === true });
    if (hangRequests) return;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `fixture-response:${body.model}:${body.max_tokens}` } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":{"message":"synthetic path not found"}}');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;

const environment = { ...process.env };
for (const name of Object.keys(environment)) if (/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE.?KEY|COOKIE|AUTH)/iu.test(name)) delete environment[name];
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_HOME', 'LIGULE_MODEL_CATALOG_KEY']) delete environment[name];
environment.LIGULE_HOME = isolatedHome;
environment.LIGULE_MODEL_CATALOG_KEY = 'model-catalog-synthetic-key';
environment.LIGULE_MODEL_CATALOG_ENDPOINT = endpoint;
environment.LIGULE_MODEL_CATALOG_REPOSITORY = repositoryRoot;
environment.LIGULE_MODEL_CATALOG_WORKSPACE = workspace;
environment.LIGULE_MODEL_CATALOG_USER_DATA = userData;
environment.LIGULE_MODEL_CATALOG_EVIDENCE = evidenceRoot;
environment.LIGULE_MODEL_CATALOG_SHOTS = shotsRoot;

async function registerWorkspace() {
  const preflight = spawn(node, [hostEntry, cli], { cwd: repositoryRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  preflight.stderr.on('data', () => {});
  let pending = '';
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('model_catalog_workspace_registration_timeout')), 20_000);
    preflight.once('error', error => { clearTimeout(timer); reject(error); });
    preflight.stdout.setEncoding('utf8');
    preflight.stdout.on('data', chunk => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === 'model-catalog-default-workspace') { clearTimeout(timer); resolve(frame); }
        } catch {}
        newline = pending.indexOf('\n');
      }
    });
  });
  preflight.stdin.write(`${JSON.stringify({ id: 'model-catalog-default-workspace', method: 'workspace.default.set', params: { directory: workspace, name: 'Model catalog native test' } })}\n`);
  const frame = await answer;
  if (frame.error !== undefined) throw new Error(`model_catalog_workspace_registration_failed:${frame.error.code ?? 'host_error'}`);
  preflight.stdin.end();
  preflight.disconnect();
  const exit = await new Promise(resolve => preflight.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, 'isolated_workspace_preflight_must_exit_cleanly');
}

async function runElectron(extraEnvironment = {}) {
  const child = spawn(electron, [`--user-data-dir=${userData}`, harness], {
    cwd: repositoryRoot, env: { ...environment, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 240_000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { exit, stdout, stderr };
}

let firstRun = { exit: { code: 1, signal: null }, stdout: '', stderr: '' };
let reopenRun = null;
try {
  await registerWorkspace();
  firstRun = await runElectron();
  let firstHarness = null;
  try { firstHarness = JSON.parse(await readFile(join(evidenceRoot, 'model-catalog.json'), 'utf8')); } catch {}
  if (firstRun.exit.code === 0 && firstHarness?.exitCode === 0 && firstHarness.results?.every(item => item.status === '通过' || item.status === '未执行')) {
    reopenRun = await runElectron({ LIGULE_MODEL_CATALOG_VERIFY_REOPEN: '1' });
  }
} finally {
  delete environment.LIGULE_MODEL_CATALOG_KEY;
  await new Promise(resolve => server.close(resolve));
}

let harnessReport = null;
try { harnessReport = JSON.parse(await readFile(join(evidenceRoot, 'model-catalog.json'), 'utf8')); } catch {}
let reopenReport = null;
if (reopenRun !== null) {
  try { reopenReport = JSON.parse(await readFile(join(evidenceRoot, 'model-catalog-reopen.json'), 'utf8')); } catch {}
}
const runReport = {
  command: 'desktop/vendor/node/node.exe desktop/electron/test/run-model-catalog-native.mjs',
  platform: process.platform,
  osRelease: (await import('node:os')).release(),
  electron: JSON.parse(await readFile(join(desktopRoot, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  hostNode: (await import('node:child_process')).execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
  endpoint: '127.0.0.1 synthetic HTTP protocol fixture',
  childExit: firstRun.exit,
  reopenExit: reopenRun?.exit ?? null,
  evidenceRoot: relative(repositoryRoot, evidenceRoot),
  shotsRoot: relative(repositoryRoot, shotsRoot),
  results: [...(harnessReport?.results ?? []), ...(reopenReport?.results ?? [])],
  discoveryRequests,
  providerRequests: requests,
};
await writeFile(join(evidenceRoot, 'run.json'), `${JSON.stringify(runReport, null, 2)}\n`, 'utf8');
const stdout = `${firstRun.stdout}${reopenRun?.stdout ?? ''}`;
const stderr = `${firstRun.stderr}${reopenRun?.stderr ?? ''}`;
if (stdout !== '') await writeFile(join(evidenceRoot, 'stdout.log'), stdout, 'utf8');
if (stderr !== '') await writeFile(join(evidenceRoot, 'stderr.log'), stderr, 'utf8');
if (firstRun.exit.code !== 0 || harnessReport === null || harnessReport.exitCode !== 0 || harnessReport.results.some(item => item.status === '失败')
  || reopenRun?.exit.code !== 0 || reopenReport === null || reopenReport.exitCode !== 0 || reopenReport.results.some(item => item.status === '失败')) {
  console.error(`Model catalog native verification failed; evidence: ${evidenceRoot}`);
  process.exitCode = 1;
} else {
  const resolvedTarget = resolve(temporaryRoot);
  const resolvedParent = resolve(temporaryParent);
  const checkedRelative = relative(resolvedParent, resolvedTarget);
  if (checkedRelative === '' || checkedRelative === '..' || checkedRelative.startsWith(`..${sep}`)) {
    throw new Error('model_catalog_temp_cleanup_target_invalid');
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  console.log(`Model catalog native verification completed; evidence: ${evidenceRoot}`);
}
