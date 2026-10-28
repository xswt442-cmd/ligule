import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSessionLog } from '../../core/dist/index.js';
import { createRunAcceptance } from '../../core/dist/session/run.js';
import { spillContent } from '../../core/dist/kernel/result.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const corePackage = join(repository, 'core');
const helperSource = fileURLToPath(new URL('./export_session.mjs', import.meta.url));

async function packagedHelper(root) {
  const packageRoot = join(root, 'node_modules', 'ligule');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'ligule', dependencies: { '@ligule/core': '*' }, bundledDependencies: ['@ligule/core'],
  }));
  const bundledCore = join(packageRoot, 'node_modules', '@ligule', 'core');
  await mkdir(bundledCore, { recursive: true });
  await cp(join(corePackage, 'dist'), join(bundledCore, 'dist'), { recursive: true });
  await writeFile(join(bundledCore, 'package.json'), await readFile(join(corePackage, 'package.json')));
  const helperPath = join(packageRoot, 'export_session.mjs');
  await writeFile(helperPath, await readFile(helperSource));
  return import(pathToFileURL(helperPath).href);
}

async function seedSession(homeDirectory) {
  const sessionDirectory = join(homeDirectory, 'sessions');
  await mkdir(sessionDirectory, { recursive: true });
  const sessionId = 'harbor-session';
  const run = createRunAcceptance(sessionId, 'inspect the task', null, 'harbor-test');
  const session = createSessionLog({ directory: sessionDirectory, id: sessionId });
  const user = await session.append({ kind: 'user', text: 'inspect the task', run });
  await session.append({ kind: 'usage', ignorable: true, input: 30, output: null, estimated: 25, measurement: 'request-v1' });
  await session.append({ kind: 'assistant', text: 'Reading a private file', toolCalls: [
    { id: 'call-spill', name: 'read', args: { path: '/private/task/secret.txt' } },
  ] });
  const spillName = 'result-1761599940000-a1b2c3d4.json';
  const fullOutput = 'sensitive tool output\n'.repeat(300);
  const truncated = await spillContent(fullOutput, { limit: 300, directory: sessionDirectory, name: spillName });
  await session.append({ kind: 'tool', tool: 'read', callId: 'call-spill', args: { path: '/private/task/secret.txt' },
    result: { kind: 'result', failed: false, content: truncated, spilled: spillName, spillFormat: 'text' } });
  await session.append({ kind: 'assistant', text: 'Done.', toolCalls: [] });
  await session.append({ kind: 'turn', ignorable: true, status: 'failed', userSeq: user.seq, runId: run.runId, code: 'task_failed' });
  await session.close();
  return { sessionDirectory, sessionId, runId: run.runId, fullOutput };
}

