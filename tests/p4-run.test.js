import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from '../core/dist/host/connection.js';
import { readRunResult, runResultPage, publishRunResult } from '../core/dist/session/run.js';
import { sessionWriterActive } from '../core/dist/session/lock.js';
import { listenFetchable } from './helpers/port.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repository, 'tui', 'dist', 'cli.js');

function sampleResult(runId, sessionId, text = 'verified result') {
  return {
    runId, sessionId, state: 'completed', stopReason: 'assistant_completed', output: { text },
    validation: { status: 'not_requested' }, artifacts: [{ kind: 'session', sessionId }],
    usage: { iterations: 1, modelCalls: 1 },
  };
}

async function findSessionRecord(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      try { return await findSessionRecord(path, sessionId); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (entry.name === `${sessionId}.jsonl`) return path;
  }
  throw Object.assign(new Error('session_record_not_found'), { code: 'ENOENT' });
}

test('run result sidecars enforce identity, integrity, bounds, links, and valid paging', async () => {
  const output = join(repository, 'testplace', 'p4-runs');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'p4-run-result-'));
  const sessionId = 'p4-result-session';
  const runId = randomUUID();
  const result = sampleResult(runId, sessionId);
  const receipt = { runId, userSeq: 1, sessionId, acceptedAt: new Date().toISOString(), state: 'completed' };
  try {
    const ref = await publishRunResult(directory, 'workspace-one', sessionId, runId, result);
    const completedReceipt = { ...receipt, resultRef: ref };
    assert.deepEqual(await readRunResult(directory, 'workspace-one', sessionId, completedReceipt), result);
    await assert.rejects(readRunResult(directory, 'workspace-two', sessionId, completedReceipt), { code: 'run_result_unavailable' });
    const json = JSON.stringify(result);
    let offset = 0;
    let assembled = '';
    while (true) {
      const page = runResultPage(result, offset);
      assert.equal(page.offset, offset);
      assembled += page.json;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.equal(assembled, json);
    for (const invalid of [-1, 0.5, Number.NaN, json.length + 1]) {
      assert.throws(() => runResultPage(result, invalid), { code: 'run_result_offset_invalid' });
    }

    const sidecar = join(directory, ref.name);
    const alias = join(directory, 'sidecar-hardlink');
    await link(sidecar, alias);
    await assert.rejects(readRunResult(directory, 'workspace-one', sessionId, completedReceipt), { code: 'run_result_unavailable' });
    await unlink(alias);
    await unlink(sidecar);
    const external = join(directory, 'external-result');
    await writeFile(external, JSON.stringify({ version: 1, workspace: 'workspace-one', sessionId, runId, result }));
    await symlink(external, sidecar, 'file');
    await assert.rejects(readRunResult(directory, 'workspace-one', sessionId, completedReceipt), { code: 'run_result_unavailable' });
    await unlink(sidecar);
    await unlink(external);
    const bytes = Buffer.from(JSON.stringify({ version: 1, workspace: 'workspace-one', sessionId, runId, result }));
    bytes[bytes.length - 3] ^= 1;
    await writeFile(sidecar, bytes);
    await assert.rejects(readRunResult(directory, 'workspace-one', sessionId, completedReceipt), { code: 'run_result_unavailable' });
    await unlink(sidecar);
    await assert.rejects(readRunResult(directory, 'workspace-one', sessionId, completedReceipt), { code: 'run_result_unavailable' });
    assert.deepEqual(await readdir(directory), []);

    const oversizedRunId = randomUUID();
    const oversized = sampleResult(oversizedRunId, sessionId, 'x'.repeat(16 * 1024 * 1024));
    await assert.rejects(publishRunResult(directory, 'workspace-one', sessionId, oversizedRunId, oversized), { code: 'run_result_too_large' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
  }
});

function deadline(pending, label) {
  let timer;
  return Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
  })]).finally(() => clearTimeout(timer));
}

