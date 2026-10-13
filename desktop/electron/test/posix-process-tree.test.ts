import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';

const ELECTRON_ROOT = resolve(import.meta.dirname, '..');
const DESKTOP_ROOT = resolve(ELECTRON_ROOT, '..');
const TEMP_ROOT = join(DESKTOP_ROOT, 'testplace', 'tmp');
const EVIDENCE_ROOT = join(DESKTOP_ROOT, 'testplace', 'readings');
const NODE = join(DESKTOP_ROOT, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const HOST_ENTRY = join(ELECTRON_ROOT, 'dist', 'host-entry.js');
const NODE_VERSION = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'node-pin.json'), 'utf8')).version as string;
const { HostController } = createRequire(join(ELECTRON_ROOT, 'package.json'))('./dist/host.js') as {
  HostController: new (options: {
    node: string;
    cli: string;
    entry?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    onFrame(frame: string): void;
    onFault(fault: string): void;
  }) => PosixHostController;
};
const evidence: Record<string, unknown> & { cases: Record<string, unknown>[] } = {
  nodeVersion: process.version,
  nodeExecutable: process.execPath,
  platform: process.platform,
  startedAt: new Date().toISOString(),
  cases: [],
};

test('HostController stop kills a detached POSIX Host and its real descendant process group', {
  skip: process.platform === 'win32' ? 'POSIX process groups require a Unix-like host' : false,
}, async () => {
  assert.equal(process.version, NODE_VERSION, `run this test with the vendored Node ${NODE_VERSION}`);
  assert.equal(await realpath(process.execPath), await realpath(NODE), 'run the test with the vendored standalone Node executable');

  await mkdir(TEMP_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEMP_ROOT, `posix-process-tree-${process.pid}-`));
  assertInsideTempRoot(root);
  const cli = await createCliFixture(root);

  const frames: string[] = [];
  const faults: string[] = [];
  const controller = new HostController({
    node: NODE,
    cli,
    cwd: root,
    env: { ...process.env },
    onFrame: frame => frames.push(frame),
    onFault: fault => faults.push(fault),
  });
  let hostPid: number | undefined;
  let descendantPid: number | undefined;

  try {
    await controller.start();
    const frame = await waitForFrame(frames);
    const processes = JSON.parse(frame) as { hostPid?: unknown; descendantPid?: unknown };
    assert.equal(typeof processes.hostPid, 'number');
    assert.equal(typeof processes.descendantPid, 'number');
    hostPid = processes.hostPid as number;
    descendantPid = processes.descendantPid as number;

    const [hostGroup, descendantGroup] = await Promise.all([processGroup(hostPid), processGroup(descendantPid)]);
    assert.equal(hostGroup, hostPid, 'detached Host must lead its own process group');
    assert.equal(descendantGroup, hostGroup, 'the Host descendant must inherit the owned process group');
    assert.equal(await processState(hostPid), 'running');
    assert.equal(await processState(descendantPid), 'running');

    const stopStarted = performance.now();
    await controller.stop();
    const stopDurationMs = performance.now() - stopStarted;
    assert.ok(stopDurationMs >= 2_800, 'the fixture must ignore stdin EOF so HostController exercises forced group termination');
    await waitForStopped([hostPid, descendantPid], 10_000);
    await waitForGroupStopped(hostGroup, 10_000);
    assert.deepEqual(faults, []);
    evidence.cases = [{ hostPid, descendantPid, hostGroup, descendantGroup, stopDurationMs, result: 'passed' }];
  } finally {
    await controller.stop().catch(() => undefined);
    if (hostPid !== undefined) {
      try { process.kill(-hostPid, 'SIGKILL'); } catch (error) { if (!isMissingProcess(error)) throw error; }
    }
    await waitForStopped([hostPid, descendantPid].filter((pid): pid is number => pid !== undefined), 5_000).catch(() => undefined);
    await removeFixture(root);
  }
});

