import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { createRunAcceptance } from '../dist/session/run.js';
import { createSessionLog } from '../dist/session/session.js';
import { workspaceIdentity } from '../dist/kernel/workspace.js';
import { withTuiHost, waitFor } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

type ChatBody = { messages: { role: string; content?: unknown }[] };

function lastToolContent(body: ChatBody): Record<string, unknown> | undefined {
  const message = [...body.messages].reverse().find((item) => item.role === 'tool');
  if (typeof message?.content !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    return typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content)
      ? value.content as Record<string, unknown> : value;
  } catch {
    return undefined;
  }
}

test('the command deadline terminates a real finite process tree and stays distinct from a wait timeout', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  let step = 0;
  let executionId: string | undefined;
  let commandPath = '';
  let completionPath = '';
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const scriptPath = join(projectDirectory, 'deadline-command.mjs');
    commandPath = scriptPath;
    completionPath = join(projectDirectory, 'must-not-finish.txt');
    await writeFile(scriptPath, [
      "import { spawn } from 'node:child_process';",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`const{writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(${JSON.stringify(completionPath)},'late'),5000);`)}], { stdio: 'ignore', windowsHide: true });`,
      'setTimeout(() => {}, 5_000);',
    ].join('\n'));
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    await client.request('run.start', { sessionId, input: 'start a command with a short execution deadline' });

    const { events } = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; result?: { failed?: boolean; content?: unknown } }[];
    };
    const tools = events.filter((event) => event.kind === 'tool' && (event.tool === 'exec' || event.tool === 'exec_control'));
    assert.equal(tools.length, 2, JSON.stringify(tools));
    const started = tools[0]?.result?.content as Record<string, unknown>;
    assert.equal(started.kind, 'execution');
    assert.equal(started.state, 'running');
    assert.equal(tools[0]?.result?.failed, false);
    const settled = tools[1]?.result?.content as Record<string, unknown>;
    assert.equal(settled.state, 'failed');
    assert.equal(settled.waitTimedOut, false, 'the command timeout fired before the longer wait window');
    assert.equal(settled.errorCode, 'exec_timeout');
    assert.equal(settled.deadlineExceeded, true);
    assert.equal(settled.terminationPending, false);
    assert.equal(settled.cleanupPending, false);
    assert.equal(executionId, started.executionId);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    assert.equal(existsSync(completionPath), false, 'the command process was terminated before its delayed side effect');
  }, {
    providerReply: (body) => {
      const previous = lastToolContent(body);
      if (step === 0) {
        step += 1;
        return { toolCalls: [{ tool: 'exec', args: {
          command: `node "${commandPath.replaceAll('\\', '/')}"`, waitMs: 0,
        } }] };
      }
      if (step === 1) {
        executionId = typeof previous?.executionId === 'string' ? previous.executionId : undefined;
        step += 1;
        return { toolCalls: [{ tool: 'exec_control', args: { action: 'wait', executionId, waitMs: 2_000 } }] };
      }
      return { text: 'deadline observed' };
    },
    permission: fullAccess,
    permissionControl: true,
    config: { limits: { contextTokens: 200_000, execTimeoutMs: 350 }, loop: { iterations: 8, modelCalls: 8 } },
    modeName: 'full',
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('Run completion waits for its active finite command before persisting completion', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  let commandPath = '';
  let completionPath = '';
  let step = 0;
  let runDurationMs = 0;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    commandPath = join(projectDirectory, 'completion-candidate-command.mjs');
    completionPath = join(projectDirectory, 'completion-candidate-finished.txt');
    await writeFile(commandPath, [
      "import { writeFileSync } from 'node:fs';",
      `setTimeout(() => writeFileSync(${JSON.stringify(completionPath)}, 'finished'), 750);`,
      'setTimeout(() => process.exit(0), 1_000);',
    ].join('\n'));
    await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const startedAt = Date.now();
    await client.request('run.start', { sessionId, input: 'start a command then finish the Run' });
    runDurationMs = Date.now() - startedAt;

    const { events } = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; executionId?: string; state?: string; result?: { content?: Record<string, unknown> } }[];
    };
    const tool = events.find((event) => event.kind === 'tool' && event.tool === 'exec');
    const executionId = tool?.result?.content?.executionId;
    assert.equal(typeof executionId, 'string');
    assert.ok(runDurationMs >= 700, `Run returned before its owned command settled (${runDurationMs} ms)`);
    assert.equal(existsSync(completionPath), true, 'the command side effect completed before the Run returned');
    const terminal = events.findLast((event) => event.kind === 'execution' && event.executionId === executionId);
    assert.equal(terminal?.state, 'exited', JSON.stringify(terminal));
  }, {
    providerReply: () => {
      if (step++ === 0) return { toolCalls: [{ tool: 'exec', args: {
        command: `node "${commandPath.replaceAll('\\', '/')}"`, waitMs: 0,
      } }] };
      return { text: 'the Run may finish after the command settles' };
    },
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

test('background command work keeps TaskBudget active while a real user question waits', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  let step = 0;
  let releaseQuestion!: (value: unknown) => void;
  let markQuestion!: () => void;
  const questionPending = new Promise<void>((resolve) => { markQuestion = resolve; });
  const heldQuestion = new Promise<unknown>((resolve) => { releaseQuestion = resolve; });
  let executionId: string | undefined;
  let completionPath = '';
  let commandPath = '';
  let questionWasAsked = false;
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      commandPath = join(projectDirectory, 'budget-command.mjs');
      completionPath = join(projectDirectory, 'budget-command-finished.txt');
      await writeFile(commandPath, [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`const{writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(${JSON.stringify(completionPath)},'late'),5000);`)}], { stdio: 'ignore', windowsHide: true });`,
        'setTimeout(() => {}, 5_000);',
      ].join('\n'));
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
      client.onRequest((message) => {
        if (message.method === 'question.request') {
          questionWasAsked = true;
          markQuestion();
          return heldQuestion;
        }
        return message.method === 'approval.request' ? { decision: 'allow' } : undefined;
      });

      const run = client.request('run.start', { sessionId, input: 'start a command then ask one question' });
      await waitFor(() => questionWasAsked, { within: 5_000, read: () => `run step ${step}` });
      await questionPending;
      const paused = await client.request('status.get', { sessionId }) as { task?: { executionElapsedMs: number; executionPaused: boolean } };
      assert.equal(paused.task?.executionPaused, false, 'the owned command continues counting while the question waits');
      const before = paused.task?.executionElapsedMs ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const later = await client.request('status.get', { sessionId }) as { task?: { executionElapsedMs: number; executionPaused: boolean } };
      assert.equal(later.task?.executionPaused, false);
      assert.ok((later.task?.executionElapsedMs ?? 0) > before, 'active command work advances the shared execution budget');

      releaseQuestion({ answers: [{ id: 'q1', selected: ['continue'] }] });
      await run;
      const { events } = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; tool?: string; executionId?: string; cancelRequested?: boolean; state?: string;
          terminationPending?: boolean; cleanupPending?: boolean; result?: { content?: unknown } }[];
      };
      const execution = events.find((event) => event.kind === 'tool' && event.tool === 'exec')?.result?.content as Record<string, unknown>;
      assert.equal(typeof execution.executionId, 'string');
      assert.equal(execution.state, 'running');
      executionId = execution.executionId as string;
      const terminal = events.findLast((event) => event.kind === 'execution' && event.executionId === executionId);
      assert.equal(terminal?.state, 'cancelled', JSON.stringify(terminal));
      assert.equal(terminal?.cancelRequested, true);
      assert.equal(terminal?.terminationPending, false);
      assert.equal(terminal?.cleanupPending, false);
      assert.equal(existsSync(completionPath), false, 'cancellation stops the command before its delayed side effect');
    }, {
      providerReply: (body) => {
        const previous = lastToolContent(body);
        if (step === 0) {
          step += 1;
          return { toolCalls: [{ tool: 'exec', args: { command: `node "${commandPath.replaceAll('\\', '/')}"`, waitMs: 0 } }] };
        }
        if (step === 1) {
          executionId = typeof previous?.executionId === 'string' ? previous.executionId : undefined;
          step += 1;
          return { toolCalls: [{ tool: 'ask_user_question', args: { questions: JSON.stringify([
            { question: 'May I continue?', options: [{ label: 'Continue' }], multiSelect: false },
          ]) } }] };
        }
        if (step === 2) {
          step += 1;
          return { toolCalls: [{ tool: 'exec_control', args: { action: 'cancel', executionId } }] };
        }
        return { text: 'budget status checked' };
      },
      permission: fullAccess,
      permissionControl: true,
      interactive: true,
      config: { limits: { contextTokens: 200_000, execTimeoutMs: 10_000 }, loop: { iterations: 8, modelCalls: 8 } },
      modeName: 'full',
      testDirectory: join(process.cwd(), 'testplace', 'tmp'),
    });
  } finally {
    releaseQuestion({ answers: [{ id: 'q1', selected: ['continue'] }] });
  }
});