test('durable run submission deduplicates a live retry and rejects a payload conflict', async () => {
  const output = join(repository, 'testplace', 'p4-runs');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'p4-run-live-'));
  const data = join(root, 'data');
  await mkdir(data);
  let releaseResponse;
  const responseReady = new Promise(resolve => { releaseResponse = resolve; });
  let releaseCrashResponse;
  const crashResponseReady = new Promise(resolve => { releaseCrashResponse = resolve; });
  let requestCount = 0;
  const server = createServer(async (_request, response) => {
    requestCount += 1;
    if (requestCount === 1) await responseReady;
    if (requestCount === 2) await crashResponseReady;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const port = await listenFetchable(server);
  const startHost = () => {
    const childProcess = spawn(process.execPath, [cli, 'host', '--config', 'model.api="messages"',
      '--config', `model.baseURL="http://127.0.0.1:${port}"`, '--config', 'model.model="p4-test"'], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, LIGULE_HOME: data, LIGULE_API_KEY: 'local-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processStderr = [];
    childProcess.stderr.setEncoding('utf8');
    childProcess.stderr.on('data', chunk => processStderr.push(chunk));
    return { process: childProcess, processStderr, client: createConnection({ input: childProcess.stdout, output: childProcess.stdin }) };
  };
  let host = startHost();
  try {
    const { sessionId } = await deadline(host.client.request('session.create', {}), 'create session');
    const first = await deadline(host.client.request('run.submit', {
      sessionId, input: 'return a short response', requestKey: 'p4-live-key', origin: 'controller',
    }), 'accept run');
    assert.equal(first.reused, false);
    await deadline(new Promise(resolve => {
      const check = setInterval(() => { if (requestCount > 0) { clearInterval(check); resolve(); } }, 5);
    }), 'observe provider request');
    const retry = await deadline(host.client.request('run.submit', {
      sessionId, input: 'return a short response', requestKey: 'p4-live-key', origin: 'controller',
    }), 'retry live run');
    assert.equal(retry.runId, first.runId);
    assert.equal(retry.userSeq, first.userSeq);
    assert.equal(retry.reused, true);
    await assert.rejects(host.client.request('run.submit', {
      sessionId, input: 'different payload', requestKey: 'p4-live-key', origin: 'controller',
    }), error => error.code === 'run_request_conflict');
    assert.equal(requestCount, 1);
    releaseResponse();
    const completed = await deadline(host.client.request('run.wait', { sessionId, runId: first.runId, origin: 'controller' }), 'finish run');
    assert.equal(completed.text, 'done');
    const receipt = await host.client.request('run.receipt', { projectRoot: root, sessionId, requestKey: 'p4-live-key' });
    assert.equal(receipt.state, 'completed');
    const result = await host.client.request('run.result', { projectRoot: root, sessionId, runId: first.runId, offset: 0 });
    assert.match(result.json, /"state":"completed"/u);
    const events = (await host.client.request('session.read', { sessionId, limit: 100, fullResults: true })).events;
    assert.equal(events.filter(event => event.kind === 'user' && event.run?.runId === first.runId).length, 1);
    assert.equal(events.filter(event => event.kind === 'turn' && event.userSeq === first.userSeq).length, 1);
    await host.client.request('session.close', { sessionId });
    const sessionPath = await findSessionRecord(data, sessionId);
    const beforeReadOnlyQueries = await readFile(sessionPath);
    assert.equal(await sessionWriterActive(sessionPath), false);
    const unfinished = await host.client.request('session.create', {});
    const acceptedUnfinished = await host.client.request('run.submit', {
      sessionId: unfinished.sessionId, input: 'leave this actual provider request unfinished',
      requestKey: 'p4-unfinished-key', origin: 'controller',
    });
    assert.equal(acceptedUnfinished.reused, false);
    await deadline(new Promise(resolve => {
      const check = setInterval(() => { if (requestCount === 2) { clearInterval(check); resolve(); } }, 5);
    }), 'observe unfinished provider request');
    host.process.kill();
    await deadline(new Promise(resolve => host.process.once('close', resolve)), 'terminate unfinished Host');
    host = startHost();
    const restoredReceipt = await host.client.request('run.receipt', { projectRoot: root, sessionId, runId: first.runId });
    assert.equal(restoredReceipt.state, 'completed');
    const restoredResult = await host.client.request('run.result', { projectRoot: root, sessionId, runId: first.runId, offset: 0 });
    assert.match(restoredResult.json, /"state":"completed"/u);
    assert.equal(await sessionWriterActive(sessionPath), false);
    assert.deepEqual(await readFile(sessionPath), beforeReadOnlyQueries);
    const unfinishedReceipt = await host.client.request('run.receipt', {
      projectRoot: root, sessionId: unfinished.sessionId, requestKey: 'p4-unfinished-key',
    });
    assert.equal(unfinishedReceipt.runId, acceptedUnfinished.runId);
    assert.ok(['accepted', 'interrupted'].includes(unfinishedReceipt.state));
    await assert.rejects(host.client.request('run.result', {
      projectRoot: root, sessionId: unfinished.sessionId, runId: acceptedUnfinished.runId,
    }), { code: 'run_result_unavailable' });
    assert.equal(requestCount, 2, 'receipt and result reads after restart must not re-run the provider');
  } catch (error) {
    throw new Error(`${error.message}; host exit=${String(host.process.exitCode)} stderr=${host.processStderr.join('')}`, { cause: error });
  } finally {
    releaseResponse();
    releaseCrashResponse();
    host.process.stdin.end();
    if (host.process.exitCode === null) host.process.kill();
    if (host.process.exitCode === null) await new Promise(resolve => host.process.once('close', resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('run.wait requires an explicit scope and cannot use origin to widen access', async () => {
  const output = join(repository, 'testplace', 'p4-runs');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'p4-run-wait-default-'));
  const data = join(root, 'data');
  await mkdir(data);
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const port = await listenFetchable(server);
  const childProcess = spawn(process.execPath, [cli, 'host', '--config', 'model.api="messages"',
    '--config', `model.baseURL="http://127.0.0.1:${port}"`, '--config', 'model.model="p4-test"'], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, LIGULE_HOME: data, LIGULE_API_KEY: 'local-test-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  childProcess.stderr.setEncoding('utf8');
  childProcess.stderr.on('data', chunk => stderr.push(chunk));
  const client = createConnection({ input: childProcess.stdout, output: childProcess.stdin });
  try {
    const { sessionId } = await deadline(client.request('session.create', {}), 'create session');
    const started = await deadline(client.request('run.start', { sessionId, input: 'return a short response' }), 'finish the Host-scoped run');
    assert.equal(started.text, 'done');
    assert.equal(typeof started.runId, 'string');
    await assert.rejects(client.request('run.wait', { sessionId, runId: started.runId }), { code: 'protocol_args_invalid' });
    await assert.rejects(client.request('run.wait', { sessionId, runId: started.runId, origin: 'human' }), { code: 'run_not_found' },
      'a Host without trusted UI control cannot claim human scope by setting origin');
    const controllerStart = await deadline(client.request('run.wait', {
      sessionId, runId: started.runId, origin: 'controller',
    }), 'read the untrusted Host run in its controller scope');
    assert.equal(controllerStart.text, 'done');

    const claimedHumanStart = await deadline(client.request('run.start', {
      sessionId, origin: 'human', input: 'return a controller response despite claimed human origin',
    }), 'accept an untrusted Host run with a claimed human origin');
    await assert.rejects(client.request('run.wait', {
      sessionId, runId: claimedHumanStart.runId, origin: 'human',
    }), { code: 'run_not_found' }, 'an untrusted Host ignores claimed human attribution');
    const claimedHumanControllerResult = await deadline(client.request('run.wait', {
      sessionId, runId: claimedHumanStart.runId, origin: 'controller',
    }), 'read the claimed-human run in controller scope');
    assert.equal(claimedHumanControllerResult.text, 'done');

    const accepted = await deadline(client.request('run.submit', { sessionId, input: 'return a controller response' }), 'accept controller run');
    const receiptDeadline = Date.now() + 5_000;
    let receipt;
    while (Date.now() < receiptDeadline) {
      receipt = await client.request('run.receipt', { projectRoot: root, sessionId, runId: accepted.runId });
      if (receipt.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(receipt.state, 'completed', `provider requests=${requestCount}`);
    await assert.rejects(client.request('run.wait', { sessionId, runId: accepted.runId }), { code: 'protocol_args_invalid' });
    const completed = await deadline(client.request('run.wait', { sessionId, runId: accepted.runId, origin: 'controller' }), 'wait for controller run');
    assert.equal(completed.text, 'done');
    assert.equal(requestCount, 3);
  } catch (error) {
    throw new Error(`${error.message}; host exit=${String(childProcess.exitCode)} stderr=${stderr.join('')}`, { cause: error });
  } finally {
    childProcess.stdin.end();
    if (childProcess.exitCode === null) childProcess.kill();
    if (childProcess.exitCode === null) await new Promise(resolve => childProcess.once('close', resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