test('reads a real trial Session, restores a spill, and exports through the Core package subpath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-harbor-atif-'));
  try {
    const helper = await packagedHelper(root);
    const homeDirectory = join(root, 'trial-home');
    await mkdir(homeDirectory);
    const source = await seedSession(homeDirectory);
    const logsDirectory = join(root, 'logs', 'agent');
    const redacted = await helper.exportSession({
      homeDirectory,
      ...source,
      agentVersion: '0.1.1-dev',
      modelName: 'test-model',
      logsDirectory,
    });
    assert.equal(redacted.schema_version, 'ATIF-v1.8');
    assert.equal(redacted.session_id, source.runId);
    const agent = redacted.steps.find((step) => step.source === 'agent' && step.tool_calls);
    assert.equal(agent.observation.results[0].content, '[redacted]');
    assert.equal(agent.observation.results[0].extra.ligule.outcome, 'completed');
    assert.equal(JSON.stringify(redacted).includes('sensitive tool output'), false);
    assert.equal(JSON.stringify(redacted).includes('/private/task/secret.txt'), false);
    if (process.env.LIGULE_ATIF_OUTPUT_PATH) {
      await copyFile(join(logsDirectory, 'trajectory.json'), process.env.LIGULE_ATIF_OUTPUT_PATH);
    }

    const sensitiveLogs = join(root, 'sensitive-logs', 'agent');
    const sensitive = await helper.exportSession({
      homeDirectory,
      ...source,
      agentVersion: '0.1.1-dev',
      modelName: 'test-model',
      logsDirectory: sensitiveLogs,
      includeSensitiveContent: true,
    });
    const sensitiveAgent = sensitive.steps.find((step) => step.source === 'agent' && step.tool_calls);
    assert.equal(sensitiveAgent.observation.results[0].content, source.fullOutput);
    assert.equal(sensitiveAgent.tool_calls[0].arguments.path, '/private/task/secret.txt');
    assert.equal(JSON.parse(await readFile(join(logsDirectory, 'trajectory.json'), 'utf8')).schema_version, 'ATIF-v1.8');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects missing spill content and never emits a partial trajectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-harbor-atif-missing-'));
  try {
    const helper = await packagedHelper(root);
    const homeDirectory = join(root, 'trial-home');
    await mkdir(homeDirectory);
    const source = await seedSession(homeDirectory);
    await rm(join(source.sessionDirectory, 'result-1761599940000-a1b2c3d4.json'));
    const logsDirectory = join(root, 'logs', 'agent');
    await assert.rejects(helper.exportSession({
      homeDirectory,
      ...source,
      agentVersion: '0.1.1-dev',
      logsDirectory,
    }), /ligule_export_file_missing/u);
    await assert.rejects(readFile(join(logsDirectory, 'trajectory.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a claimed state that differs from the canonical Session terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-harbor-atif-state-'));
  try {
    const helper = await packagedHelper(root);
    const homeDirectory = join(root, 'trial-home');
    await mkdir(homeDirectory);
    const source = await seedSession(homeDirectory);
    await assert.rejects(helper.exportSession({
      homeDirectory,
      ...source,
      agentVersion: '0.1.1-dev',
      logsDirectory: join(root, 'logs', 'agent'),
      expectedState: 'completed',
    }), /ligule_export_run_terminal_mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('machine CLI parser filters response bodies and rejects localized output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-harbor-cli-'));
  try {
    const helper = await packagedHelper(root);
    const parsed = helper.parseCliResult(JSON.stringify({
      version: 1, status: 'completed', state: 'completed', sessionId: 's', runId: 'r',
      usage: { modelCalls: 2 }, text: 'private answer',
    }), 0);
    assert.deepEqual(parsed, { version: 1, status: 'completed', state: 'completed', sessionId: 's', runId: 'r', usage: { modelCalls: 2 } });
    assert.throws(() => helper.parseCliResult('任务完成', 0), /ligule_cli_result_invalid_json/u);
    assert.throws(() => helper.parseCliResult(JSON.stringify({ version: 1, status: 'completed', state: 'completed' }), 1), /terminal_mismatch/u);
    assert.throws(() => helper.parseCliResult(JSON.stringify({ version: 1, status: 'failed', state: 'completed' }), 1), /terminal_mismatch/u);
    const cliEnv = helper.buildCliEnvironment({
      PATH: '/usr/bin', HOME: '/home/agent', TMPDIR: '/tmp', HTTPS_PROXY: 'http://proxy.example.test',
      https_proxy: 'http://lower-proxy.example.test', NODE_EXTRA_CA_CERTS: '/etc/ssl/custom.pem',
      LIGULE_API_KEY: 'selected-secret', OTHER_API_KEY: 'unselected-secret',
    }, '/tmp/ligule-home', 'LIGULE_API_KEY');
    assert.deepEqual(cliEnv, {
      PATH: '/usr/bin', HOME: '/home/agent', TMPDIR: '/tmp', HTTPS_PROXY: 'http://proxy.example.test',
      https_proxy: 'http://lower-proxy.example.test', NODE_EXTRA_CA_CERTS: '/etc/ssl/custom.pem',
      LIGULE_HOME: '/tmp/ligule-home', LIGULE_API_KEY: 'selected-secret',
    });
    assert.throws(() => helper.buildCliEnvironment({ PATH: '/usr/bin' }, '/tmp/ligule-home', 'PATH'), /environment_invalid/u);
    assert.throws(() => helper.buildCliEnvironment({ NODE_OPTIONS: '--require=bad.js' }, '/tmp/ligule-home', 'NODE_OPTIONS'), /environment_invalid/u);
    const argv = helper.buildCliArgs({
      instruction: 'solve the public task',
      sessionDirectory: '/tmp/ligule-home/sessions',
      api: 'chat-completions',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-name',
      apiKeyEnv: 'LIGULE_API_KEY',
      modelCalls: 5,
      timeoutMs: 60_000,
      requestTimeoutMs: 10_000,
    });
    assert.equal(argv.at(-1), 'solve the public task');
    assert.ok(argv.includes('loop.totalModelCalls=5'));
    assert.ok(argv.includes('policy.mode="auto"'));
    assert.throws(() => helper.buildCliArgs({
      instruction: 'x', sessionDirectory: '/tmp/sessions', api: 'messages', baseUrl: 'https://api.example.test',
      model: 'x', apiKeyEnv: 'LIGULE_API_KEY', modelCalls: 0, timeoutMs: 1000, requestTimeoutMs: 1000,
    }), /budget_invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminates the CLI process group when its runtime budget expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-harbor-cancel-'));
  try {
    const helper = await packagedHelper(root);
    const child = await helper.runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      env: process.env,
      timeoutMs: 100,
    });
    assert.equal(child.error.code, 'ETIMEDOUT');
    assert.notEqual(child.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