test('an accepted command with no terminal event stays unknown after Host restart', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 20_000,
}, async () => {
  await withTuiHost(async ({ client, projectDirectory, sessionDirectory }) => {
    const sessionId = 'interrupted-execution-session';
    const executionId = randomUUID();
    const input = 'an interrupted Host command';
    const run = createRunAcceptance(sessionId, input, null, 'human');
    const session = createSessionLog({ directory: sessionDirectory, id: sessionId,
      meta: { projectRoot: projectDirectory, workspace: workspaceIdentity(projectDirectory) } });
    await session.append({ kind: 'user', text: input, run });
    const common = {
      ignorable: true,
      executionId,
      cursorGeneration: randomUUID(),
      projectIdentity: workspaceIdentity(projectDirectory),
      sessionId,
      runId: run.runId,
      callId: randomUUID(),
      timeoutMs: 120_000,
      cancelRequested: false,
      deadlineExceeded: false,
      terminationPending: false,
      cleanupPending: false,
      logTotalBytes: 0,
      logFirstAvailableOffset: 0,
    };
    await session.append({ kind: 'execution', state: 'accepted', acceptedAt: new Date().toISOString(), ...common });
    await session.append({ kind: 'execution', state: 'started', startedAt: new Date().toISOString(), ...common });
    await session.close();

    await client.request('session.open', { projectRoot: projectDirectory, sessionId });
    const status = await client.request('execution.status', { sessionId, runId: run.runId, executionId }) as Record<string, unknown>;
    assert.equal(status.state, 'unknown');
    assert.equal(status.errorCode, 'execution_result_unknown');
    assert.equal(status.terminationPending, true);
    assert.equal(status.cleanupPending, true);
    assert.equal(status.cancelRequested, false, 'recovery does not issue a PID-based cancellation');
    const logs = await client.request('execution.logs', { sessionId, runId: run.runId, executionId }) as Record<string, unknown>;
    assert.equal(logs.available, false);
    assert.equal(logs.unavailableReason, 'host_interrupted');
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});
