import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTelemetry } from '../dist/kernel/telemetry.js';

const testRoot = join(process.cwd(), 'testplace', 'telemetry');

async function isolated(t) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'case-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}.telemetry.lock`, { recursive: true, force: true });
  });
  return directory;
}

async function segmentFiles(directory) {
  return (await readdir(directory)).filter(name => /^segment-[0-9]{8}\.jsonl$/u.test(name));
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
  const text = await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8');
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
  const records = (await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8')).trim().split('\n');
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
  await telemetry.flush();
  await telemetry.shutdown();
  const files = await segmentFiles(directory);
  assert.ok(files.length <= 4);
  let logBytes = 0;
  for (const name of files) {
    const bytes = (await readFile(join(directory, name))).byteLength;
    assert.ok(bytes <= 1100);
    logBytes += bytes;
  }
  assert.ok(logBytes <= 4 * 1100);
  assert.ok((await readdir(directory)).length <= 5, JSON.stringify(await readdir(directory)));
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

test('a corrupt manifest fails closed without replacing or deleting its contents', async (t) => {
  const directory = await isolated(t);
  const initial = createTelemetry({ enabled: true, directory });
  initial.emit({ type: 'run.finished', executionId: 'exec-before', runId: 'run-before', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await initial.shutdown();
  const segmentBefore = await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8');
  const manifest = join(directory, 'telemetry.manifest.json');
  await writeFile(manifest, '{ damaged marker');
  const telemetry = createTelemetry({ enabled: true, directory });
  telemetry.emit({ type: 'run.finished', executionId: 'exec-after', runId: 'run-after', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await assert.doesNotReject(telemetry.flush());
  await telemetry.shutdown();
  assert.equal(await readFile(manifest, 'utf8'), '{ damaged marker');
  assert.equal(await readFile(join(directory, 'segment-00000000.jsonl'), 'utf8'), segmentBefore);
  assert.deepEqual(await segmentFiles(directory), ['segment-00000000.jsonl']);
});

test('fails closed instead of rotating a segment after it gains a hard link', async (t) => {
  const directory = await isolated(t);
  const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1050, retainedFiles: 1 });
  telemetry.emit({ type: 'run.finished', executionId: 'e-first', runId: 'first', status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  await telemetry.flush();
  const segment = join(directory, 'segment-00000000.jsonl');
  const preservedLink = join(testRoot, `preserved-hard-link-${randomUUID()}`);
  t.after(async () => rm(preservedLink, { force: true }));
  await link(segment, preservedLink);
  for (let index = 0; index < 20; index += 1) {
    telemetry.emit({ type: 'run.finished', executionId: `e-next-${index}`, runId: `next-${index}`, status: 'completed', durationMs: 1, modelCalls: 1, toolCalls: 0 });
  }
  await assert.doesNotReject(telemetry.flush());
  await telemetry.shutdown();
  assert.match(await readFile(preservedLink, 'utf8'), /first/u);
  assert.ok((await readdir(directory)).includes('segment-00000000.jsonl'));
});

test('multiple writers serialize through one manifest and obey aggregate file and byte limits', async (t) => {
  const directory = await isolated(t);
  const first = createTelemetry({ enabled: true, directory, maxFileBytes: 8192, retainedFiles: 2 });
  const second = createTelemetry({ enabled: true, directory, maxFileBytes: 8192, retainedFiles: 2 });
  for (let index = 0; index < 10; index += 1) {
    const event = { type: 'run.finished', executionId: `exec-${index}`, runId: `run-${index}`, status: 'completed', durationMs: index, modelCalls: 1, toolCalls: 0 };
    first.emit(event);
    second.emit({ ...event, runId: `second-${index}` });
  }
  await Promise.all([first.flush(), second.flush()]);
  await Promise.all([first.shutdown(), second.shutdown()]);
  const files = await segmentFiles(directory);
  assert.ok(files.length <= 2);
  assert.ok((await readdir(directory)).length <= 3, JSON.stringify(await readdir(directory)));
  let totalBytes = (await readFile(join(directory, 'telemetry.manifest.json'))).byteLength;
  const runIds = new Set();
  for (const file of files) {
    const bytes = await readFile(join(directory, file));
    assert.ok(bytes.byteLength <= 8192);
    totalBytes += bytes.byteLength;
    for (const line of bytes.toString('utf8').trim().split('\n')) {
      const event = JSON.parse(line);
      assert.equal(event.type, 'run.finished');
      runIds.add(event.runId);
    }
  }
  assert.ok(totalBytes <= 2 * 8192 + 4096);
  assert.ok([...runIds].some(id => id.startsWith('run-')));
  assert.ok([...runIds].some(id => id.startsWith('second-')));
});

test('restart writers reuse one capped directory without accumulating log sets', async (t) => {
  const directory = await isolated(t);
  for (let writer = 0; writer < 5; writer += 1) {
    const telemetry = createTelemetry({ enabled: true, directory, maxFileBytes: 1100, retainedFiles: 2 });
    for (let index = 0; index < 25; index += 1) {
      telemetry.emit({ type: 'run.finished', executionId: `exec-${writer}-${index}`, runId: `run-${writer}-${index}`,
        status: 'completed', durationMs: index, modelCalls: 1, toolCalls: 0 });
    }
    await telemetry.shutdown();
  }
  const files = await readdir(directory);
  const segments = await segmentFiles(directory);
  assert.ok(segments.length <= 2);
  assert.deepEqual(files.sort(), ['telemetry.manifest.json', ...segments].sort());
  const totalBytes = (await Promise.all(files.map(name => readFile(join(directory, name)))))
    .reduce((total, content) => total + content.byteLength, 0);
  assert.ok(totalBytes <= 2 * 1100 + 4096);
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
