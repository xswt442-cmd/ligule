import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRunAcceptance } from '../dist/session/run.js';
import { createSessionLog } from '../dist/session/session.js';
import { workspaceIdentity } from '../dist/kernel/workspace.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

test('Host tool.result pages one call spill without loading the whole result or creating another result event', {
  timeout: 20_000,
}, async () => {
  let step = 0;
  const sourceText = 'x'.repeat(1_015) + '😀中文' + 'x'.repeat(40_000);
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests }) => {
    await writeFile(join(projectDirectory, 'large-read.txt'), sourceText);
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'read the bounded P13 output fixture' });
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; phase?: string; result?: Record<string, unknown> }[];
    };
    const tool = record.events.find((event) => event.kind === 'tool' && event.tool === 'read');
    assert.ok(typeof tool?.callId === 'string' && typeof tool.runId === 'string', JSON.stringify(tool));
    assert.equal(typeof tool.result?.spilled, 'string', 'the fixed resultBytes limit spilled the complete tool value');
    assert.equal(record.events.filter((event) => event.kind === 'tool' && event.callId === tool.callId).length, 1,
      'querying facts must not append a second tool result');
    assert.equal(record.events.filter((event) => event.kind === 'toolActivity' && event.callId === tool.callId)
      .some((event) => event.runId === tool.runId && event.tool === tool.tool && event.phase === 'started'), true);

    const first = await client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal(first.state, 'completed');
    assert.equal(first.tool, 'read');
    const firstOutput = first.output as Record<string, unknown>;
    assert.equal(firstOutput.storageStatus, 'spill');
    const expectedBytes = Buffer.from(JSON.stringify({ text: sourceText }));
    assert.equal(firstOutput.returnedValueBytes, expectedBytes.length);
    assert.ok(Number(firstOutput.modelVisibleBytes) <= 16_000);
    assert.ok(Number(firstOutput.storedBytes) > Number(firstOutput.modelVisibleBytes));
    assert.equal(firstOutput.storedComplete, true);
    const firstPage = firstOutput.page as Record<string, unknown>;
    assert.equal(firstPage.offset, 0);
    assert.deepEqual(Buffer.from(String(firstPage.dataBase64), 'base64'), expectedBytes.subarray(0, 1_024));
    assert.ok(String(firstPage.nextCursor).length > 0);

    const repeat = await client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.deepEqual((repeat.output as Record<string, unknown>).page, firstPage,
      'a second reader starts at the same independent cursor');
    const second = await client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, cursor: String(firstPage.nextCursor), limitBytes: 1_024,
    }) as Record<string, unknown>;
    const secondPage = (second.output as Record<string, unknown>).page as Record<string, unknown>;
    assert.equal(secondPage.offset, 1_024);
    assert.deepEqual(Buffer.from(String(secondPage.dataBase64), 'base64'), expectedBytes.subarray(1_024, 2_048));
    assert.notEqual(secondPage.nextCursor, firstPage.nextCursor);
    await assert.rejects(client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, cursor: `${String(firstPage.nextCursor)}x`, limitBytes: 1_024,
    }), { code: 'tool_result_cursor_invalid' });

    const spillName = String(tool.result?.spilled);
    await writeFile(join(sessionDirectory, spillName), 'tampered spill content');
    await assert.rejects(client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, limitBytes: 1_024,
    }), { code: 'session_spill_integrity_invalid' });
    await rm(join(sessionDirectory, spillName), { force: true });
    await assert.rejects(client.request('tool.result', {
      sessionId, runId: tool.runId, callId: tool.callId, limitBytes: 1_024,
    }), { code: 'session_spill_read_failed' });

    await assert.rejects(client.request('tool.result', {
      sessionId, runId: randomUUID(), callId: tool.callId, limitBytes: 1_024,
    }), { code: 'run_not_found' });
    await assert.rejects(client.request('tool.result', {
      sessionId, runId: tool.runId, callId: randomUUID(), limitBytes: 1_024,
    }), { code: 'tool_call_not_found' });
    assert.ok(providerRequests.length >= 2);
  }, {
    providerReply: () => step++ === 0
      ? { toolCalls: [{ tool: 'read', args: { path: 'large-read.txt' } }] }
      : { text: 'bounded tool result inspected' },
    config: { limits: { resultBytes: 1_024 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('Host tool.result reports a call waiting for approval without treating activity as a final result', {
  timeout: 20_000,
}, async () => {
  let step = 0;
  let resolveApproval: ((value: unknown) => void) | undefined;
  await withTuiHost(async ({ client, sessionId }) => {
    client.onRequest((message) => message.method === 'approval.request'
      ? new Promise((resolve) => { resolveApproval = resolve; }) : undefined);
    const accepted = await client.request('run.submit', { sessionId, input: 'read while approval is pending' }) as { runId: string };
    let events: { kind?: string; runId?: string; callId?: string; phase?: string; toolCalls?: unknown[] }[] = [];
    await waitFor(async () => {
      const record = await client.request('session.read', { sessionId }) as { events: typeof events };
      events = record.events;
      return events.some((event) => event.kind === 'toolActivity' && event.phase === 'awaiting_approval');
    }, { within: 5_000 });
    const assistant = events.find((event) => event.kind === 'assistant' && Array.isArray(event.toolCalls)
      && event.toolCalls.some((call) => typeof call === 'object' && call !== null && 'id' in call));
    assert.ok(assistant?.toolCalls);
    const call = assistant.toolCalls.find((value) => typeof value === 'object' && value !== null
      && 'name' in value && (value as { name?: unknown }).name === 'read') as { id: string } | undefined;
    assert.ok(call);
    const result = await client.request('tool.result', {
      sessionId, runId: accepted.runId, callId: call.id, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal(result.state, 'awaiting_approval');
    assert.equal(result.lastActivity, 'awaiting_approval');
    assert.equal('output' in result, false);
    assert.equal(events.filter((event) => event.kind === 'tool' && event.callId === call.id).length, 0,
      'an activity event does not stand in for a final tool result');
    assert.ok(resolveApproval);
    resolveApproval({ decision: 'allow' });
    const settled = await client.request('run.wait', { sessionId, runId: accepted.runId }) as { runId: string };
    assert.equal(settled.runId, accepted.runId);
    const final = await client.request('session.read', { sessionId }) as { events: typeof events };
    assert.equal(final.events.filter((event) => event.kind === 'tool' && event.callId === call.id).length, 1);
  }, {
    providerReply: () => step++ === 0
      ? { toolCalls: [{ tool: 'read', args: { path: 'pending-read.txt' } }] }
      : { text: 'read complete' },
    setup: async ({ projectDirectory }) => writeFile(join(projectDirectory, 'pending-read.txt'), 'readable'),
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('Host tool.result distinguishes schema rejection from an executed tool failure', { timeout: 20_000 }, async () => {
  let step = 0;
  let denyNextApproval = false;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    client.onRequest((message) => {
      if (message.method !== 'approval.request') return undefined;
      if (denyNextApproval) { denyNextApproval = false; return { decision: 'deny' }; }
      return { decision: 'allow' };
    });
    await client.request('run.start', { sessionId, input: 'exercise invalid and failing reads' });
    await client.request('run.start', { sessionId, input: 'exercise a read of a missing file' });
    denyNextApproval = true;
    await client.request('run.start', { sessionId, input: 'exercise a policy refusal' });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; phase?: string; result?: Record<string, unknown> }[];
    };
    const reads = history.events.filter((event) => event.kind === 'tool' && event.tool === 'read');
    assert.equal(reads.length, 3);
    for (const event of reads.slice(0, 2)) {
      assert.equal(typeof event.callId, 'string');
      assert.equal(typeof event.runId, 'string');
      const result = await client.request('tool.result', {
        sessionId, runId: event.runId, callId: event.callId, limitBytes: 1_024,
      }) as Record<string, unknown>;
      assert.equal(result.state, 'failed');
      assert.equal(typeof (result.result as Record<string, unknown>).code, 'string');
    }
    const invalid = reads.find((event) => (event.result as Record<string, unknown>)?.code === 'tool_args_invalid');
    const missing = reads.find((event) => (event.result as Record<string, unknown>)?.code === 'path_not_found');
    const refused = reads.find((event) => (event.result as Record<string, unknown>)?.kind === 'refusal');
    assert.ok(invalid, JSON.stringify(reads));
    assert.ok(missing, JSON.stringify(reads));
    assert.ok(refused, JSON.stringify(reads));
    assert.equal(history.events.some((event) => event.kind === 'toolActivity' && event.callId === invalid.callId), false,
      'preflight rejection has a result but no started activity');
    assert.equal(history.events.some((event) => event.kind === 'toolActivity' && event.callId === missing.callId
      && event.phase === 'started'), true, 'an executed failure has a started activity');
    const refusal = await client.request('tool.result', {
      sessionId, runId: refused.runId, callId: refused.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal(refusal.state, 'refused');
    assert.equal((refusal.result as Record<string, unknown>).kind, 'refusal');
  }, {
    setup: async ({ projectDirectory }) => writeFile(join(projectDirectory, 'refused-read.txt'), 'allow would read this'),
    providerReply: () => {
      step += 1;
      if (step === 1) return { toolCalls: [{ tool: 'read', args: { path: 17 } }] };
      if (step === 3) return { toolCalls: [{ tool: 'read', args: { path: 'missing-result-file.txt' } }] };
      if (step === 5) return { toolCalls: [{ tool: 'read', args: { path: 'refused-read.txt' } }] };
      return { text: 'read attempt completed' };
    },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('tool result byte metadata distinguishes 15,999 inline bytes from a 16,001-byte spill', { timeout: 20_000 }, async () => {
  let step = 0;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await writeFile(join(projectDirectory, 'inline-boundary.txt'), 'i'.repeat(15_988));
    await writeFile(join(projectDirectory, 'spill-boundary.txt'), 's'.repeat(15_990));
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'measure the two output byte boundaries' });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; args?: { path?: string } }[];
    };
    const calls = ['inline-boundary.txt', 'spill-boundary.txt'].map((path) => {
      const event = history.events.find((item) => item.kind === 'tool' && item.tool === 'read' && item.args?.path === path);
      assert.ok(typeof event?.callId === 'string' && typeof event.runId === 'string');
      return event;
    });
    const inline = await client.request('tool.result', {
      sessionId, runId: calls[0]!.runId, callId: calls[0]!.callId, limitBytes: 4_096,
    }) as { output: Record<string, unknown> };
    const spill = await client.request('tool.result', {
      sessionId, runId: calls[1]!.runId, callId: calls[1]!.callId, limitBytes: 4_096,
    }) as { output: Record<string, unknown> };
    assert.equal(inline.output.returnedValueBytes, 15_999);
    assert.equal(inline.output.storageStatus, 'inline');
    assert.equal(inline.output.storedBytes, 15_999);
    assert.equal(inline.output.modelVisibleBytes, 15_999);
    assert.equal(spill.output.returnedValueBytes, 16_001);
    assert.equal(spill.output.storageStatus, 'spill');
    assert.equal(spill.output.storedBytes, 16_001);
    assert.equal(spill.output.storedComplete, true);
  }, {
    providerReply: () => {
      step += 1;
      if (step === 1) return { toolCalls: [{ tool: 'read', args: { path: 'inline-boundary.txt' } }] };
      if (step === 2) return { toolCalls: [{ tool: 'read', args: { path: 'spill-boundary.txt' } }] };
      return { text: 'byte thresholds checked' };
    },
    config: { limits: { resultBytes: 16_000 }, loop: { iterations: 4, modelCalls: 4 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a reopened Host reports an interrupted checked call as unknown without replaying it', { timeout: 20_000 }, async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionDirectory }) => {
    const sessionId = 'interrupted-check-session';
    const session = createSessionLog({ directory: sessionDirectory, id: sessionId, meta: { projectRoot: projectDirectory } });
    const acceptance = createRunAcceptance(sessionId, 'start a checked command before Host interruption', undefined, 'human');
    const callId = 'call-interrupted-check';
    const executionId = randomUUID();
    const declaration = { name: 'interrupted check', purpose: 'verify recovery without replay', expectedExitCodes: [0],
      scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } };
    const sample = { path: 'scope.txt', status: 'available', exists: true, version: 'a'.repeat(16), sampledAt: new Date().toISOString() };
    await writeFile(join(projectDirectory, 'scope.txt'), 'scope');
    await session.append({ kind: 'user', text: 'start a checked command before Host interruption', run: acceptance });
    await session.append({ kind: 'assistant', text: '', toolCalls: [{ id: callId, name: 'exec', args: {
      command: 'node long-command.mjs', waitMs: 30_000, check: declaration,
    } }] });
    await session.append({ kind: 'toolActivity', ignorable: true, sessionId, runId: acceptance.runId,
      callId, tool: 'exec', phase: 'started', at: new Date().toISOString() });
    const identity = { ignorable: true, executionId, cursorGeneration: randomUUID(), projectIdentity: workspaceIdentity(projectDirectory),
      sessionId, runId: acceptance.runId, callId, timeoutMs: 120_000, logTotalBytes: 0, logFirstAvailableOffset: 0,
      cancelRequested: false, deadlineExceeded: false, terminationPending: false, cleanupPending: false,
      check: declaration, checkScopeStart: [sample] };
    await session.append({ kind: 'execution', state: 'accepted', acceptedAt: new Date().toISOString(), ...identity });
    await session.append({ kind: 'execution', state: 'started', startedAt: new Date().toISOString(), ...identity });
    await session.close();

    await client.request('session.open', { sessionId, projectRoot: projectDirectory });
    const reopened = await client.request('session.read', { sessionId }) as { events: { kind?: string; run?: Record<string, unknown> }[] };
    assert.equal(reopened.events.find((event) => event.kind === 'user')?.run?.runId, acceptance.runId, JSON.stringify(reopened.events));
    const result = await client.request('tool.result', { sessionId, runId: acceptance.runId, callId, limitBytes: 1_024 }) as Record<string, unknown>;
    assert.equal(result.state, 'unknown');
    assert.equal((result.result as Record<string, unknown>).code, 'tool_outcome_unknown');
    assert.equal((result.execution as Record<string, unknown>).state, 'unknown');
    assert.equal((result.execution as Record<string, unknown>).errorCode, 'execution_result_unknown');
    assert.equal((result.check as Record<string, unknown>).status, 'unknown');
    const history = await client.request('session.read', { sessionId }) as { events: { kind?: string; callId?: string }[] };
    assert.equal(history.events.filter((event) => event.kind === 'tool' && event.callId === callId).length, 1,
      'recovery writes one unknown-result fact and never restarts the command');
    await client.request('session.close', { sessionId });
  }, { permissionControl: true, testDirectory: join(process.cwd(), 'testplace', 'tmp') });
});
