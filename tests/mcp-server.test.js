import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LoggingMessageNotificationSchema } from '../core/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { listenFetchable } from '../test/helpers/port.ts';
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
      httpRequests.push({ url: request.url, model: body.model, inputTags, lastRole: body.messages.at(-1)?.role,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name) });
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
      'ligule_interaction_reply', 'ligule_run_cancel', 'ligule_run_start', 'ligule_run_status', 'ligule_session_configure', 'ligule_session_create',
      'ligule_session_list', 'ligule_session_open', 'ligule_session_read', 'ligule_session_send',
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
    const readOnlySettings = toolData(await first.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'default_session_settings_read');
    assert.equal(readOnlySettings.applies, 'unchanged');
    const unauthorizedChange = await first.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } });
    toolFailure(unauthorizedChange, 'control_operator_required', 'default_settings_change_denied');
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
    const firstProviderRequest = await waitFor(() => httpRequests.find((entry) => entry.inputTags.includes('MCP_E2E_DELAYED')), 'delayed HTTP request');
    assert.ok(!firstProviderRequest.toolNames.includes('ask_user_question'), 'question tool is not registered without operator authorization');
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

test('operator tools configure real sessions, answer Host interactions, and run bounded queues', { timeout: 60_000 }, async (t) => {
  const parent = resolve(process.env.LIGULE_MCP_E2E_TEMP_ROOT ?? join(testplaceRoot, 'tmp'));
  await mkdir(parent, { recursive: true });
  const tempRoot = await mkdtemp(join(parent, 'mcp-operator-e2e-'));
  const projectRoot = join(tempRoot, 'project');
  const dataRoot = join(tempRoot, 'data');
  const sessionDirectory = join(projectRoot, 'sessions');
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)]);
  await mkdir(sessionDirectory);
  const apiKeyName = 'LIGULE_MCP_OPERATOR_E2E_API_KEY';
  const fixtureCredential = 'local-operator-test-key';
  const markerAllowed = join(projectRoot, 'operator-approved.txt');
  const markerDenied = join(projectRoot, 'operator-denied.txt');
  const markerHardDenied = join(projectRoot, 'policy-forbidden.txt');
  const markerSensitive = join(projectRoot, 'operator-secret-executed.txt');
  const requests = [];
  const queueGate = gate();
  const cancelGate = gate();
  let callId = 0;
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const last = body.messages.at(-1);
    const userText = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    if (last?.role === 'tool') { sse(response, { content: 'operator task completed' }); return; }
    const waiting = userText.includes('MCP_OPERATOR_QUEUE_GATE') ? queueGate
      : userText.includes('MCP_OPERATOR_CANCEL_GATE') ? cancelGate : undefined;
    if (waiting !== undefined) {
      waiting.markStarted();
      await waiting.waiting;
      if (!response.destroyed) sse(response, { content: 'gate released' });
      return;
    }
    let tool;
    let args;
    if (userText.includes('MCP_OPERATOR_APPROVE')) {
      tool = 'create'; args = { path: 'operator-approved.txt', content: 'approved by the operator' };
    } else if (userText.includes('MCP_OPERATOR_DENY')) {
      tool = 'create'; args = { path: 'operator-denied.txt', content: 'must remain absent' };
    } else if (userText.includes('MCP_OPERATOR_HARD_DENY')) {
      tool = 'create'; args = { path: 'policy-forbidden.txt', content: 'policy must remain final' };
    } else if (userText.includes('MCP_OPERATOR_QUESTION')) {
      tool = 'ask_user_question'; args = { questions: JSON.stringify([{ question: 'Which option should be used?', options: [{ label: 'Option A' }, { label: 'Option B' }] }]) };
    } else if (userText.includes('MCP_OPERATOR_SENSITIVE_APPROVAL')) {
      tool = 'exec'; args = { command: `node -e "require('node:fs').writeFileSync('operator-secret-executed.txt','unexpected')" 'Bearer synthetic-secret-token'` };
    } else if (userText.includes('MCP_OPERATOR_SENSITIVE_HEADER')) {
      tool = 'create'; args = { path: 'operator-secret-executed.txt', content: 'X-API-Key: synthetic-header-secret' };
    }
    if (tool === undefined) { sse(response, { content: 'operator task completed' }); return; }
    callId += 1;
    sse(response, { tool_calls: [{ index: 0, id: `operator-call-${callId}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
  });
  const baseURL = `http://127.0.0.1:${await listenFetchable(endpoint)}/v1`;
  await writeFile(join(dataRoot, 'config.toml'), [
    '[model]', 'api = "chat-completions"', `baseURL = ${tomlString(baseURL)}`,
    'model = "operator-e2e-local"', `apiKeyEnv = "${apiKeyName}"`, '',
    '[policy]', 'mode = "ask"', '', '[host]', `sessionDirectory = ${tomlString(sessionDirectory)}`,
    '', '[limits]', 'contextTokens = 200000', '', '[loop]', 'iterations = 8', 'modelCalls = 16', '',
  ].join('\n'));
  await setTrusted(projectRoot, true, join(dataRoot, 'tui-trust.json'));
  let context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey: fixtureCredential, sdkRoot, operator: true });
  const notifications = [];
  context.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { notifications.push(notification); });
  try {
    const names = (await context.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 10);
    const project = await realpath(projectRoot);
    const invalidInitialModel = await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: { model: { provider: 'legacy', model: 'not-in-this-config' } },
    } });
    toolFailure(invalidInitialModel, 'model_not_available', 'unlisted_initial_model');
    const created = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: {
      projectRoot: project, initial: { mode: 'minimal', policy: 'ask', outputTokens: 2048 },
    } }), 'operator_session_create');
    const sessionId = created.sessionId;
    assert.equal(created.settingsApplied, true);

    const readSettings = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'session_configure_read');
    assert.equal(readSettings.applies, 'unchanged');
    assert.equal(readSettings.effective.policy.mode, 'ask');
    assert.equal(readSettings.effective.generation.outputTokens, 2048);
    assert.ok(readSettings.available.services.some((service) => service.id === 'legacy' && service.models[0].id === 'operator-e2e-local'));
    const invalidConfiguredModel = await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: { model: { provider: 'legacy', model: 'not-in-this-config' } },
    } });
    toolFailure(invalidConfiguredModel, 'model_not_available', 'unlisted_session_model');
    const generationChanged = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: {
      sessionId, changes: { model: { provider: 'legacy', model: 'operator-e2e-local' }, outputTokens: 2048 },
    } }), 'session_configure_model_and_budget');
    assert.equal(generationChanged.applies, 'now');
    const modeChanged = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'full' } } }), 'session_configure_mode_full');
    assert.equal(modeChanged.applies, 'now');
    assert.equal(modeChanged.effective.mode, 'full');
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'minimal' } } }), 'session_configure_mode_minimal');
    const unsupported = await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { thinking: { effort: 'high' } } } });
    toolFailure(unsupported, 'provider_thinking_unsupported', 'unsupported_thinking');
    await assert.rejects(context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { mode: 'minimal', policy: 'ask' } } }),
      (error) => error.code === -32602, 'schema rejects cross-category partial configuration');
    const changed = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } }), 'session_configure_output');
    assert.equal(changed.applies, 'now');
    assert.equal(changed.effective.generation.outputTokens, 1024);
    const simple = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_WIRE_BUDGET' } }), 'operator_budget_run');
    assert.equal((await waitForOutcome(context.client, simple.operationId)).state, 'done');
    assert.equal(requests.find((body) => body.messages.at(-1)?.content === 'MCP_OPERATOR_WIRE_BUDGET')?.max_tokens, 1024);

    const approveRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_APPROVE' } }), 'operator_approval_run');
    const approvalStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: approveRun.operationId } }), 'operator_approval_status');
      return status.pendingInteractions.some((interaction) => interaction.type === 'approval') ? status : undefined;
    }, 'approval request');
    const approval = approvalStatus.pendingInteractions.find((interaction) => interaction.type === 'approval');
    assert.equal(approval.details.tool, 'create');
    assert.equal(approval.details.args.path, 'operator-approved.txt');
    assert.equal(approvalStatus.waitingFor, 'approval');
    const foreignSession = toolData(await context.client.callTool({ name: 'ligule_session_create', arguments: { projectRoot: project } }), 'operator_foreign_session');
    const wrongType = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'question', answers: [{ id: 'q1', selected: ['Option A'] }],
    } });
    toolFailure(wrongType, 'control_interaction_type_mismatch', 'wrong_interaction_type');
    const wrongSession = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId: foreignSession.sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(wrongSession, 'control_interaction_session_mismatch', 'cross_session_reply');
    const accepted = toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } }), 'operator_approval_reply');
    assert.equal(accepted.resolved, true);
    assert.equal((await waitForOutcome(context.client, approveRun.operationId)).state, 'done');
    assert.equal(await readFile(markerAllowed, 'utf8'), 'approved by the operator');
    const repeated = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: approval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(repeated, 'control_interaction_stale', 'duplicate_approval_reply');

    const denyRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_DENY' } }), 'operator_denial_run');
    const denyStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: denyRun.operationId } }), 'operator_denial_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'approval');
    }, 'denial request');
    toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: denyStatus.requestId, type: 'approval', decision: 'deny',
    } }), 'operator_denial_reply');
    assert.equal((await waitForOutcome(context.client, denyRun.operationId)).state, 'done');
    await assert.rejects(access(markerDenied), (error) => error.code === 'ENOENT');

    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'never' } } }), 'operator_set_never');
    const hardDenyRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_HARD_DENY' } }), 'operator_hard_deny_run');
    const hardDenyDone = await waitForOutcome(context.client, hardDenyRun.operationId);
    assert.equal(hardDenyDone.state, 'done');
    assert.equal(hardDenyDone.pendingInteractions.length, 0, 'a Policy hard denial is not exposed as an overridable approval');
    await assert.rejects(access(markerHardDenied), (error) => error.code === 'ENOENT');
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { policy: 'ask' } } }), 'operator_restore_ask');

    const questionRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_QUESTION' } }), 'operator_question_run');
    const questionStatus = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: questionRun.operationId } }), 'operator_question_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'question');
    }, 'question request');
    assert.equal(questionStatus.details.questions[0].question, 'Which option should be used?');
    toolData(await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: questionStatus.requestId, type: 'question', answers: [{ id: 'q1', selected: ['Option B'] }],
    } }), 'operator_question_reply');
    assert.equal((await waitForOutcome(context.client, questionRun.operationId)).state, 'done');
    assert.ok((await findHistoryRecord(context.client, sessionId, (entry) => entry.kind === 'tool' && entry.json.includes('Option B'))));

    const sensitiveRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_SENSITIVE_APPROVAL' } }), 'operator_sensitive_approval_run');
    const sensitiveDone = await waitForOutcome(context.client, sensitiveRun.operationId);
    assert.equal(sensitiveDone.state, 'done');
    assert.equal(sensitiveDone.pendingInteractions.length, 0);
    assert.ok(sensitiveDone.events.some((event) => event.kind === 'interaction.rejected' && event.code === 'control_interaction_sensitive'));
    await assert.rejects(access(markerSensitive), (error) => error.code === 'ENOENT', 'sensitive approval data is denied before the command side effect');

    const sensitiveHeaderRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: {
      sessionId, input: 'MCP_OPERATOR_SENSITIVE_HEADER',
    } }), 'operator_sensitive_header_run');
    const sensitiveHeaderDone = await waitForOutcome(context.client, sensitiveHeaderRun.operationId);
    assert.equal(sensitiveHeaderDone.state, 'done');
    assert.equal(sensitiveHeaderDone.pendingInteractions.length, 0, 'credential header must not become an approvable interaction');
    assert.ok(sensitiveHeaderDone.events.some((event) =>
      event.kind === 'interaction.rejected' && event.code === 'control_interaction_sensitive'));
    await assert.rejects(access(markerSensitive), (error) => error.code === 'ENOENT', 'credential header is rejected without writing the file');

    const staleRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_APPROVE' } }), 'operator_stale_approval_run');
    const staleApproval = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: staleRun.operationId } }), 'operator_stale_approval_status');
      return status.pendingInteractions.find((interaction) => interaction.type === 'approval');
    }, 'approval to cancel');
    const cancelledInteractionRun = toolData(await context.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: staleRun.operationId } }), 'cancel_pending_approval');
    assert.equal(cancelledInteractionRun.state, 'cancelled');
    const lateReply = await context.client.callTool({ name: 'ligule_interaction_reply', arguments: {
      sessionId, requestId: staleApproval.requestId, type: 'approval', decision: 'allow',
    } });
    toolFailure(lateReply, 'control_interaction_stale', 'late_reply_after_cancel');

    const queuedRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_QUEUE_GATE' } }), 'queue_gate_run');
    await queueGate.entered;
    const pendingBudget = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 512 } } }), 'queue_pending_budget');
    assert.equal(pendingBudget.applies, 'next_round');
    assert.equal(pendingBudget.pending.generation.outputTokens, 512);
    const queuedFirst = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'queued first' } }), 'queue_first');
    const queuedSecond = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'queued second' } }), 'queue_second');
    assert.equal(queuedFirst.queued, true);
    toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, action: 'cancel_queued', queueItemId: queuedSecond.queueItemId } }), 'queue_cancel_second');
    queueGate.release();
    assert.equal((await waitForOutcome(context.client, queuedRun.operationId)).state, 'done');
    const firstQueuedOperation = await waitFor(async () => {
      const status = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: queuedRun.operationId } }), 'queue_completed_status');
      return status.events.find((event) => event.kind === 'queue.started')?.newOperationId;
    }, 'auto-started queued run');
    assert.equal((await waitForOutcome(context.client, firstQueuedOperation)).state, 'done');
    await waitFor(() => requests.some((body) => body.messages.filter((message) => message.role === 'user').at(-1)?.content === 'queued first'), 'queued Provider request');
    assert.equal(requests.find((body) => body.messages.filter((message) => message.role === 'user').at(-1)?.content === 'queued first')?.max_tokens, 512);
    const tailStatus = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: firstQueuedOperation } }), 'queue_tail_status');
    assert.equal(tailStatus.queue.length, 0);
    toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId, changes: { outputTokens: 1024 } } }), 'queue_restore_budget');
    const cancelRun = toolData(await context.client.callTool({ name: 'ligule_run_start', arguments: { sessionId, input: 'MCP_OPERATOR_CANCEL_GATE' } }), 'queue_cancel_run');
    await cancelGate.entered;
    const remainsQueued = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, input: 'continue after cancellation' } }), 'queue_cancel_pending');
    const cancelledRun = toolData(await context.client.callTool({ name: 'ligule_run_cancel', arguments: { operationId: cancelRun.operationId } }), 'queue_cancel_active');
    assert.equal(cancelledRun.state, 'cancelled');
    assert.equal(cancelledRun.queuePaused, true);
    assert.equal(cancelledRun.queue.length, 1);
    cancelGate.release();
    const continued = toolData(await context.client.callTool({ name: 'ligule_session_send', arguments: { sessionId, action: 'continue' } }), 'queue_continue');
    assert.ok(continued.currentOperationId);
    assert.equal((await waitForOutcome(context.client, continued.currentOperationId)).state, 'done');
    assert.ok(notifications.length > 0, 'stdio client receives best-effort event notifications');
    const paged = toolData(await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: firstQueuedOperation, after: 0, limit: 1 } }), 'event_page');
    assert.equal(paged.events.length, 1);
    assert.equal(paged.events[0].cursor, 1);
    assert.equal(paged.hasMoreEvents, true);
    t.diagnostic(`operator MCP notifications received: ${notifications.length}`);
    await context.close();
    context = await connectMcp({ cliPath, projectRoot, dataRoot, apiKeyName, apiKey: fixtureCredential, sdkRoot, operator: true });
    const reopened = toolData(await context.client.callTool({ name: 'ligule_session_open', arguments: { projectRoot: project, sessionId } }), 'operator_session_reopen');
    assert.equal(reopened.sessionId, sessionId);
    const restored = toolData(await context.client.callTool({ name: 'ligule_session_configure', arguments: { sessionId } }), 'operator_settings_after_restart');
    assert.equal(restored.effective.generation.outputTokens, 1024, 'generation settings replay from Session JSONL after server restart');
    assert.equal(restored.effective.generation.model.model, 'operator-e2e-local');
    const staleOperation = await context.client.callTool({ name: 'ligule_run_status', arguments: { operationId: simple.operationId } });
    toolFailure(staleOperation, 'operation_not_found', 'operator_old_operation_after_restart');
  } finally {
    queueGate.release();
    cancelGate.release();
    await context.close();
    endpoint.closeAllConnections();
    await new Promise((done) => endpoint.close(done));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
