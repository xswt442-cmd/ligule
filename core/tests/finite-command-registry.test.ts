import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createFiniteCommandRegistry } from '../dist/capability/finite-command.js';
import { writeExecutionLog } from '../dist/session/execution-log.js';
import { parseSessionEvents } from '../dist/session/format.js';

const mebibyte = 1024 * 1024;

function executionEvent({
  executionId,
  sessionId,
  runId,
  projectIdentity,
  logsRef,
  seq,
}: {
  executionId: string;
  sessionId: string;
  runId: string;
  projectIdentity: string;
  seq: number;
  logsRef?: { name: string; bytes: number; sha256: string };
}): Record<string, unknown> {
  return {
    seq, kind: 'execution', ignorable: true, state: 'exited', executionId,
    cursorGeneration: randomUUID(), projectIdentity, sessionId, runId, callId: randomUUID(),
    startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
    timeoutMs: 120_000, exitCode: 0, cancelRequested: false, deadlineExceeded: false,
    terminationPending: false, cleanupPending: false, logTotalBytes: logsRef === undefined ? 1 : 256 * 1024, logFirstAvailableOffset: 0,
    ...(logsRef === undefined ? {} : { logsRef }),
  };
}

function logSnapshot(text = 'output') {
  const data = Buffer.from(text, 'utf8');
  return { totalBytes: data.length, firstAvailableOffset: 0,
    chunks: [{ sequence: 0, stream: 'stdout' as const, offset: 0, data }] };
}

async function finishCommand(registry: ReturnType<typeof createFiniteCommandRegistry>, directory: string,
  events: Record<string, unknown>[], owner: { projectIdentity: string; projectRoot: string; sessionId: string; runId: string; callId: string; workspaceTrusted: boolean }) {
  const session = { directory, append: async (event: Record<string, unknown>) => { events.push(event); return undefined; } };
  const reservation = await registry.reserve({ owner, session, timeoutMs: 60_000 });
  await registry.attach(reservation, {
    completion: Promise.resolve(0),
    logs: () => 'output',
    readLogs: () => logSnapshot(),
    stop: async () => {},
  }, undefined, 0);
  await registry.wait(owner, reservation.executionId, 1_000);
  return reservation.executionId;
}