test('host-entry kills its POSIX process group after the Main parent is forcibly terminated', {
  skip: process.platform === 'win32' ? 'POSIX process groups require a Unix-like host' : false,
}, async () => {
  assert.equal(process.version, NODE_VERSION, `run this test with the vendored Node ${NODE_VERSION}`);
  assert.equal(await realpath(process.execPath), await realpath(NODE), 'run the test with the vendored standalone Node executable');

  await mkdir(TEMP_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEMP_ROOT, `posix-main-crash-${process.pid}-`));
  assertInsideTempRoot(root);
  const cli = await createCliFixture(root);
  const helperPath = join(root, 'main-helper.cjs');
  const controllerPath = join(ELECTRON_ROOT, 'dist', 'host.js');
  await writeFile(helperPath, [
    `const { HostController } = require(${JSON.stringify(controllerPath)});`,
    `const controller = new HostController({ node: ${JSON.stringify(NODE)}, cli: ${JSON.stringify(cli)}, entry: ${JSON.stringify(HOST_ENTRY)}, cwd: ${JSON.stringify(root)}, env: { ...process.env }, onFrame: frame => process.stdout.write(JSON.stringify({ hostPid: controller.pid, descendantPid: JSON.parse(frame).descendantPid }) + '\\n'), onFault: fault => process.stderr.write(fault + '\\n') });`,
    'controller.start().then(() => process.stdout.write(JSON.stringify({ hostPid: controller.pid }) + "\\n")).catch(error => { process.stderr.write(String(error) + "\\n"); process.exitCode = 1; });',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');

  let helper: ChildProcess | undefined;
  let hostPid: number | undefined;
  let descendantPid: number | undefined;
  const observed: { hostPid?: number; descendantPid?: number } = {};
  try {
    helper = spawn(NODE, [helperPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const processes = await readProcessIds(helper, observed);
    hostPid = processes.hostPid;
    descendantPid = processes.descendantPid;
    const [hostGroup, descendantGroup] = await Promise.all([processGroup(hostPid), processGroup(descendantPid)]);
    assert.equal(hostGroup, hostPid, 'detached Host must lead its own process group');
    assert.equal(descendantGroup, hostGroup, 'the Host descendant must inherit the owned process group');
    await delay(250);
    assert.equal(await processState(hostPid), 'running');
    assert.equal(await processState(descendantPid), 'running');

    const mainPid = helper.pid;
    assert.ok(mainPid !== undefined, 'test-owned Main helper must have a PID');
    const helperExit = waitForChildExit(helper, 5_000);
    const crashStarted = performance.now();
    helper.kill('SIGKILL');
    await helperExit;
    await waitForStopped([hostPid, descendantPid], 30_000);
    await waitForGroupStopped(hostGroup, 10_000);
    const cleanupDurationMs = performance.now() - crashStarted;
    assert.ok(cleanupDurationMs >= 10_000, 'the orphan Host watchdog must run before its owned process group is killed');
    evidence.cases.push({ mainPid, hostPid, descendantPid, hostGroup, descendantGroup, cleanupDurationMs, result: 'passed' });
  } finally {
    hostPid ??= observed.hostPid;
    descendantPid ??= observed.descendantPid;
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) {
      helper.kill('SIGKILL');
      await waitForChildExit(helper, 5_000);
    }
    if (hostPid !== undefined) {
      try { process.kill(-hostPid, 'SIGKILL'); } catch (error) { if (!isMissingProcess(error)) throw error; }
      await waitForGroupStopped(hostPid, 5_000);
    }
    await waitForStopped([hostPid, descendantPid].filter((pid): pid is number => pid !== undefined), 5_000);
    await removeFixture(root);
  }
});

after(async () => {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const output = join(EVIDENCE_ROOT, `process-tree-posix-${process.platform}.json`);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`POSIX process-group evidence: ${output}\n`);
});

interface PosixHostController {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function waitForFrame(frames: string[], timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = frames.find(value => value.startsWith('{'));
    if (frame !== undefined) return frame;
    await delay(20);
  }
  throw new Error('POSIX Host fixture did not report its process IDs');
}

async function createCliFixture(root: string): Promise<string> {
  const cli = join(root, 'fixture.cjs');
  await writeFile(cli, [
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(JSON.stringify({ hostPid: process.pid, descendantPid: descendant.pid }) + '\\n');",
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');
  return cli;
}

function readProcessIds(child: ChildProcess, observed: { hostPid?: number; descendantPid?: number }, timeoutMs = 10_000): Promise<{ hostPid: number; descendantPid: number }> {
  assert.ok(child.stdout !== null);
  return new Promise((resolvePromise, reject) => {
    const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const timer = setTimeout(() => finish(new Error('POSIX Host fixture did not report its process IDs')), timeoutMs);
    child.stderr?.on('data', chunk => { if (Buffer.isBuffer(chunk)) process.stderr.write(chunk); });
    reader.on('line', line => {
      try {
        const value = JSON.parse(line) as { hostPid?: unknown; descendantPid?: unknown };
        if (typeof value.hostPid === 'number') observed.hostPid = value.hostPid;
        if (typeof value.descendantPid === 'number') observed.descendantPid = value.descendantPid;
        if (observed.hostPid === undefined || observed.descendantPid === undefined) return;
        finish(undefined, { hostPid: observed.hostPid, descendantPid: observed.descendantPid });
      } catch {}
    });
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`Main helper exited before Host readiness (${code}, ${signal})`)));
    function finish(error?: Error, value?: { hostPid: number; descendantPid: number }): void {
      clearTimeout(timer);
      reader.close();
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolvePromise(value);
    }
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error('test-owned Main helper did not exit')), timeoutMs);
    child.once('exit', onExit);
    function finish(error?: Error): void {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error !== undefined) reject(error);
      else resolvePromise();
    }
    function onExit(): void { finish(); }
  });
}

function processGroup(pid: number): Promise<number> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const parsed = Number(group);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `invalid process group for PID ${pid}`);
  return Promise.resolve(parsed);
}

async function processState(pid: number): Promise<'running' | 'stopped' | undefined> {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state === '' || state.startsWith('Z') ? 'stopped' : 'running';
  } catch (error) {
    if (isMissingProcess(error)) return undefined;
    throw error;
  }
}

async function waitForStopped(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(pids.map(processState));
    if (states.every(state => state !== 'running')) return;
    await delay(100);
  }
  const states = await Promise.all(pids.map(processState));
  assert.ok(states.every(state => state !== 'running'), `POSIX process group members remain alive: ${JSON.stringify({ pids, states })}`);
}

async function waitForGroupStopped(groupId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = processGroupMembers(groupId);
    if (members.length === 0) return;
    await delay(100);
  }
  assert.deepEqual(processGroupMembers(groupId), [], `POSIX process group ${groupId} still has live members`);
}

function processGroupMembers(groupId: number): number[] {
  const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return output.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    return match !== null && Number(match[2]) === groupId && !match[3].startsWith('Z') ? [Number(match[1])] : [];
  });
}

function isMissingProcess(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (('code' in error && error.code === 'ESRCH') || ('status' in error && error.status === 1));
}

async function removeFixture(path: string): Promise<void> {
  assertInsideTempRoot(path);
  await rm(path, { recursive: true, force: true });
}

function assertInsideTempRoot(path: string): void {
  const root = resolve(TEMP_ROOT);
  const target = resolve(path);
  const child = relative(root, target);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`refusing to remove a path outside desktop/testplace/tmp: ${target}`);
  }
}
