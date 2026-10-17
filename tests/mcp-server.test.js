import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listenFetchable } from '../test/helpers/port.js';
import { connectMcp } from '../test/helpers/mcp-control.mjs';
import { setTrusted } from '../core/dist/kernel/workspace-trust.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(process.env.LIGULE_MCP_E2E_WORKSPACE_ROOT ?? repoRoot);
const testplaceRoot = resolve(process.env.LIGULE_MCP_E2E_TESTPLACE_ROOT ?? join(workspaceRoot, 'testplace'));
const cliPath = resolve(process.env.LIGULE_MCP_CLI ?? join(repoRoot, 'tui', 'dist', 'cli.js'));
const sdkRoot = resolve(process.env.LIGULE_MCP_SDK_ROOT ?? join(repoRoot, 'core', 'node_modules', '@modelcontextprotocol', 'sdk'));

function recordTrace(trace, action, fields = {}) {
  trace.push({ time: new Date().toISOString(), action, ...fields });
}

function toolData(result, action) {
  assert.equal(result.isError, undefined, `${action}: ${JSON.stringify(result.structuredContent ?? result)}`);
  assert.ok(result.structuredContent !== undefined, `${action}: MCP result has no structuredContent`);
  return result.structuredContent;
}

function toolFailurePayload(result) {
  let payload;
  try { payload = JSON.parse(result.content?.[0]?.text ?? '{}'); }
  catch { payload = {}; }
  const actual = result.structuredContent?.code ?? payload.code;
  return { ...payload, code: actual };
}

function toolFailureCode(result) {
  return toolFailurePayload(result).code;
}

function toolFailure(result, code, action) {
  assert.equal(result.isError, true, `${action}: expected an MCP tool error`);
  const payload = toolFailurePayload(result);
  const actual = payload.code;
  assert.equal(actual, code, `${action}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(check, label, within = 10_000) {
  const until = Date.now() + within;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`mcp_e2e_wait_timeout:${label}`);
}

async function waitForOutcome(client, operationId) {
  return await waitFor(async () => {
    const result = toolData(await client.callTool({ name: 'ligule_run_status', arguments: { operationId } }), 'run_status');
    return result.state === 'running' ? undefined : result;
  }, `operation ${operationId} to settle`);
}

async function findHistoryRecord(client, sessionId, predicate) {
  let page = toolData(await client.callTool({ name: 'ligule_session_read', arguments: { sessionId, limit: 50 } }), 'session_read_history_page');
  for (;;) {
    const found = page.records.find(predicate);
    if (found !== undefined) return { record: found, page };
    if (!page.hasMore || page.nextBefore === null) return undefined;
    page = toolData(await client.callTool({
      name: 'ligule_session_read', arguments: { sessionId, limit: 50, before: page.nextBefore },
    }), 'session_read_history_older_page');
  }
}

async function waitForChildPid(client, sessionId, operationId, pidFile, label) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const pidText = await readFile(pidFile, 'utf8').catch(() => undefined);
    if (pidText !== undefined) {
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) return pid;
    }
    const status = toolData(await client.callTool({ name: 'ligule_run_status', arguments: { operationId } }), `${label}_status`);
    if (status.state !== 'running') {
      const page = toolData(await client.callTool({ name: 'ligule_session_read', arguments: { sessionId, limit: 50 } }), `${label}_records`);
      const outcomes = page.records.filter((item) => item.kind === 'tool').map((item) => {
        const record = JSON.parse(item.json);
        return { tool: record.tool, kind: record.result?.kind, code: record.result?.code, content: record.result?.content };
      });
      throw new Error(`${label}_finished_without_child:${status.state}:${status.code ?? ''}:${JSON.stringify(outcomes)}`);
    }
    await delay(25);
  }
  throw new Error(`${label}_child_pid_timeout`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function sse(response, delta) {
  const frames = [
    { choices: [{ index: 0, delta, finish_reason: delta.tool_calls === undefined ? 'stop' : 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`);
}

