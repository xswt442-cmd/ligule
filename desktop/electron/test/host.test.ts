import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HostController, type HostFault } from '../host.ts';
import { sanitizedHostEnvironment } from '../runtime.ts';

const testRoot = resolve(import.meta.dirname, '../../testplace');

async function createWorkspace(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  return mkdtemp(join(testRoot, 'electron-host-'));
}

function waitFor<T>(items: T[], predicate: (item: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const existing = items.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const found = items.find(predicate);
      if (found !== undefined) {
        resolvePromise(found);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out after ${timeoutMs} ms`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('transfers complete JSON frames from and to a real Node child process', async () => {
  const directory = await createWorkspace();
  const cli = join(directory, 'fixture.js');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  const controller = new HostController({
    node: process.execPath,
    cli,
    cwd: directory,
    env: process.env,
    onFrame: (frame) => frames.push(frame),
    onFault: (fault) => faults.push(fault),
  });
  try {
    await writeFile(cli, "process.stdout.write('{\\\"ready\\\":true}\\n'); require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(line + '\\n'));\n", 'utf8');
    await controller.start();
    assert.equal(await waitFor(frames, (frame) => frame.includes('ready')), '{"ready":true}');
    await assert.rejects(controller.send('[]'), /valid JSON object/u);
    await assert.rejects(controller.send('null'), /valid JSON object/u);
    const largeValidFrame = JSON.stringify({ text: '界'.repeat(1_000_000) });
    await controller.send(largeValidFrame);
    assert.equal(await waitFor(frames, (frame) => frame.startsWith('{"text":')), largeValidFrame);
    assert.deepEqual(faults, []);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('assembles a real 16 MiB stdout frame within a bounded time', async () => {
  const directory = await createWorkspace();
  const cli = join(directory, 'fixture.js');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  const controller = new HostController({ node: process.execPath, cli, cwd: directory, env: process.env, onFrame: (frame) => frames.push(frame), onFault: (fault) => faults.push(fault) });
  const frameBytes = 16 * 1024 * 1024;
  const prefix = '{"value":"';
  const suffix = '"}';
  const payloadBytes = frameBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  try {
    await writeFile(cli, `process.stdout.write(${JSON.stringify(`${prefix}${'x'.repeat(payloadBytes)}${suffix}\n`)}); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000);\n`, 'utf8');
    const started = performance.now();
    await controller.start();
    const frame = await waitFor(frames, (item) => item.length > 1_000_000);
    const elapsedMs = performance.now() - started;
    assert.equal(Buffer.byteLength(frame), frameBytes);
    assert.ok(elapsedMs < 10_000, `16 MiB frame took ${elapsedMs.toFixed(0)} ms`);
    assert.deepEqual(faults, []);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates stdout JSON without forwarding malformed or oversized lines', async () => {
  const directory = await createWorkspace();
  const cli = join(directory, 'fixture.js');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  const controller = new HostController({
    node: process.execPath,
    cli,
    cwd: directory,
    env: process.env,
    onFrame: (frame) => frames.push(frame),
    onFault: (fault) => faults.push(fault),
  });
  try {
    await writeFile(cli, "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);\n", 'utf8');
    await controller.start();
    assert.equal(await waitFor(faults, (fault) => fault === 'stdout-invalid-json'), 'stdout-invalid-json');
    assert.deepEqual(frames, []);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an oversized stdout frame from a real Node child process', async () => {
  const directory = await createWorkspace();
  const cli = join(directory, 'fixture.js');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  const controller = new HostController({ node: process.execPath, cli, cwd: directory, env: process.env, onFrame: (frame) => frames.push(frame), onFault: (fault) => faults.push(fault) });
  const frameBytes = 16 * 1024 * 1024;
  const prefix = '{"value":"';
  const suffix = '"}';
  const payloadBytes = frameBytes + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  try {
    await writeFile(cli, `process.stdout.write(${JSON.stringify(`${prefix}${'x'.repeat(payloadBytes)}${suffix}\n`)}); setInterval(() => {}, 1000);\n`, 'utf8');
    await controller.start();
    assert.equal(await waitFor(faults, (fault) => fault === 'stdout-frame-too-large'), 'stdout-frame-too-large');
    assert.deepEqual(frames, []);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('isolates an old write callback across a real Node child restart', async () => {
  const directory = await createWorkspace();
  const cli = join(directory, 'fixture.js');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  let restartStarted = false;
  let oldWriteSettledAfterRestart = false;
  const controller = new HostController({ node: process.execPath, cli, cwd: directory, env: process.env, onFrame: (frame) => frames.push(frame), onFault: (fault) => faults.push(fault) });
  try {
    await writeFile(cli, "const fs = require('node:fs'); const first = !fs.existsSync('started'); fs.writeFileSync('started', 'yes'); process.stdout.write(JSON.stringify({ ready: first ? 1 : 2 }) + '\\n'); if (first) setInterval(() => {}, 1000); else require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(line + '\\n'));\n", 'utf8');
    await controller.start();
    await waitFor(frames, (frame) => JSON.parse(frame).ready === 1);
    const payload = JSON.stringify({ value: 'x'.repeat(15 * 1024 * 1024) });
    const oldWrite = controller.send(payload).then(
      () => undefined,
      (error: unknown) => {
        oldWriteSettledAfterRestart = restartStarted;
        return error;
      },
    );
    const restarting = controller.restart();
    restartStarted = true;
    await assert.rejects(controller.stop(), /lifecycle operation is in progress/u);
    await assert.rejects(controller.start(), /lifecycle operation is in progress/u);
    await restarting;
    await waitFor(frames, (frame) => JSON.parse(frame).ready === 2);
    const oldWriteResult = await oldWrite;
    assert.ok(oldWriteResult instanceof Error, 'the old pipe write must settle as rejected when its child is stopped');
    assert.equal(oldWriteSettledAfterRestart, true, 'the real old-pipe callback must arrive after the new generation starts');
    const currentPayload = JSON.stringify({ value: 'y'.repeat(15 * 1024 * 1024) });
    const currentWrite = controller.send(currentPayload);
    const secondCurrentWrite = controller.send(currentPayload);
    await assert.rejects(controller.send(JSON.stringify({ value: 'z'.repeat(3 * 1024 * 1024) })), /write queue is full/u);
    await Promise.all([currentWrite, secondCurrentWrite]);
    await waitFor(frames, (frame) => frame === currentPayload);
    await waitFor(frames, () => frames.filter((entry) => entry === currentPayload).length === 2);
    await controller.send('{"generation":2}');
    assert.equal(await waitFor(frames, (frame) => frame === '{"generation":2}'), '{"generation":2}');
    assert.deepEqual(faults, ['write-queue-full']);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('starts the actual Node 24 Ligule Host and accepts an opaque protocol frame', async () => {
  const directory = await createWorkspace();
  const root = resolve(import.meta.dirname, '../../..');
  const frames: string[] = [];
  const faults: HostFault[] = [];
  const controller = new HostController({ node: process.execPath, cli: join(root, 'dist', 'cli.js'), cwd: root, env: sanitizedHostEnvironment({ ...process.env, LIGULE_HOME: directory }), onFrame: (frame) => frames.push(frame), onFault: (fault) => faults.push(fault) });
  try {
    await controller.start();
    await controller.send('{"id":"opaque-1","method":"unsupported.desktop.probe","params":{}}');
    const response = await waitFor(frames, (frame) => frame.includes('opaque-1'));
    assert.equal(JSON.parse(response).id, 'opaque-1');
    assert.deepEqual(faults, []);
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('removes Node and Electron option injection while preserving host credentials', () => {
  const clean = sanitizedHostEnvironment({ NODE_OPTIONS: '--inspect', NODE_PATH: 'external', ELECTRON_RUN_AS_NODE: '1', LIGULE_API_KEY: 'kept', HTTPS_PROXY: 'kept' });
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.NODE_PATH, undefined);
  assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(clean.LIGULE_API_KEY, 'kept');
  assert.equal(clean.HTTPS_PROXY, 'kept');
});