test('concurrent Session opens wait for the same execution-log quota scan', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-quota-scan-'));
  const registry = createFiniteCommandRegistry();
  try {
    let firstScanFinished = false;
    const first = registry.accountDirectory(directory).finally(() => { firstScanFinished = true; });
    await registry.accountDirectory(directory);
    assert.equal(firstScanFinished, true,
      'the second opener must not pass the quota gate while the first directory scan is still running');
    await first;
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Run, Session, and Host active-command limits reject before reserving excess work', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-active-limits-'));
  const registry = createFiniteCommandRegistry();
  const events: Record<string, unknown>[] = [];
  const session = { directory, append: async (event: Record<string, unknown>) => { events.push(event); return undefined; } };
  const reservations: { executionId: string }[] = [];
  const owner = (sessionId: string, runId: string) => ({
    projectIdentity: '/project', projectRoot: '/project', sessionId, runId, callId: randomUUID(), workspaceTrusted: false,
  });
  const reserveMany = async (sessionId: string, runId: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      reservations.push(await registry.reserve({ owner: owner(sessionId, runId), session, timeoutMs: 60_000 }));
    }
  };
  try {
    await reserveMany('session-1', 'run-a', 4);
    await assert.rejects(registry.reserve({ owner: owner('session-1', 'run-a'), session, timeoutMs: 60_000 }),
      { code: 'execution_run_limit' });
    await reserveMany('session-1', 'run-b', 4);
    await assert.rejects(registry.reserve({ owner: owner('session-1', 'run-c'), session, timeoutMs: 60_000 }),
      { code: 'execution_session_limit' });
    for (let sessionIndex = 2; sessionIndex <= 4; sessionIndex += 1) {
      await reserveMany(`session-${sessionIndex}`, 'run-a', 4);
      await reserveMany(`session-${sessionIndex}`, 'run-b', 4);
    }
    assert.equal(reservations.length, 32);
    await assert.rejects(registry.reserve({ owner: owner('session-5', 'run-a'), session, timeoutMs: 60_000 }),
      { code: 'execution_host_limit' });
    assert.equal(events.filter((event) => event.kind === 'execution' && event.state === 'accepted').length, 32,
      'rejected reservations must not be persisted as accepted work');
  } finally {
    await Promise.all(reservations.map((reservation) => registry.failReservation(reservation, new Error('test cleanup'))));
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('finite commands cap simultaneous waiters without cancelling their command', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-waiter-limit-'));
  const registry = createFiniteCommandRegistry();
  const owner = { projectIdentity: '/project', projectRoot: '/project', sessionId: randomUUID(),
    runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false };
  try {
    let complete!: (exitCode: number) => void;
    const completion = new Promise<number>((resolveCompletion) => { complete = resolveCompletion; });
    const reservation = await registry.reserve({ owner, session: { directory, append: async () => undefined }, timeoutMs: 60_000 });
    await registry.attach(reservation, { completion, logs: () => '', readLogs: () => ({
      totalBytes: 0, firstAvailableOffset: 0, chunks: [],
    }), stop: async () => {} }, undefined, 0);

    const first = registry.wait(owner, reservation.executionId, 30_000);
    const second = registry.wait(owner, reservation.executionId, 30_000);
    await assert.rejects(registry.wait(owner, reservation.executionId, 30_000), { code: 'execution_waiter_limit' });
    assert.equal(registry.status(owner, reservation.executionId).state, 'running');
    complete(0);
    await Promise.all([first, second]);
    assert.equal(registry.status(owner, reservation.executionId).state, 'exited');
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a successful cleanup retry clears and persists the earlier pending state', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-cleanup-retry-'));
  const registry = createFiniteCommandRegistry();
  const events: Record<string, unknown>[] = [];
  const owner = { projectIdentity: '/project', projectRoot: '/project', sessionId: randomUUID(),
    runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false };
  const session = { directory, append: async (event: Record<string, unknown>) => { events.push(event); return undefined; } };
  try {
    const cleanupFailure = Object.assign(new Error('temporary cleanup did not finish'), { code: 'exec_temp_cleanup_failed' });
    const completion = Promise.reject<number>(cleanupFailure);
    void completion.catch(() => undefined);
    let stopAttempts = 0;
    const reservation = await registry.reserve({ owner, session, timeoutMs: 60_000 });
    await registry.attach(reservation, { completion, logs: () => '', readLogs: () => ({
      totalBytes: 0, firstAvailableOffset: 0, chunks: [],
    }), stop: async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw cleanupFailure;
    } }, undefined, 0);
    await registry.wait(owner, reservation.executionId, 1_000);
    const first = registry.status(owner, reservation.executionId);
    assert.equal(first.state, 'failed');
    assert.equal(first.cleanupPending, true);

    await registry.cancel(owner, reservation.executionId);
    assert.equal(registry.status(owner, reservation.executionId).cleanupPending, true);
    await registry.cancel(owner, reservation.executionId);

    const recovered = registry.status(owner, reservation.executionId);
    assert.equal(stopAttempts, 2);
    assert.equal(recovered.state, 'failed', 'the original execution failure remains visible after cleanup succeeds');
    assert.equal(recovered.cleanupPending, false);
    assert.equal(recovered.terminationPending, false);
    const terminal = events.findLast((event) => event.kind === 'execution' && event.executionId === reservation.executionId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.cleanupPending, false, 'the successful retry must be durable for Host recovery');
  } finally {
    await registry.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('execution log cursors cannot be replayed against another finite command', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-cursor-scope-'));
  const registry = createFiniteCommandRegistry();
  const events: Record<string, unknown>[] = [];
  const owner = {
    projectIdentity: '/project', projectRoot: '/project', sessionId: randomUUID(),
    runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false,
  };
  try {
    const first = await finishCommand(registry, directory, events, owner);
    const second = await finishCommand(registry, directory, events, { ...owner, callId: randomUUID() });
    const page = registry.logs(owner, first, undefined, 1);
    assert.equal(typeof page.nextCursor, 'string');
    assert.throws(() => registry.logs(owner, second, page.nextCursor as string), { code: 'execution_cursor_invalid' });
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('completion candidates close Run admission and wait for existing finite commands', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-completion-candidate-'));
  const registry = createFiniteCommandRegistry();
  const events: Record<string, unknown>[] = [];
  const owner = { projectIdentity: '/project', projectRoot: '/project', sessionId: randomUUID(),
    runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false };
  const session = { directory, append: async (event: Record<string, unknown>) => { events.push(event); return undefined; } };
  try {
    let complete!: (exitCode: number) => void;
    const completion = new Promise<number>((resolveCompletion) => { complete = resolveCompletion; });
    const reservation = await registry.reserve({ owner, session, timeoutMs: 60_000 });
    await registry.attach(reservation, { completion, logs: () => '', readLogs: () => ({
      totalBytes: 0, firstAvailableOffset: 0, chunks: [],
    }), stop: async () => {} }, undefined, 0);

    registry.beginCompletionCandidate(owner.sessionId, owner.runId);
    await assert.rejects(registry.reserve({ owner: { ...owner, callId: randomUUID() }, session, timeoutMs: 60_000 }),
      { code: 'execution_run_not_accepting' });
    let settled = false;
    const waitingForCommand = registry.settleRun(owner.sessionId, owner.runId, 'completed').then(() => { settled = true; });
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(settled, false, 'Run completion must await the already-owned command');

    complete(0);
    await waitingForCommand;
    assert.equal(settled, true);
    assert.equal(registry.status(owner, reservation.executionId).state, 'exited');

    registry.resumeRun(owner.sessionId, owner.runId);
    const resumed = await registry.reserve({ owner: { ...owner, callId: randomUUID() }, session, timeoutMs: 60_000 });
    await registry.failReservation(resumed, new Error('test cleanup'));
    await registry.finishRun(owner.sessionId, owner.runId);
    await assert.rejects(registry.reserve({ owner: { ...owner, callId: randomUUID() }, session, timeoutMs: 60_000 }),
      { code: 'execution_run_not_accepting' });
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Session log quota refuses another payload after restored references reach the limit', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-session-quota-'));
  const registry = createFiniteCommandRegistry();
  const sessionId = randomUUID();
  const projectIdentity = '/project';
  const priorEvents: Record<string, unknown>[] = [];
  const events = [] as Record<string, unknown>[];
  const session = { directory, append: async (event: Record<string, unknown>) => {
    events.push({ seq: priorEvents.length + events.length, ...event });
    return undefined;
  } };
  try {
    // Fifty valid 256 KiB output payloads exceed the 16 MiB encoded per-Session
    // ceiling. They are real sidecar files with matching Session references/digests.
    const output = Buffer.alloc(256 * 1024, 65);
    const snapshot = { totalBytes: output.length, firstAvailableOffset: 0,
      chunks: [{ sequence: 0, stream: 'stdout' as const, offset: 0, data: output }] };
    for (let index = 0; index < 50; index += 1) {
      const executionId = randomUUID();
      const logsRef = await writeExecutionLog(directory, executionId, snapshot);
      priorEvents.push(executionEvent({ seq: index, executionId, sessionId, runId: randomUUID(), projectIdentity, logsRef }));
    }
    const header = { kind: 'session', formatVersion: 4, sessionId, projectRoot: '/project',
      createdAt: new Date(0).toISOString() };
    const priorRecord = parseSessionEvents([header, ...priorEvents] as never[]);
    assert.equal(priorRecord.events.length, 50, 'the quota fixture uses valid Session execution facts');
    await registry.accountDirectory(directory);
    await registry.restoreSession({ sessionId, projectIdentity, projectRoot: '/project', session,
      events: priorRecord.events });

    const owner = { projectIdentity, projectRoot: '/project', sessionId, runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false };
    const executionId = await finishCommand(registry, directory, events, owner);
    const status = registry.status(owner, executionId);
    assert.equal(status.state, 'exited');
    assert.equal(status.logUnavailableReason, 'storage_quota_exceeded');
    const terminal = events.findLast((event) => event.kind === 'execution' && event.executionId === executionId);
    assert.equal(terminal?.logUnavailableReason, 'storage_quota_exceeded');
    assert.equal(Object.hasOwn(terminal ?? {}, 'logsRef'), false, 'the terminal Session event must not claim an unpersisted payload');
    const record = parseSessionEvents([header, ...priorEvents, ...events] as never[]);
    assert.equal(record.events.length, 53, 'the accepted, started, and terminal quota facts form a valid Session record');

    const restored = createFiniteCommandRegistry();
    try {
      await restored.accountDirectory(directory);
      await restored.restoreSession({ sessionId, projectIdentity, projectRoot: '/project', session,
        events: record.events });
      const recovered = restored.status(owner, executionId);
      assert.equal(recovered.state, 'exited');
      assert.equal(recovered.logAvailable, false);
      assert.equal(recovered.logUnavailableReason, 'storage_quota_exceeded');
    } finally {
      await restored.close();
    }
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host log quota fails closed when the aggregate retained payloads exceed its ceiling', async () => {
  const testRoot = resolve('testplace', 'tmp');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'finite-command-host-quota-'));
  const registry = createFiniteCommandRegistry();
  const events: Record<string, unknown>[] = [];
  const owner = { projectIdentity: '/project', projectRoot: '/project', sessionId: randomUUID(),
    runId: randomUUID(), callId: randomUUID(), workspaceTrusted: false };
  try {
    const firstId = randomUUID();
    const firstName = `execution-${firstId}.log.json`;
    const file = await open(join(directory, firstName), 'wx');
    try { await file.truncate(mebibyte); }
    finally { await file.close(); }
    for (let index = 1; index < 129; index += 1) {
      const executionId = randomUUID();
      await link(join(directory, firstName), join(directory, `execution-${executionId}.log.json`));
    }
    await registry.accountDirectory(directory);
    const executionId = await finishCommand(registry, directory, events, owner);
    const status = registry.status(owner, executionId);
    assert.equal(status.state, 'exited');
    assert.equal(status.logUnavailableReason, 'storage_quota_exceeded');
    const terminal = events.findLast((event) => event.kind === 'execution' && event.executionId === executionId);
    assert.equal(terminal?.logUnavailableReason, 'storage_quota_exceeded');
    assert.equal(Object.hasOwn(terminal ?? {}, 'logsRef'), false);
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