function tomlString(value) {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

function gate() {
  let open;
  let started;
  const waiting = new Promise((resolve) => { open = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let isStarted = false;
  let isOpen = false;
  return {
    get started() { return isStarted; },
    entered,
    waiting,
    markStarted() { isStarted = true; started(); },
    release() { if (!isOpen) { isOpen = true; open(); } },
  };
}

test('a real stdio MCP client controls, reads, cancels, and reopens Host sessions', { timeout: 60_000 }, async (t) => {
  const trace = [];
  const clients = new Set();
  const tempParent = resolve(process.env.LIGULE_MCP_E2E_TEMP_ROOT ?? join(testplaceRoot, 'tmp'));
  await mkdir(tempParent, { recursive: true });
  const tempRoot = await mkdtemp(join(tempParent, 'mcp-stdio-e2e-'));
  const verifiedTempRoot = await realpath(tempRoot);
  assert.ok(verifiedTempRoot.startsWith(`${await realpath(tempParent)}${process.platform === 'win32' ? '\\' : '/'}`));
  const projectRoot = join(tempRoot, 'project');
  const dataRoot = join(tempRoot, 'isolated-data-root');
  const sessionDirectory = join(projectRoot, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)]);
  await mkdir(sessionDirectory);

  const approvalMarker = join(projectRoot, 'approval-denied.txt');
  const childPidFiles = {
    cancel: join(projectRoot, 'cancel-child.pid'),
    disconnect: join(projectRoot, 'disconnect-child.pid'),
  };
  const execCommands = { cancel: 'node cancel-child.mjs', disconnect: 'node disconnect-child.mjs' };
  await Promise.all(Object.entries(execCommands).map(async ([name, command]) => {
    const scriptName = command.slice('node '.length);
    const pidName = childPidFiles[name].slice(projectRoot.length + 1);
    await writeFile(join(projectRoot, scriptName),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidName)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
  }));

  const apiKeyName = 'LIGULE_MCP_E2E_API_KEY';
  const apiKey = 'local-stub-key';
  const httpRequests = [];
  const providerGates = new Map([
    ['MCP_E2E_GATE_A', gate()],
    ['MCP_E2E_GATE_B', gate()],
  ]);
  let callId = 0;
  const endpoint = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      const lastUser = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const inputTags = ['MCP_E2E_DELAYED', 'MCP_E2E_LARGE_', 'MCP_E2E_EXEC_CANCEL', 'MCP_E2E_EXEC_DISCONNECT', 'MCP_E2E_APPROVAL_DENIED']
        .filter((tag) => lastUser.includes(tag));
      httpRequests.push({ url: request.url, model: body.model, inputTags, lastRole: body.messages.at(-1)?.role });
      if (body.messages.at(-1)?.role === 'tool') {
        sse(response, { content: 'MCP task finished' });
        return;
      }
      if (lastUser.includes('MCP_E2E_DELAYED')) {
        await delay(750);
        if (!response.destroyed) sse(response, { content: 'delayed task finished' });
        return;
      }
      const waitingGate = [...providerGates].find(([tag]) => lastUser.includes(tag))?.[1];
      if (waitingGate !== undefined) {
        waitingGate.markStarted();
        await waitingGate.waiting;
        if (!response.destroyed) sse(response, { content: 'gated task finished' });
        return;
      }
      let tool;
      let args;
      if (lastUser.includes('MCP_E2E_EXEC_CANCEL')) {
        tool = 'exec';
        args = { command: execCommands.cancel };
      } else if (lastUser.includes('MCP_E2E_EXEC_DISCONNECT')) {
        tool = 'exec';
        args = { command: execCommands.disconnect };
      } else if (lastUser.includes('MCP_E2E_APPROVAL_DENIED')) {
        tool = 'create';
        args = { path: 'approval-denied.txt', content: 'must not be written' };
      }
      if (tool === undefined) {
        sse(response, { content: 'MCP task finished' });
        return;
      }
      callId += 1;
      sse(response, { tool_calls: [{ index: 0, id: `mcp-e2e-call-${callId}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
    } catch (error) {
      if (!response.destroyed) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  let serverStarted = false;
  let logPath;
  const contexts = [];
  const key = `http://127.0.0.1:${await listenFetchable(endpoint)}/v1`;
  serverStarted = true;
  await writeFile(join(dataRoot, 'config.toml'), [
    '[model]',
    'api = "chat-completions"',
    `baseURL = ${tomlString(key)}`,
    'model = "mcp-e2e-local"',
    `apiKeyEnv = "${apiKeyName}"`,
    '',
    '[policy]',
    'mode = "ask"',
    '',
    '[[policy.rules]]',
    'tool = "exec"',
    `match = ${tomlString(execCommands.cancel)}`,
    'decision = "allow"',
    '',
    '[[policy.rules]]',
    'tool = "exec"',
    `match = ${tomlString(execCommands.disconnect)}`,
    'decision = "allow"',
    '',
    '[host]',
    `sessionDirectory = ${tomlString(sessionDirectory)}`,
    '',
    '[loop]',
    'iterations = 6',
    'modelCalls = 12',
    '',
    '[limits]',
    'contextTokens = 200000',
    'execBytes = 8192',
  ].join('\n'));
  const foreignRoot = join(tempRoot, 'foreign-project');
  await mkdir(foreignRoot);

  const connect = async () => {
    await setTrusted(projectRoot, true, join(dataRoot, 'tui-trust.json'));
    const context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey, sdkRoot });
    contexts.push(context);
    clients.add(context);
    return context;
  };
  const close = async (context) => {
    if (!clients.has(context)) return;
    clients.delete(context);
    await context.close();
  };

  try {
    const first = await connect();
    assert.equal(first.client.getServerVersion()?.name, 'ligule', 'SDK initialize returns the real server identity');
    recordTrace(trace, 'initialize', { server: first.client.getServerVersion() });

    const listed = await first.client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'ligule_run_cancel', 'ligule_run_start', 'ligule_run_status', 'ligule_session_create',
      'ligule_session_list', 'ligule_session_open', 'ligule_session_read',
    ]);
    const readSchema = listed.tools.find((tool) => tool.name === 'ligule_session_read').inputSchema;
    assert.ok(readSchema.properties.at && readSchema.properties.offset, 'tools/list publishes bounded exact-event chunk reads');
    assert.deepEqual(readSchema.required, ['sessionId']);
    recordTrace(trace, 'tools_list', { toolNames });

    await assert.rejects(
      first.client.callTool({ name: 'not_a_ligule_tool', arguments: {} }),
      (error) => error.code === -32602,
      'unknown tools fail as MCP InvalidParams',
    );
    await assert.rejects(
      first.client.callTool({ name: 'ligule_session_create', arguments: {} }),
      (error) => error.code === -32602,
      'missing required schema arguments fail as MCP InvalidParams',
    );
    await assert.rejects(
      first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId: 'x', input: 'ok', extra: true } }),
      (error) => error.code === -32602,
      'additional arguments fail the declared schema',
    );
    recordTrace(trace, 'schema_rejections', { unknownTool: -32602, missingArgument: -32602, extraArgument: -32602 });

    const project = await realpath(projectRoot);
    const created = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create');
    const sessionId = created.sessionId;
    recordTrace(trace, 'session_create', { sessionId });
    const opened = toolData(await first.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'session_open');
    assert.equal(opened.sessionId, sessionId);
    recordTrace(trace, 'session_open_existing', { sessionId });
    const legacy = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create_legacy_fixture');
    const legacyPath = join(sessionDirectory, `${legacy.sessionId}.jsonl`);
    await writeFile(legacyPath, `${JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: legacy.sessionId,
      projectRoot: project, createdAt: 'c'.repeat(140) })}\n${JSON.stringify({ seq: 1, kind: 'label', name: 'n'.repeat(140) })}\n`);
    const sessions = toolData(await first.client.callTool({ name: 'ligule_session_list', arguments: { projectRoot: project, limit: 20 } }), 'session_list');
    assert.ok(sessions.sessions.some((session) => session.sessionId === sessionId));
    const normalizedLegacy = sessions.sessions.find((session) => session.sessionId === legacy.sessionId);
    assert.equal(normalizedLegacy.name.length, 120, 'legacy session names are bounded at the MCP boundary');
    assert.equal(normalizedLegacy.createdAt.length, 128, 'legacy timestamps are bounded at the MCP boundary');
    const legacyLines = (await readFile(legacyPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(legacyLines[0].createdAt.length, 140, 'MCP normalization does not rewrite the stored timestamp');
    assert.equal(legacyLines[1].name.length, 140, 'MCP normalization does not rewrite the stored name');
    recordTrace(trace, 'session_list', { count: sessions.sessions.length, includesCreated: true });

    const foreignCreate = await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: foreignRoot } });
    toolFailure(foreignCreate, 'control_project_forbidden', 'session_create_foreign_project');
    const foreignList = await first.client.callTool({ name: 'ligule_session_list', arguments: { projectRoot: foreignRoot } });
    toolFailure(foreignList, 'control_project_forbidden', 'session_list_foreign_project');
    const foreignOpen = await first.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: foreignRoot, sessionId } });
    toolFailure(foreignOpen, 'control_project_forbidden', 'session_open_foreign_project');
    const missingOpen = await first.client.callTool({
      name: 'ligule_session_open', arguments: { projectRoot: project, sessionId: '00000000-0000-4000-8000-000000000000' },
    });
    toolFailure(missingOpen, 'session_not_found', 'session_open_missing');
    recordTrace(trace, 'project_and_missing_session_boundaries', {
      create: toolFailureCode(foreignCreate), list: toolFailureCode(foreignList),
      open: toolFailureCode(foreignOpen), missing: toolFailureCode(missingOpen),
    });

    const startAt = performance.now();
    const delayed = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_DELAYED' } }), 'run_start_delayed');
    const startMs = Math.round(performance.now() - startAt);
    assert.ok(startMs < 700, `run_start waited ${startMs}ms for a deliberately delayed Provider`);
    assert.equal(delayed.state, 'running');
    const running = toolData(await first.client.callTool({ name: 'ligule_run_status', arguments: { operationId: delayed.operationId } }), 'run_status_running');
    assert.equal(running.state, 'running');
    recordTrace(trace, 'run_start_returns_before_provider', { operationId: delayed.operationId, startMs, state: running.state });
    const delayedDone = await waitForOutcome(first.client, delayed.operationId);
    assert.equal(delayedDone.state, 'done');
    recordTrace(trace, 'run_status_done', { operationId: delayed.operationId, state: delayedDone.state });

    const largeInput = `MCP_E2E_LARGE_${'x'.repeat(13_000)}`;
    const largeRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: largeInput } }), 'run_start_large');
    const largeDone = await waitForOutcome(first.client, largeRun.operationId);
    assert.equal(largeDone.state, 'done');
    const foundLarge = await findHistoryRecord(first.client, sessionId, (record) => record.kind === 'user' && record.json.includes('MCP_E2E_LARGE_'));
    const userRecord = foundLarge?.record;
    assert.ok(userRecord, 'the large user record is in the persistent session history');
    assert.equal(userRecord.offset, 0);
    assert.ok(userRecord.totalCharacters > 8192);
    assert.ok(userRecord.json.length <= 8192);
    let reconstructed = userRecord.json;
    let offset = userRecord.nextOffset;
    while (offset !== null) {
      const chunk = toolData(await first.client.callTool({
        name: 'ligule_session_read', arguments: { sessionId, at: userRecord.seq, offset },
      }), 'session_read_chunk').records;
      assert.equal(chunk.length, 1);
      assert.equal(chunk[0].seq, userRecord.seq);
      assert.equal(chunk[0].offset, offset);
      assert.ok(chunk[0].json.length <= 8192);
      reconstructed += chunk[0].json;
      offset = chunk[0].nextOffset;
    }
    const fullUserRecord = JSON.parse(reconstructed);
    assert.equal(fullUserRecord.raw ?? fullUserRecord.text, largeInput, 'all chunks combine to the exact original record');
    assert.equal(reconstructed.length, userRecord.totalCharacters);
    recordTrace(trace, 'session_read_chunked_large_event', {
      seq: userRecord.seq, totalCharacters: userRecord.totalCharacters,
      chunks: Math.ceil(userRecord.totalCharacters / 8192), exactInputRestored: true,
    });

    const sessionB = toolData(await first.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'session_create_b');
    const operationA = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_GATE_A' } }), 'run_start_gate_a');
    const operationB = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId: sessionB.sessionId, input: 'MCP_E2E_GATE_B' } }), 'run_start_gate_b');
    await Promise.all([providerGates.get('MCP_E2E_GATE_A').entered, providerGates.get('MCP_E2E_GATE_B').entered]);
    const cancelledA = toolData(await first.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: operationA.operationId } }), 'run_cancel_a');
    assert.equal(cancelledA.state, 'cancelled');
    const stillRunningB = toolData(await first.client.callTool({ name: 'ligule_run_status', arguments: { operationId: operationB.operationId } }), 'run_status_b_after_cancel_a');
    assert.equal(stillRunningB.state, 'running', 'cancelling A leaves B blocked on its independent Provider response');
    providerGates.get('MCP_E2E_GATE_A').release();
    providerGates.get('MCP_E2E_GATE_B').release();
    const completedB = await waitForOutcome(first.client, operationB.operationId);
    assert.equal(completedB.state, 'done');
    recordTrace(trace, 'cancel_is_scoped_to_originating_session', {
      operationA: operationA.operationId, operationB: operationB.operationId,
      aState: cancelledA.state, bStateAfterCancelA: stillRunningB.state, bFinalState: completedB.state,
    });

    const cancelRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_EXEC_CANCEL' } }), 'run_start_cancel_child');
    const cancelPid = await waitForChildPid(first.client, sessionId, cancelRun.operationId, childPidFiles.cancel, 'exec_cancel');
    assert.ok(Number.isInteger(cancelPid) && cancelPid > 0);
    const concurrent = await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'must be rejected' } });
    toolFailure(concurrent, 'run_already_running', 'run_start_concurrent');
    const cancelled = toolData(await first.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: cancelRun.operationId } }), 'run_cancel_child');
    assert.equal(cancelled.terminated, true);
    assert.equal(cancelled.state, 'cancelled');
    await waitFor(() => !processIsAlive(cancelPid), `cancelled exec process ${cancelPid} to exit`);
    recordTrace(trace, 'run_cancel_and_exec_tree_exit', { operationId: cancelRun.operationId, state: cancelled.state, childExited: true, concurrentCode: toolFailureCode(concurrent) });

    const approvalRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_APPROVAL_DENIED' } }), 'run_start_approval');
    const approvalDone = await waitForOutcome(first.client, approvalRun.operationId);
    assert.equal(approvalDone.state, 'done');
    await assert.rejects(access(approvalMarker), (error) => error.code === 'ENOENT', 'the denied create operation left no file');
    const deniedToolRecord = await findHistoryRecord(first.client, sessionId, (record) => record.kind === 'tool' && record.json.includes('approval-denied.txt'));
    const deniedTool = deniedToolRecord === undefined ? undefined : JSON.parse(deniedToolRecord.record.json);
    assert.equal(deniedTool?.result?.kind, 'refusal');
    assert.equal(deniedTool?.result?.code, 'ask_declined');
    recordTrace(trace, 'approval_denied_without_side_effect', { operationId: approvalRun.operationId, state: approvalDone.state, refusalCode: deniedTool.result.code, markerAbsent: true });

    const locked = await connect();
    const lockedResult = await locked.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } });
    toolFailure(lockedResult, 'session_locked', 'session_open_cross_process_lock');
    recordTrace(trace, 'cross_process_session_lock', { sessionId, errorCode: toolFailureCode(lockedResult) });
    await close(locked);

    const disconnectRun = toolData(await first.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_E2E_EXEC_DISCONNECT' } }), 'run_start_disconnect_child');
    const disconnectPid = await waitForChildPid(first.client, sessionId, disconnectRun.operationId, childPidFiles.disconnect, 'exec_disconnect');
    assert.ok(Number.isInteger(disconnectPid) && disconnectPid > 0);
    assert.notEqual(disconnectPid, cancelPid, 'disconnect run starts a fresh child process');
    const closeAt = performance.now();
    await close(first);
    const closeMs = Math.round(performance.now() - closeAt);
    assert.ok(closeMs < 2_000, `stdio disconnect took ${closeMs}ms to release the Host`);
    await waitFor(() => !processIsAlive(disconnectPid), `disconnected exec process ${disconnectPid} to exit`);
    recordTrace(trace, 'stdio_disconnect_releases_active_run', { operationId: disconnectRun.operationId, closeMs, childExited: true });

    const resumed = await connect();
    const reattached = toolData(await resumed.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'session_open_after_restart');
    assert.equal(reattached.sessionId, sessionId);
    const persisted = await findHistoryRecord(resumed.client, sessionId, (record) => record.kind === 'user' && record.json.includes('MCP_E2E_LARGE_'));
    assert.ok(persisted, 'the large user record persists after restart');
    const staleOperation = await resumed.client.callTool({ name: 'ligule_run_status', arguments: { operationId: disconnectRun.operationId } });
    toolFailure(staleOperation, 'operation_not_found', 'run_status_old_process_operation');
    recordTrace(trace, 'restart_reopens_history_and_rejects_old_operation', {
      sessionId, historyRecords: persisted.page.records.length, oldOperationCode: toolFailureCode(staleOperation),
    });
    await close(resumed);
    assert.ok(httpRequests.length >= 5, `expected real Provider HTTP traffic, saw ${httpRequests.length} requests`);
    recordTrace(trace, 'provider_stub_requests', { count: httpRequests.length, endpoint: '127.0.0.1 local HTTP stub' });
  } catch (error) {
    recordTrace(trace, 'test_failure', {
      errorName: error instanceof Error ? error.name : 'unknown',
      providerRequests: httpRequests.map(({ inputTags, lastRole }) => ({ inputTags, lastRole })),
    });
    throw error;
  } finally {
    for (const context of [...clients]) {
      try { await close(context); } catch (error) { recordTrace(trace, 'cleanup_error', { code: error instanceof Error ? error.name : 'unknown' }); }
    }
    if (serverStarted) {
      endpoint.closeAllConnections();
      await new Promise((done) => endpoint.close(done));
    }
    const readings = join(testplaceRoot, 'readings', 'phase5');
    await mkdir(readings, { recursive: true });
    logPath = join(readings, `mcp-stdio-e2e-${Date.now()}.jsonl`);
    await writeFile(logPath, `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    t.diagnostic(`MCP E2E trace: ${logPath}`);
    await rm(verifiedTempRoot, { recursive: true, force: true });
  }
});
