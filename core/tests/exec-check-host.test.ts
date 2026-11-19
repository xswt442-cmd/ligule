import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { measuredPermissionContext, waitFor, withTuiHost } from './helpers/tui-host.ts';

test('a declared finite check binds its exit, structured report, and scoped file samples to one execution', {
  timeout: 30_000,
}, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'scope.txt'), 'stable scope\n');
    const report = { schema: 'ligule-test-report', version: 1, passed: 2, failed: 0, skipped: 1, todo: 0 };
    const source = `process.stdout.write('LIGULE_TEST_REPORT_V1\\t${JSON.stringify(report)}\\n');\n`;
    const scriptPath = join(projectDirectory, 'emit-report.mjs');
    await writeFile(scriptPath, source);
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: JSON.stringify({
      tool: 'exec', args: {
        command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 30_000,
        check: {
          name: 'focused test', purpose: 'verify the requested file behavior', expectedExitCodes: [0],
          scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' },
        },
      },
    }) });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; runId?: string; callId?: string; executionId?: string;
        state?: string; exitCode?: number; sessionId?: string; commandStatus?: string; reportStatus?: string;
        report?: { schema: string; version: number; passed: number; failed: number; skipped: number; todo: number };
        scopeStatus?: string; stdout?: unknown }[];
    };
    const command = history.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
    assert.ok(typeof command?.runId === 'string' && typeof command.callId === 'string', JSON.stringify(history.events));
    const execution = history.events.filter((event) => event.kind === 'execution' && event.callId === command.callId).at(-1);
    assert.ok(typeof execution?.executionId === 'string');
    const check = history.events.find((event) => event.kind === 'check' && event.executionId === execution.executionId);
    assert.ok(check, JSON.stringify(history.events));
    assert.equal(check.sessionId, sessionId);
    assert.equal(check.runId, command.runId);
    assert.equal(check.callId, command.callId);
    assert.equal(check.commandStatus, 'met');
    assert.equal(check.exitCode, 0);
    assert.equal(check.reportStatus, 'reported_pass');
    assert.deepEqual(check.report, { schema: 'ligule-test-report', version: 1, passed: 2, failed: 0, skipped: 1, todo: 0 });
    assert.equal(check.scopeStatus, 'sampled');
    assert.equal(Object.hasOwn(check, 'stdout'), false, 'check facts reference finite logs and do not duplicate stdout');
    // 检查事件自己携带命令起止时刻与日志引用，读取方不必再去拼另一条 execution 记录。
    const checkFields = check as Record<string, unknown>;
    assert.match(String(checkFields.startedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(String(checkFields.endedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(Date.parse(String(checkFields.endedAt)) >= Date.parse(String(checkFields.startedAt)));
    const logsRef = checkFields.logsRef as { name?: string; bytes?: number; sha256?: string } | undefined;
    assert.ok(logsRef !== undefined, 'the check carries a reference to its own execution log');
    assert.match(String(logsRef.name), /^execution-[0-9a-f-]{36}\.log\.json$/u);
    assert.ok(Number.isSafeInteger(logsRef.bytes) && Number(logsRef.bytes) >= 1);
    assert.match(String(logsRef.sha256), /^[a-f0-9]{64}$/u);
    const result = await client.request('tool.result', {
      sessionId, runId: command.runId, callId: command.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal((result.check as Record<string, unknown>).reportStatus, 'reported_pass');
    assert.equal((result.check as Record<string, unknown>).startedAt, checkFields.startedAt);
    assert.equal((result.check as Record<string, unknown>).endedAt, checkFields.endedAt);
    assert.deepEqual((result.check as Record<string, unknown>).logsRef, logsRef);
    const runPage = await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId: command.runId }) as { json: string };
    const runResult = JSON.parse(runPage.json) as { checks?: { name: string; reportStatus: string; startedAt?: string; endedAt?: string }[] };
    assert.equal(runResult.checks?.[0]?.name, 'focused test');
    assert.equal(runResult.checks?.[0]?.reportStatus, 'reported_pass');
    assert.equal(runResult.checks?.[0]?.startedAt, checkFields.startedAt);
    assert.equal(runResult.checks?.[0]?.endedAt, checkFields.endedAt);
  }, {
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 4, modelCalls: 4 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a later in-Run file edit makes a sampled check stale in RunResult without blocking an ordinary Run', {
  timeout: 30_000,
}, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  let step = 0;
  let scriptPath = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'scope.txt'), 'stable scope\n');
    const report = { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 };
    scriptPath = join(projectDirectory, 'emit-report.mjs');
    await writeFile(scriptPath, `process.stdout.write('LIGULE_TEST_REPORT_V1\\t${JSON.stringify(report)}\\n');\n`);
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'execute a check then edit one of its scoped files' });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; run?: { runId?: string } }[];
    };
    const runId = history.events.find((event) => event.kind === 'user')?.run?.runId;
    const result = await client.request('run.result', { projectRoot: projectDirectory, sessionId, runId }) as { json: string };
    const runResult = JSON.parse(result.json) as { state: string; checks?: { name: string; scopeStatus: string }[];
      fileChanges?: { path: string; operation: string; outcome: string }[] };
    assert.equal(runResult.state, 'completed', 'ordinary Runs still complete without a required check contract');
    assert.equal(runResult.checks?.[0]?.name, 'focused test');
    assert.equal(runResult.checks?.[0]?.scopeStatus, 'stale');
    assert.equal(runResult.fileChanges?.[0]?.path, 'scope.txt');
    assert.equal(runResult.fileChanges?.[0]?.operation, 'edit');
    assert.equal(await readFile(join(projectDirectory, 'scope.txt'), 'utf8'), 'changed scope\n');
    const execCall = history.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
    assert.ok(typeof execCall?.callId === 'string' && typeof execCall.runId === 'string');
    const projected = await client.request('tool.result', {
      sessionId, runId: execCall.runId, callId: execCall.callId, limitBytes: 1_024,
    }) as { check?: { scopeStatus?: string } };
    assert.equal(projected.check?.scopeStatus, 'stale',
      'the per-call projection and the Run summary must agree on the recomputed scope status');
  }, {
    providerReply: () => {
      step += 1;
      if (step === 1) return { toolCalls: [{ tool: 'exec', args: {
        command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 30_000,
        check: { name: 'focused test', purpose: 'check the scoped file', expectedExitCodes: [0],
          scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } },
      } }] };
      if (step === 2) return { toolCalls: [{ tool: 'edit', args: {
        path: 'scope.txt', changes: [{ oldText: 'stable scope', newText: 'changed scope' }],
      } }] };
      return { text: 'the Run completes, while its check reference is stale' };
    },
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 5, modelCalls: 5 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a Desktop save after a Run makes its scoped check stale without attributing the save to the Agent', {
  timeout: 30_000,
}, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const scopedPath = join(projectDirectory, 'scope.txt');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(scopedPath, 'before Desktop save\n');
    const report = { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 };
    const scriptPath = join(projectDirectory, 'emit-report.mjs');
    await writeFile(scriptPath, `process.stdout.write('LIGULE_TEST_REPORT_V1\\t${JSON.stringify(report)}\\n');\n`);
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
      command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 30_000,
      check: { name: 'desktop-edit scope', purpose: 'verify the scoped file', expectedExitCodes: [0],
        scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } },
    } }) });

    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; runId?: string; tool?: string; callId?: string; fileChanges?: unknown[] }[];
    };
    const call = history.events.find(event => event.kind === 'tool' && event.tool === 'exec');
    assert.ok(typeof call?.runId === 'string');
    const read = await client.request('project.file.read', { sessionId, path: 'scope.txt' }) as { version: string };
    await client.request('project.file.save', {
      sessionId, path: 'scope.txt', expectedVersion: read.version, text: 'after Desktop save\n',
    });

    const result = await client.request('run.result', {
      projectRoot: projectDirectory, sessionId, runId: call.runId,
    }) as { json: string };
    const runResult = JSON.parse(result.json) as {
      checks?: { name: string; scopeStatus: string }[];
      fileChanges?: { path: string; operation: string; outcome: string }[];
    };
    assert.equal(runResult.checks?.[0]?.name, 'desktop-edit scope');
    assert.equal(runResult.checks?.[0]?.scopeStatus, 'stale');
    assert.deepEqual(runResult.fileChanges ?? [], [], 'Desktop facts do not appear as Agent Run tool changes');
    assert.equal(await readFile(scopedPath, 'utf8'), 'after Desktop save\n');
  }, {
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 4, modelCalls: 4 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('check exit conditions and structured report statuses remain independent', { timeout: 45_000 }, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  const cases = [
    { name: 'report-failed', report: { schema: 'ligule-test-report', version: 1, passed: 2, failed: 1, skipped: 0, todo: 0 },
      expectedCommand: 'met', expectedReport: 'reported_fail', exitCode: 0, declarationReport: true },
    { name: 'zero-tests', report: { schema: 'ligule-test-report', version: 1, passed: 0, failed: 0, skipped: 0, todo: 0 },
      expectedCommand: 'met', expectedReport: 'zero_tests', exitCode: 0, declarationReport: true },
    { name: 'missing-report', report: undefined, expectedCommand: 'met', expectedReport: 'unverified', exitCode: 0, declarationReport: true },
    { name: 'unknown-report-version', report: { schema: 'ligule-test-report', version: 2, passed: 1, failed: 0, skipped: 0, todo: 0 },
      expectedCommand: 'met', expectedReport: 'unverified', exitCode: 0, declarationReport: true },
    { name: 'unexpected-exit', report: { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
      expectedCommand: 'not_met', expectedReport: 'reported_pass', exitCode: 2, declarationReport: true },
    { name: 'report-not-requested', report: undefined, expectedCommand: 'met', expectedReport: 'not_requested', exitCode: 0, declarationReport: false },
  ] as const;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'scope.txt'), 'unchanged scope\n');
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    for (const item of cases) {
      await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
        command: `node "${join(projectDirectory, `${item.name}.mjs`).replaceAll('\\', '/')}"`, waitMs: 30_000,
        check: {
          name: item.name, purpose: 'classify this command result', expectedExitCodes: [0], scope: ['scope.txt'],
          ...(item.declarationReport ? { report: { format: 'ligule-test-report-v1' } } : {}),
        },
      } }) });
      const history = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; tool?: string; callId?: string; runId?: string; executionId?: string;
          args?: Record<string, unknown>; state?: string; reportStatus?: string; commandStatus?: string; reportReason?: string;
          report?: Record<string, unknown> }[];
      };
      const call = history.events.find((event) => event.kind === 'tool' && event.tool === 'exec'
        && event.args !== undefined && (event.args.check as { name?: string } | undefined)?.name === item.name);
      assert.ok(typeof call?.callId === 'string' && typeof call.runId === 'string');
      const check = history.events.find((event) => event.kind === 'check' && event.callId === call.callId);
      assert.ok(check, JSON.stringify(history.events));
      assert.equal(check.commandStatus, item.expectedCommand, `${item.name}: exit status is separate from report`);
      assert.equal(check.reportStatus, item.expectedReport, `${item.name}: report status stays explicit`);
      if (item.name === 'report-failed') assert.deepEqual(check.report, item.report);
      if (item.name === 'unknown-report-version') assert.equal(check.reportReason, 'report_schema_unsupported');
      if (item.name === 'missing-report') assert.equal(check.reportReason, 'report_missing');
      const result = await client.request('tool.result', {
        sessionId, runId: call.runId, callId: call.callId, limitBytes: 1_024,
      }) as Record<string, unknown>;
      assert.equal((result.check as Record<string, unknown>).reportStatus, item.expectedReport);
    }
  }, {
    setup: async ({ projectDirectory }) => {
      for (const item of cases) {
        const reportLine = item.report === undefined ? '' : `process.stdout.write('LIGULE_TEST_REPORT_V1\\t${JSON.stringify(item.report)}\\n');\n`;
        await writeFile(join(projectDirectory, `${item.name}.mjs`), `${reportLine}process.exitCode = ${item.exitCode};\n`);
      }
    },
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a check declaration without a finite execution handle is reported not_run before spawning', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const scriptPath = join(projectDirectory, 'must-not-run.mjs');
    await writeFile(scriptPath, "require('node:fs').writeFileSync('must-not-exist.txt', 'ran');\n");
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
      command: `node "${scriptPath.replaceAll('\\', '/')}"`,
      check: { name: 'no finite handle', purpose: 'reject before starting', expectedExitCodes: [0], scope: ['scope.txt'] },
    } }) });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; args?: Record<string, unknown> }[];
    };
    const event = history.events.find((item) => item.kind === 'tool' && item.tool === 'exec');
    assert.ok(typeof event?.callId === 'string' && typeof event.runId === 'string');
    assert.equal(history.events.some((item) => item.kind === 'execution' && item.callId === event.callId), false);
    const result = await client.request('tool.result', {
      sessionId, runId: event.runId, callId: event.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal(result.state, 'failed');
    assert.equal((result.check as Record<string, unknown>).status, 'not_run');
    assert.equal((result.result as Record<string, unknown>).code, 'exec_check_requires_finite_execution');
    await assert.rejects(readFile(join(projectDirectory, 'must-not-exist.txt')));
  }, {
    permission: await measuredPermissionContext('full-access', 'unrestricted'),
    permissionControl: true,
    modeName: 'full',
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('format 4 Sessions stay readable but reject checks before starting a command', async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId, sessionDirectory, projectDirectory }) => {
    await client.request('session.close', { sessionId });
    const path = join(sessionDirectory, `${sessionId}.jsonl`);
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header.formatVersion = 4;
    lines[0] = JSON.stringify(header);
    await writeFile(path, `${lines.join('\n')}\n`);
    await client.request('session.open', { sessionId });
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
      command: 'node -e "process.exit(0)"', waitMs: 30_000,
      check: { name: 'old format', purpose: 'check schema compatibility', expectedExitCodes: [0], scope: ['scope.txt'] },
    } }) });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; callId?: string; runId?: string; result?: Record<string, unknown> }[];
    };
    const exec = history.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
    assert.ok(exec);
    assert.equal((exec.result as Record<string, unknown>).code, 'check_session_format_unsupported');
    assert.equal(history.events.some((event) => event.kind === 'execution' && event.callId === exec.callId), false);
    assert.equal(history.events.some((event) => event.kind === 'check'), false);
  }, {
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('a finite-command timeout is recorded separately from a valid structured report', {
  timeout: 25_000,
}, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'scope.txt'), 'stable\n');
    const report = { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 };
    const scriptPath = join(projectDirectory, 'timeout-after-report.mjs');
    const reportText = `LIGULE_TEST_REPORT_V1\t${JSON.stringify(report)}\n`;
    await writeFile(scriptPath, `import { writeSync } from 'node:fs';\nwriteSync(1, ${JSON.stringify(reportText)});\nsetTimeout(() => {}, 10000);\n`);
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
      command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 30_000,
      check: { name: 'timeout check', purpose: 'report process timeout separately', expectedExitCodes: [0],
        scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } },
    } }) });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; executionId?: string; errorCode?: string; executionState?: string; commandStatus?: string;
        reportStatus?: string; reportReason?: string; logStatus?: string; logTotalBytes?: number; report?: { failed: number } }[];
    };
    const check = history.events.find((event) => event.kind === 'check');
    assert.ok(check, JSON.stringify(history.events));
    assert.equal(check.executionState, 'failed');
    assert.equal(check.commandStatus, 'not_met');
    assert.equal(check.errorCode, 'exec_timeout');
    assert.equal(check.reportStatus, 'reported_pass', `the report and command terminal result stay separate: ${JSON.stringify(check)}`);
    assert.equal(check.report?.failed, 0);
  }, {
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { limits: { execTimeoutMs: 3_000 }, loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('cancelling a Run with an active finite check records the command as not_met', { timeout: 25_000 }, async (t) => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'scope.txt'), 'stable\n');
    const report = { schema: 'ligule-test-report', version: 1, passed: 1, failed: 0, skipped: 0, todo: 0 };
    const scriptPath = join(projectDirectory, 'long-check.mjs');
    await writeFile(scriptPath, `process.stdout.write('LIGULE_TEST_REPORT_V1\\t${JSON.stringify(report)}\\n');\nsetTimeout(() => {}, 10000);\n`);
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const started = await client.request('run.submit', { sessionId, input: JSON.stringify({ tool: 'exec', args: {
      command: `node "${scriptPath.replaceAll('\\', '/')}"`, waitMs: 0,
      check: { name: 'cancel check', purpose: 'exercise finite command cancellation', expectedExitCodes: [0],
        scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } },
    } }) }) as { runId: string };
    await waitFor(async () => {
      const page = await client.request('session.read', { sessionId }) as { events: { kind?: string; state?: string; runId?: string }[] };
      return page.events.some((event) => event.kind === 'execution' && event.runId === started.runId && event.state === 'started');
    }, { within: 10_000 });
    await client.request('run.cancel', { sessionId });
    await waitFor(async () => {
      const page = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; tool?: string; runId?: string; callId?: string; args?: Record<string, unknown>;
          executionState?: string; commandStatus?: string; errorCode?: string }[];
      };
      return page.events.some((event) => event.kind === 'check' && event.runId === started.runId);
    }, { within: 10_000 });
    const history = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; runId?: string; callId?: string; args?: Record<string, unknown>;
        executionState?: string; commandStatus?: string; errorCode?: string }[];
    };
    const check = history.events.find((event) => event.kind === 'check' && event.runId === started.runId);
    assert.ok(check);
    assert.equal(check.executionState, 'cancelled');
    assert.equal(check.commandStatus, 'not_met');
    assert.equal(typeof check.errorCode, 'string');
    const exec = history.events.find((event) => event.kind === 'tool' && event.tool === 'exec'
      && event.runId === started.runId && typeof event.args === 'object'
      && (event.args.check as { name?: string } | undefined)?.name === 'cancel check');
    assert.ok(exec?.callId);
    const toolResult = await client.request('tool.result', {
      sessionId, runId: started.runId, callId: exec.callId, limitBytes: 1_024,
    }) as Record<string, unknown>;
    assert.equal(toolResult.state, 'completed', 'the exec tool call returned its handle before its process was cancelled');
    assert.equal((toolResult.execution as Record<string, unknown>).state, 'cancelled');
    assert.equal((toolResult.check as Record<string, unknown>).commandStatus, 'not_met');
  }, {
    permission,
    permissionControl: true,
    modeName: 'full',
    config: { limits: { execTimeoutMs: 15_000 }, loop: { iterations: 3, modelCalls: 3 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});
