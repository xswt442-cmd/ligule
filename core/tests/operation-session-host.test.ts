import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { createSessionLog } from '../dist/session/session.js';
import { withTuiHost } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

test('a manual command has an independent non-model Session and uses the Host execution owner', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 25_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests }) => {
    const script = join(projectDirectory, 'operation-probe.mjs');
    await writeFile(script, [
      "import { setTimeout as delay } from 'node:timers/promises';",
      "process.stdout.write('operation-stdout-start\\n');",
      "process.stderr.write('operation-stderr-start\\n');",
      'await delay(1_500);',
      "process.stdout.write('operation-stdout-end\\n');",
      "process.stderr.write('operation-stderr-end\\n');",
      'process.exitCode = 7;',
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    const approvalRequests: Record<string, unknown>[] = [];
    client.onRequest((request) => {
      if (request.method !== 'approval.request' || typeof request.params !== 'object' || request.params === null) {
        throw new Error('unexpected_host_request');
      }
      approvalRequests.push(request.params as Record<string, unknown>);
      return { decision: 'allow' };
    });
    const sourcePath = join(sessionDirectory, `${sessionId}.jsonl`);
    const sourceBefore = await readFile(sourcePath);
    const providerRequestsBefore = providerRequests.length;

    const started = await client.request('operation.start', {
      sessionId, command: 'node operation-probe.mjs', cwd: '.',
    }) as { operationSessionId: string; operationId: string; executionId: string };
    assert.ok(started.operationSessionId);
    assert.ok(started.operationId);
    assert.ok(started.executionId);
    const operationStatus = await client.request('status.get', { sessionId: started.operationSessionId }) as {
      operation?: { operationId?: string; sourceSessionId?: string; finished?: boolean } | null;
    };
    assert.deepEqual(operationStatus.operation, {
      operationId: started.operationId, sourceSessionId: sessionId, finished: false,
    });
    assert.equal(approvalRequests.length, 1, 'the script command must use the existing approval flow');
    assert.equal(approvalRequests[0]?.sessionId, started.operationSessionId,
      'the approval remains owned by the Operation Session');
    assert.equal(approvalRequests[0]?.sourceSessionId, sessionId,
      'the source Session is included for display and navigation only');
    assert.equal(providerRequests.length, providerRequestsBefore, 'the operation must not request an Agent or Reviewer response');

    const sourceAfter = await readFile(sourcePath);
    assert.deepEqual(sourceAfter, sourceBefore, 'manual execution must not write through the source Session');
    assert.equal(providerRequests.length, providerRequestsBefore, 'manual execution must not request an Agent response');

    const operation = await client.request('session.read', { sessionId: started.operationSessionId, fullResults: true }) as {
      events: { kind?: string; operationId?: string; sourceSessionId?: string; tool?: string; runId?: string;
        executionId?: string; result?: { content?: unknown } }[];
    };
    assert.equal(operation.events.find(event => event.kind === 'operationStarted')?.sourceSessionId, sessionId);
    assert.equal(operation.events.find(event => event.kind === 'operationStarted')?.operationId, started.operationId);
    assert.equal(operation.events.some(event => event.kind === 'user' || event.kind === 'assistant'), false,
      'an Operation Session is not a model conversation');
    const execEvent = operation.events.find(event => event.kind === 'tool' && event.tool === 'exec');
    assert.ok(execEvent, 'the Operation Session records the real exec call');
    assert.equal(execEvent.runId, started.operationId);
    assert.equal(JSON.stringify(execEvent.result).includes(started.executionId), true,
      'the real exec result contains the finite-command identity');

    const operationLog = createSessionLog({ directory: sessionDirectory, id: started.operationSessionId });
    assert.deepEqual(await operationLog.modelView(), [], 'manual exec results must not become model context');
    await assert.rejects(client.request('run.start', {
      sessionId: started.operationSessionId, input: 'do not turn an Operation Session into an Agent Run',
    }), { code: 'operation_session_model_run_unavailable' });
    await assert.rejects(client.request('run.submit', {
      sessionId: started.operationSessionId, input: 'do not submit an Agent turn to an Operation Session',
    }), { code: 'operation_session_model_run_unavailable' });
    await assert.rejects(client.request('execution.status', {
      sessionId, runId: started.operationId, executionId: started.executionId,
    }), { code: 'run_not_found' });
    assert.equal(providerRequests.length, providerRequestsBefore);

    const timeout = await client.request('execution.wait', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, waitMs: 25,
    }) as { waitTimedOut?: boolean };
    assert.equal(timeout.waitTimedOut, true);
    const stillRunning = await client.request('execution.status', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId,
    }) as { state?: string };
    assert.equal(stillRunning.state, 'running', 'a wait timeout must not cancel the operation');

    const settled = await client.request('execution.wait', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, waitMs: 5_000,
    }) as { state?: string; exitCode?: number; waitTimedOut?: boolean; cleanupPending?: boolean; terminationPending?: boolean };
    assert.equal(settled.state, 'exited');
    assert.equal(settled.exitCode, 7);
    assert.equal(settled.waitTimedOut, false);
    assert.equal(settled.cleanupPending, false);
    assert.equal(settled.terminationPending, false);
    const finishedOperation = await client.request('session.read', { sessionId: started.operationSessionId }) as {
      events: { kind?: string; state?: string; exitCode?: number }[];
    };
    assert.equal(finishedOperation.events.some(event => event.kind === 'operationFinished'
      && event.state === 'exited' && event.exitCode === 7), true);
    const logs = await client.request('execution.logs', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, limitBytes: 4096,
    });
    assert.match(JSON.stringify(logs), /operation-stdout-start/);
    assert.match(JSON.stringify(logs), /operation-stderr-start/);
    assert.match(JSON.stringify(logs), /operation-stdout-end/);
    assert.match(JSON.stringify(logs), /operation-stderr-end/);
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a manual command can be cancelled through its own Operation Session', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 25_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await writeFile(join(projectDirectory, 'operation-sleep.mjs'), [
      "process.stdout.write('operation-sleep-started\\n');",
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    client.onRequest((request) => request.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const started = await client.request('operation.start', {
      sessionId, command: 'node operation-sleep.mjs', cwd: '.',
    }) as { operationSessionId: string; operationId: string; executionId: string };

    const mismatched = await client.request('operation.start', {
      sessionId, command: 'node operation-sleep.mjs', cwd: '.',
    }) as { operationSessionId: string; operationId: string; executionId: string };
    await assert.rejects(client.request('execution.status', {
      sessionId: mismatched.operationSessionId, runId: started.operationId, executionId: started.executionId,
    }), { code: 'run_not_found' });
    const mismatchedCancelled = await client.request('execution.cancel', {
      sessionId: mismatched.operationSessionId, runId: mismatched.operationId, executionId: mismatched.executionId,
    }) as { state?: string; cleanupPending?: boolean; terminationPending?: boolean };
    assert.equal(mismatchedCancelled.state, 'cancelled');
    assert.equal(mismatchedCancelled.cleanupPending, false);
    assert.equal(mismatchedCancelled.terminationPending, false);

    const cancelled = await client.request('execution.cancel', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId,
    }) as { state?: string; cleanupPending?: boolean; terminationPending?: boolean };
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cleanupPending, false);
    assert.equal(cancelled.terminationPending, false);
    const operation = await client.request('session.read', { sessionId: started.operationSessionId }) as {
      events: { kind?: string; state?: string }[];
    };
    assert.equal(operation.events.some(event => event.kind === 'operationFinished' && event.state === 'cancelled'), true);
    assert.equal(providerRequests.length, 0);
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('lowering source Permission cancels its active manual command', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 25_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    await writeFile(join(projectDirectory, 'operation-sleep.mjs'), [
      "process.stdout.write('operation-sleep-started\\n');",
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    client.onRequest((request) => request.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const started = await client.request('operation.start', {
      sessionId, command: 'node operation-sleep.mjs', cwd: '.',
    }) as { operationSessionId: string; operationId: string; executionId: string };

    const changed = await client.request('permission.set', { sessionId, permissionProfile: 'read-only' }) as {
      permission?: { profile?: string };
    };
    assert.equal(changed.permission?.profile, 'read-only');
    const settled = await client.request('execution.wait', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, waitMs: 5_000,
    }) as { state?: string; cleanupPending?: boolean; terminationPending?: boolean };
    assert.equal(settled.state, 'cancelled');
    assert.equal(settled.cleanupPending, false);
    assert.equal(settled.terminationPending, false);
    const operation = await client.request('session.read', { sessionId: started.operationSessionId }) as {
      events: { kind?: string; state?: string; errorCode?: string }[];
    };
    assert.equal(operation.events.some(event => event.kind === 'operationFinished' && event.state === 'cancelled'), true);
    assert.equal(providerRequests.length, 0);
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('an Operation Session restores its terminal command without rerunning it', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 25_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests, restart }) => {
    await writeFile(join(projectDirectory, 'operation-restart-probe.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "appendFileSync('operation-run-count.txt', 'x');",
      "process.stdout.write('operation-restart-output\\n');",
      'await delay(300);',
      'process.exitCode = 7;',
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    client.onRequest((request) => request.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const started = await client.request('operation.start', {
      sessionId, command: 'node operation-restart-probe.mjs', cwd: '.',
    }) as { operationSessionId: string; operationId: string; executionId: string };
    const completed = await client.request('execution.wait', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, waitMs: 5_000,
    }) as { state?: string; exitCode?: number };
    assert.equal(completed.state, 'exited');
    assert.equal(completed.exitCode, 7);

    const reopenedClient = await restart();
    await reopenedClient.request('session.open', { projectRoot: projectDirectory, sessionId: started.operationSessionId });
    const operationStatus = await reopenedClient.request('status.get', { sessionId: started.operationSessionId }) as {
      operation?: { operationId?: string; sourceSessionId?: string; finished?: boolean } | null;
    };
    assert.deepEqual(operationStatus.operation, {
      operationId: started.operationId, sourceSessionId: sessionId, finished: true,
    });
    const restoredStatus = await reopenedClient.request('execution.status', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId,
    }) as { state?: string; exitCode?: number; logAvailable?: boolean };
    assert.equal(restoredStatus.state, 'exited');
    assert.equal(restoredStatus.exitCode, 7);
    assert.equal(restoredStatus.logAvailable, true);
    const restoredLogs = await reopenedClient.request('execution.logs', {
      sessionId: started.operationSessionId, runId: started.operationId, executionId: started.executionId, limitBytes: 4096,
    });
    assert.match(JSON.stringify(restoredLogs), /operation-restart-output/);
    const operationLog = createSessionLog({ directory: sessionDirectory, id: started.operationSessionId });
    assert.deepEqual(await operationLog.modelView(), []);
    assert.equal((await readFile(join(projectDirectory, 'operation-run-count.txt'), 'utf8')), 'x');
    assert.equal(providerRequests.length, 0);
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a command operation can only start on a trusted UI connection', {
  timeout: 10_000,
}, async () => {
  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    await assert.rejects(client.request('operation.start', { sessionId, command: 'node --version' }), {
      code: 'operation_run_trusted_ui_required',
    });
    assert.equal(providerRequests.length, 0);
  }, { modeName: 'full', testDirectory: join(process.cwd(), 'testplace', 'tmp') });
});
