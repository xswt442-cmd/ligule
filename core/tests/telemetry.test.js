import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTelemetry } from '../dist/kernel/telemetry.js';

const testRoot = join(process.cwd(), 'testplace', 'telemetry');

async function isolated(t) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'case-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function instanceFiles(directory) {
  const [instance] = (await readdir(directory)).filter(name => name.startsWith('telemetry-'));
  return { instance: join(directory, instance), files: await readdir(join(directory, instance)) };
}

test('telemetry is disabled unless explicitly enabled with a directory', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ directory });
  telemetry.emit({ type: 'run.finished', executionId: 'exec-1', runId: 'run-1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  assert.deepEqual(await readdir(directory), []);
});

test('writes only allowlisted fields and drops malformed or sensitive values', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'model.finished', executionId: 'e1', runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt_4', durationMs: 604_800_000,
    inputTokens: 4, outputTokens: 2, finishReason: 'stop' });
  telemetry.emit({ type: 'model.finished', executionId: 'e2', runId: 'r2', provider: 'openai', model: 'secret=abc', durationMs: 1 });
  telemetry.emit({ type: 'tool.finished', executionId: 'e3', runId: 'r3', tool: 'read', durationMs: 2, outcome: 'success', args: { password: 'nope' } });
  telemetry.emit({ type: 'model.finished', executionId: 'e4', runId: 'r4', provider: 'vendor/provider', model: 'vendor/model',
    durationMs: 23, inputTokens: 7, outputTokens: 5, finishReason: 'stop' });
  await telemetry.shutdown();
  const { instance } = await instanceFiles(directory);
  const text = await readFile(join(instance, 'segment-00000000.jsonl'), 'utf8');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.deepEqual(Object.keys(records[0]).sort(), ['durationMs', 'executionId', 'finishReason', 'inputTokens', 'model', 'outputTokens', 'provider', 'runId', 'sessionId', 'timestamp', 'type'].sort());
  assert.equal(records[0].runId, 'r1');
  assert.equal(records[0].durationMs, 604_800_000);
  assert.equal(records[1].model, undefined);
  assert.equal(records[2].provider, undefined);
  assert.equal(records[2].model, undefined);
  assert.equal(records[2].inputTokens, 7);
  assert.equal(records[2].outputTokens, 5);
  assert.doesNotMatch(text, /secret|password|args|abc|nope/u);
});

test('queue capacity includes the in-flight write and silently drops excess records', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxQueuedRecords: 1 });
  for (let index = 0; index < 100; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `e${index}`, runId: `r${index}`, status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  }
  await assert.doesNotReject(telemetry.flush());
  await assert.doesNotReject(telemetry.shutdown());
  const { instance } = await instanceFiles(directory);
  const records = (await readFile(join(instance, 'segment-00000000.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).runId, 'r0');
});

test('file rotation keeps a bounded number of bounded files', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1100 });
  for (let index = 0; index < 40; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `exec-${index}`, runId: `run-${index}`, sessionId: 'session', status: 'completed', durationMs: index,
      modelCalls: 1, toolCalls: 0 });
  }
  await telemetry.shutdown();
  const { instance, files } = await instanceFiles(directory);
  assert.ok(files.length <= 4);
  for (const name of files) assert.ok((await readFile(join(instance, name))).byteLength <= 1100);
});

test('filesystem failures do not escape emit, flush, or shutdown', async (t) => {
  const directory = await isolated(t);
  const file = join(directory, 'file');
  await writeFile(file, 'x');
  const telemetry = createTelemetry({ enabled: true, directory: join(file, 'child') });
  assert.doesNotThrow(() => telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'failed', durationMs: 1, modelCalls: 1, toolCalls: 0 }));
  await assert.doesNotReject(telemetry.flush());
  await assert.doesNotReject(telemetry.shutdown());
});

test('preserves pre-existing unknown files and refuses a symlink output directory', async (t) => {
  const directory = await isolated(t);
  const marker = join(directory, 'telemetry.jsonl.1');
  await writeFile(marker, 'keep this user file');
  const linkPath = join(directory, 'directory-link');
  try { await symlink(directory, linkPath, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory symlinks are unavailable');
    throw error;
  }
  const telemetry = createTelemetry({ enabled: true, directory: linkPath });
  telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await assert.doesNotReject(telemetry.flush());
  await telemetry.shutdown();
  assert.equal(await readFile(marker, 'utf8'), 'keep this user file');
  assert.deepEqual((await readdir(directory)).sort(), ['directory-link', 'telemetry.jsonl.1']);
});

test('fails closed instead of rotating a segment after it gains a hard link', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1050, retainedFiles: 1 });
  telemetry.emit({ type: 'run.finished', executionId: 'e-first', runId: 'first', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  const { instance } = await instanceFiles(directory);
  const segment = join(instance, 'segment-00000000.jsonl');
  const preservedLink = join(directory, 'preserved-hard-link');
  await link(segment, preservedLink);
  for (let index = 0; index < 20; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `e-next-${index}`, runId: `next-${index}`, status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  }
  await assert.doesNotReject(telemetry.flush());
  await telemetry.shutdown();
  assert.match(await readFile(preservedLink, 'utf8'), /first/u);
  assert.ok((await readdir(instance)).includes('segment-00000000.jsonl'));
});

test('concurrent instances use separate directories and each obey its file and retention limits', async (t) => {
  const directory = await isolated(t);
  const first = createTelemetry({ enabled: true, directory, maxFileBytes: 1100, retainedFiles: 2 });
  const second = createTelemetry({ enabled: true, directory, maxFileBytes: 1100, retainedFiles: 2 });
  for (let index = 0; index < 80; index += 1) {
    const event = { type: 'run.finished', executionId: `exec-${index}`, runId: `run-${index}`, status: 'completed', durationMs: index, modelCalls: 1, toolCalls: 0 };
    first.emit(event);
    second.emit(event);
  }
  await Promise.all([first.shutdown(), second.shutdown()]);
  const instances = (await readdir(directory)).filter(name => name.startsWith('telemetry-'));
  assert.equal(instances.length, 2);
  for (const name of instances) {
    const instance = join(directory, name);
    const files = await readdir(instance);
    assert.ok(files.length <= 2);
    for (const file of files) {
      const bytes = await readFile(join(instance, file));
      assert.ok(bytes.byteLength <= 1100);
      for (const line of bytes.toString('utf8').trim().split('\n')) assert.equal(JSON.parse(line).type, 'run.finished');
    }
  }
});

test('shutdown returns within its bound when a file flush never settles', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'run.finished', executionId: 'e1', runId: 'r1', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  prototype.sync = () => new Promise(() => {});
  try {
    const started = Date.now();
    await telemetry.shutdown();
    assert.ok(Date.now() - started < 1_000);
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
});
