// 会话记录首行说明格式版本、所属项目和初始模式清单，
// 而读的时候版本或事件种类读不懂就拒绝重建，不是静默跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionLog } from '../dist/index.js';
import { parseSessionEvents } from '../dist/session/format.js';
import type { SessionEvent } from '../dist/session/format.js';
import { createRunAcceptance } from '../dist/session/run.js';
import { estimateRequest, usageEvent } from '../dist/session/usage.js';

async function withDirectory<TResult>(run: (directory: string) => TResult | Promise<TResult>): Promise<TResult> {
  const root = await mkdtemp(join(process.cwd(), 'testplace', 'format-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tool = (seq: number, content: string) => JSON.stringify({ seq, kind: 'tool', tool: 'read', args: {}, result: { content } });

test('a new record starts with a line that names the format, the project and the mode it opened under', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({
      directory,
      id: 'run-1',
      meta: () => ({ projectRoot: '/repo', mode: { name: 'full', layer: 'user' } }),
    });
    const first = await session.append({ kind: 'user', text: 'go' });
    assert.equal(first.seq, 0, '首行不占事件的序号');

    const lines = (await readFile(session.path, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines[0], {
      kind: 'session',
      formatVersion: 5,
      sessionId: 'run-1',
      projectRoot: '/repo',
      createdAt: lines[0].createdAt,
      mode: { name: 'full', layer: 'user' },
    });
    assert.deepEqual(await session.read(), [first], '首行不是一条事件，读回来的仍然只有那一条');
    assert.deepEqual(await session.header(), lines[0]);
  });
});

test('session policy events must be ignorable and contain a valid restore snapshot', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'policy', projectRoot: '' };
  assert.throws(() => parseSessionEvents([
    header,
    { seq: 0, kind: 'sessionPolicy', override: null, consecutive: 0, total: 0, forcedToAsk: false },
  ] as unknown as SessionEvent[]), { code: 'session_policy_ignorable_required' });
  assert.throws(() => parseSessionEvents([
    header,
    { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'never', consecutive: 3, total: 2, forcedToAsk: true },
  ] as unknown as SessionEvent[]), { code: 'session_policy_event_invalid' });
  const none = { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'none', consecutive: 0, total: 0, forcedToAsk: false };
  const legacyNever = { seq: 0, kind: 'sessionPolicy', ignorable: true, override: 'never', consecutive: 3, total: 3, forcedToAsk: true };
  assert.equal(parseSessionEvents([header, none] as unknown as SessionEvent[]).events[0].override, 'none');
  assert.equal(parseSessionEvents([header, legacyNever] as unknown as SessionEvent[]).events[0].override, 'never', 'stored legacy never keeps its old identity');
});

test('run steering events require format 3 and keep accepted input separate from application', () => {
  const run = createRunAcceptance('run-input', 'start the task', null, 'human');
  const header = { kind: 'session', formatVersion: 3, sessionId: 'run-input', projectRoot: '' };
  const user = { seq: 0, kind: 'user', text: 'start the task', run };
  const accepted = {
    seq: 1, kind: 'runInput', mode: 'steer', state: 'accepted', inputId: 'input-1', runId: run.runId,
    source: 'human', text: 'keep the existing route', acceptedAt: '2026-11-15T00:00:00.000Z',
  };
  const applied = {
    seq: 2, kind: 'runInput', mode: 'steer', state: 'applied', inputId: 'input-1', runId: run.runId,
    appliedAt: '2026-11-15T00:00:01.000Z',
  };
  assert.deepEqual(parseSessionEvents([header, user, accepted, applied] as unknown as SessionEvent[])
    .events.filter((event) => event.kind === 'runInput').map((event) => event.state), ['accepted', 'applied']);
  assert.throws(() => parseSessionEvents([header, user, accepted, applied, {
    ...applied, seq: 3, appliedAt: '2026-11-15T00:00:02.000Z',
  }] as unknown as SessionEvent[]), { code: 'session_run_input_transition_invalid' });
  const cancelled = {
    seq: 2, kind: 'runInput', mode: 'steer', state: 'cancelled', inputId: 'input-1', runId: run.runId,
    cancelledAt: '2026-11-15T00:00:01.000Z',
  };
  assert.deepEqual(parseSessionEvents([header, user, accepted, cancelled] as unknown as SessionEvent[])
    .events.filter((event) => event.kind === 'runInput').map((event) => event.state), ['accepted', 'cancelled']);
  assert.throws(() => parseSessionEvents([header, user, accepted, {
    seq: 2, kind: 'turn', ignorable: true, status: 'cancelled', userSeq: 0, runId: run.runId,
  }] as unknown as SessionEvent[]), { code: 'session_run_input_pending' });
  assert.throws(() => parseSessionEvents([{ ...header, formatVersion: 2 }, user, accepted] as unknown as SessionEvent[]), {
    code: 'session_event_version_unsupported',
  });
  const excess = Array.from({ length: 17 }, (_, index) => ({
    seq: index + 1, kind: 'runInput', mode: 'steer', state: 'accepted', inputId: `input-${index}`,
    runId: run.runId, source: 'human', text: `input ${index}`, acceptedAt: '2026-11-15T00:00:00.000Z',
  }));
  assert.throws(() => parseSessionEvents([header, user, ...excess] as unknown as SessionEvent[]), {
    code: 'session_run_input_limit_exceeded',
  });
});

test('a child Run Acceptance carries durable parent identity and requires Session format 4', () => {
  const acceptance = createRunAcceptance('parent.sub-1', 'inspect child', { parentRunId: 'parent-run' }, 'controller:subagent', undefined, undefined, {
    sessionId: 'parent', runId: '123e4567-e89b-42d3-a456-426614174000', subrunId: 'parent.sub-1', callId: 'tool-call-1',
  });
  assert.equal(acceptance.version, 3);
  assert.deepEqual(acceptance.parentage, {
    sessionId: 'parent', runId: '123e4567-e89b-42d3-a456-426614174000', subrunId: 'parent.sub-1', callId: 'tool-call-1',
  });
  const user = { seq: 0, kind: 'user', text: 'inspect child', run: acceptance };
  assert.deepEqual(parseSessionEvents([
    { kind: 'session', formatVersion: 4, sessionId: 'parent.sub-1', projectRoot: '' }, user,
  ] as unknown as SessionEvent[]).events[0].run, acceptance);
  assert.throws(() => parseSessionEvents([
    { kind: 'session', formatVersion: 3, sessionId: 'parent.sub-1', projectRoot: '' }, user,
  ] as unknown as SessionEvent[]), { code: 'session_run_acceptance_version_unsupported' });
});

test('session MCP trust events are ignorable and validate the server identity', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'mcp-trust', projectRoot: '' };
  const trust = {
    seq: 0, kind: 'sessionMcpTrust', ignorable: true, source: 'trusted-ui', server: 'playwright', identityDigest: 'a'.repeat(64), trusted: true,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(parseSessionEvents([header, trust] as unknown as SessionEvent[]).events[0].kind, 'sessionMcpTrust');
  assert.throws(() => parseSessionEvents([header, { ...trust, identityDigest: 'invalid' }] as unknown as SessionEvent[]), { code: 'session_mcp_trust_event_invalid' });
});

test('a desktop-started child is a validated Session fact and stays out of model context', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'parent-session', meta: { projectRoot: '/repo' } });
    const acceptance = createRunAcceptance('parent-session', 'start the parent task', null, 'human');
    await session.append({ kind: 'user', text: 'start the parent task', run: acceptance });
    const started = await session.append({
      kind: 'subrunStarted', ignorable: true, source: 'human', parentRunId: acceptance.runId,
      subrunId: 'parent-session.sub-1', childSessionId: 'parent-session.sub-1',
      childRunId: '123e4567-e89b-42d3-a456-426614174000', presetId: 'research', taskLabel: 'inspect the project',
      startedAt: '2026-11-18T00:00:00.000Z',
    });

    const events = await session.read();
    assert.equal(events.at(-1)?.kind, 'subrunStarted');
    assert.equal(events.at(-1)?.seq, started.seq);
    assert.equal(JSON.stringify(await session.modelView()).includes('subrunStarted'), false);
    assert.equal(JSON.stringify(await session.modelView()).includes('inspect the project'), false);

    assert.throws(() => parseSessionEvents([
      { kind: 'session', formatVersion: 5, sessionId: 'parent-session', projectRoot: '/repo' },
      { seq: 0, kind: 'user', text: 'start the parent task', run: acceptance },
      { ...started, seq: 1, childSessionId: 'another-session.sub-1' },
    ] as unknown as SessionEvent[]), { code: 'session_subrun_started_event_invalid' });
  });
});

test('an Operation Session keeps its real exec record out of model context', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'operation-session', meta: { projectRoot: '/repo' } });
    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    await session.append({ kind: 'operationStarted', ignorable: true, source: 'desktop',
      sourceSessionId: 'source-session', operationId, startedAt: '2026-11-18T00:00:00.000Z' });
    await session.append({ kind: 'tool', tool: 'exec', runId: operationId, callId: 'operation-call',
      args: { command: 'node operation-probe.mjs' }, result: { content: { executionId: 'operation-execution' }, failed: false } });
    await session.append({ kind: 'operationFinished', ignorable: true, operationId, state: 'exited', exitCode: 7,
      finishedAt: '2026-11-18T00:00:01.000Z' });

    const events = await session.read();
    assert.deepEqual(events.map(event => event.kind), ['operationStarted', 'tool', 'operationFinished']);
    assert.deepEqual(await session.modelView(), [], 'a manual command result is not a Provider tool reply');
    assert.throws(() => parseSessionEvents([
      { kind: 'session', formatVersion: 5, sessionId: 'operation-session', projectRoot: '/repo' },
      { seq: 0, kind: 'operationStarted', ignorable: true, source: 'desktop', sourceSessionId: 'source-session',
        operationId, startedAt: '2026-11-18T00:00:00.000Z' },
      { seq: 1, kind: 'operationFinished', ignorable: true, operationId, state: 'completed',
        finishedAt: '2026-11-18T00:00:01.000Z' },
    ] as unknown as SessionEvent[]), { code: 'session_operation_finished_event_invalid' });
  });
});

test('compaction events are ignorable and carry the block identity, range and reason', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'compaction', projectRoot: '' };
  const written = { seq: 0, kind: 'compaction', ignorable: true, reason: 'auto', blockId: 1, fromSeq: 0, toSeq: 8, tokensBefore: 3000, tokensAfter: 900 };
  assert.equal(parseSessionEvents([header, written] as unknown as SessionEvent[]).events[0].kind, 'compaction');
  for (const broken of [
    { ...written, ignorable: false },
    { ...written, reason: 'spontaneous' },
    { ...written, blockId: 0 },
    { ...written, toSeq: -1 },
    { ...written, tokensBefore: 'many' },
  ]) {
    assert.throws(() => parseSessionEvents([header, broken] as unknown as SessionEvent[]), { code: 'session_compaction_event_invalid' }, JSON.stringify(broken));
  }
});

test('session approval memory events are ignorable and validate the saved rule', () => {
  const header = { kind: 'session', formatVersion: 2, sessionId: 'policy-rule', projectRoot: '' };
  const saved = { seq: 0, kind: 'sessionPolicyRule', ignorable: true, updatedAt: new Date().toISOString(), rule: { tool: 'mcp:playwright/browser_click', decision: 'allow' } };
  assert.equal(parseSessionEvents([header, saved] as unknown as SessionEvent[]).events[0].kind, 'sessionPolicyRule');
  const fileRule = { ...saved, rule: { tool: 'create', decision: 'allow', target: 'file', path: join(process.cwd(), 'testplace', 'app.js') } };
  assert.equal(parseSessionEvents([header, fileRule] as unknown as SessionEvent[]).events[0].kind, 'sessionPolicyRule');
  assert.throws(() => parseSessionEvents([header, { ...saved, rule: { tool: 'create', decision: 'allow', target: 'file', path: 'app.js' } }] as unknown as SessionEvent[]), { code: 'session_policy_rule_event_invalid' });
  assert.throws(() => parseSessionEvents([header, { ...saved, rule: { tool: '', decision: 'allow' } }] as unknown as SessionEvent[]), { code: 'session_policy_rule_event_invalid' });
});

// 开局还没选过模式时那一格就是不写，而不是写一个空名字或写一份假的默认。
test('a record that never picked a mode says so by leaving the field out', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'run-2', meta: { projectRoot: '/repo' } });
    await session.append({ kind: 'user', text: 'go' });
    assert.equal('mode' in (await session.header())!, false);
  });
});

// 宿主打开会话时需要读取记录以恢复模式，但这次读取不能阻止缺失的首行正常写入。
test('a record read before its first write still gets its first line', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'read-first', meta: { projectRoot: '/repo' } });
    assert.deepEqual(await session.read(), [], '读一份还不存在的记录不是错误');
    await session.append({ kind: 'user', text: 'go' });
    const lines = (await readFile(session.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0].kind, 'session');
    assert.equal(lines[1].seq, 0, '首行不占事件的序号');
  });
});

// 没有首行的现存记录按版本 0 读，读出来还是原来那几条，序号接着最后一条往后走。
test('a record written before the first line existed still reads and continues', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'legacy.jsonl');
    await writeFile(path, `${[tool(0, 'one'), tool(1, 'two')].join('\n')}\n`);
    const session = createSessionLog({ directory, id: 'legacy' });
    assert.equal(await session.header(), undefined);
    assert.deepEqual((await session.read()).map((event) => event.seq), [0, 1]);

    const next = await session.append({ kind: 'user', text: 'three' });
    assert.equal(next.seq, 2, '接在已有记录之后，不重复用号');
// 不为缺少首行的旧记录补写元信息，避免改变原有记录格式。
    assert.equal(await session.header(), undefined);
    assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 3);
  });
});

test('a record from a newer format is refused instead of half read', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'future.jsonl');
    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 6, sessionId: 'future', projectRoot: '/repo', createdAt: 'x' })}\n${tool(0, 'one')}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'future' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_version_unsupported');
      assert.match(failure.detail, /record is version 6/);
      return true;
    });
  });
});

test('a review decision is stored as skippable audit and rejects malformed records', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'review.jsonl');
    const review = {
      seq: 1,
      kind: 'policyReview',
      ignorable: true,
      at: '2026-11-04T00:00:00.000Z',
      tool: 'exec',
      review: 'ask-human',
      reasonCode: 'review_timeout',
      make: 'session-reviewer',
      durationMs: 12.5,
    };
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify(review)}\n`);
    const log = createSessionLog({ directory, id: 'review' });
    const events = await log.read();
    assert.equal(events.filter((event) => event.kind === 'policyReview').length, 1);
    assert.equal((await log.modelView()).length, 1, '复审记录不进入模型投影');

    // 没有 ignorable 的记录会让旧读取方无法判断，必须拒绝而不是猜。
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ ...review, ignorable: false })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'review' }).read(), (error) => {
      assert.equal((error as { code?: string }).code, 'session_policy_review_event_invalid');
      return true;
    });

    for (const broken of [
      { ...review, review: 'allow-always' },
      { ...review, tool: '' },
      { ...review, durationMs: 'soon' },
      { ...review, reasonCode: 'NOT A CODE' },
    ]) {
      await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify(broken)}\n`);
      await assert.rejects(() => createSessionLog({ directory, id: 'review' }).read(), (error) => {
        assert.equal((error as { code?: string }).code, 'session_policy_review_event_invalid');
        return true;
      });
    }
  });
});

test('a usage event keeps its purpose and refuses one it cannot explain', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'usage.jsonl');
    const usage = { seq: 1, kind: 'usage', ignorable: true, purpose: 'reviewer', input: 120, output: 8, estimated: 140, measurement: 'request-v1' };
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify(usage)}\n`);
    const events = await createSessionLog({ directory, id: 'usage' }).read();
    assert.equal(events.filter((event) => event.kind === 'usage').length, 1);
    assert.equal((await createSessionLog({ directory, id: 'usage' }).modelView()).length, 1, '用量不进入模型投影');

    // 用途决定记在谁的账上；解释不了的用途必须拒绝，不能默认算成主 Agent。
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ ...usage, purpose: 'subagent' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'usage' }).read(), (error) => {
      assert.equal((error as { code?: string }).code, 'session_usage_event_invalid');
      return true;
    });
  });
});

test('an event kind this build does not know is refused unless the record says it may be skipped', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'kind.jsonl');
    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', text: 'x' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'kind' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_event_unsupported');
      assert.equal(failure.detail, 'plan/step');
      return true;
    });

    await writeFile(path, `${tool(0, 'one')}\n${JSON.stringify({ seq: 1, kind: 'plan/step', ignorable: true })}\n${tool(2, 'two')}\n`);
    const reopened = createSessionLog({ directory, id: 'kind' });
    assert.deepEqual((await reopened.read()).map((event) => event.tool), ['read', 'read'], '标过的种类可以被略过，剩下的一条不少');
    assert.equal((await reopened.modelView()).length, 2);
    const after = await reopened.append({ kind: 'user', text: 'next' });
    assert.equal(after.seq, 3, '略过一条不认识的事件不影响继续编号');
  });
});

test('finite execution events are ignorable Session facts but stay scoped to their Session', () => {
  const header = { kind: 'session', formatVersion: 4, sessionId: 'exec-session', projectRoot: '/repo' };
  const identity = {
    projectIdentity: '/repo', sessionId: 'exec-session', runId: 'run-1', callId: 'call-1',
    executionId: 'execution-1', cursorGeneration: '00000000-0000-4000-8000-000000000001',
    timeoutMs: 120_000, logTotalBytes: 0, logFirstAvailableOffset: 0, cancelRequested: false, deadlineExceeded: false,
    terminationPending: false, cleanupPending: false,
  };
  const accepted = { seq: 0, kind: 'execution', ignorable: true, state: 'accepted', acceptedAt: '2026-11-17T00:00:00.000Z', ...identity };
  const started = { seq: 1, kind: 'execution', ignorable: true, state: 'started', startedAt: '2026-11-17T00:00:01.000Z', ...identity };
  const exited = { seq: 2, kind: 'execution', ignorable: true, state: 'exited', startedAt: started.startedAt,
    finishedAt: '2026-11-17T00:00:02.000Z', exitCode: 0, ...identity };
  assert.deepEqual(parseSessionEvents([header, accepted, started, exited] as unknown as SessionEvent[]).events
    .map((event) => event.state), ['accepted', 'started', 'exited']);
  assert.throws(() => parseSessionEvents([header, { ...accepted, sessionId: 'other-session' }] as unknown as SessionEvent[]), {
    code: 'session_execution_event_invalid',
  });
});

test('tool activity events validate their Session, Run, call, and live interaction phase', () => {
  const header = { kind: 'session', formatVersion: 4, sessionId: 'tool-activity-session', projectRoot: '/repo' };
  const identity = {
    ignorable: true,
    sessionId: 'tool-activity-session',
    runId: '00000000-0000-4000-8000-000000000001',
    callId: 'call-1',
    tool: 'exec',
    at: '2026-11-17T00:00:00.000Z',
  };
  const events = [
    { seq: 0, kind: 'toolActivity', phase: 'started', ...identity },
    { seq: 1, kind: 'toolActivity', phase: 'awaiting_approval', requestId: 'request-1', ...identity },
    { seq: 2, kind: 'toolActivity', phase: 'awaiting_user', requestId: 'request-2', ...identity },
  ];
  assert.deepEqual(parseSessionEvents([header, ...events] as unknown as SessionEvent[]).events.map((event) => event.kind),
    ['toolActivity', 'toolActivity', 'toolActivity']);
  assert.throws(() => parseSessionEvents([header, { ...events[0], phase: 'completed' }] as unknown as SessionEvent[]), {
    code: 'session_tool_activity_invalid',
  });
  assert.throws(() => parseSessionEvents([header, { ...events[0], sessionId: 'other-session' }] as unknown as SessionEvent[]), {
    code: 'session_tool_activity_invalid',
  });
  assert.throws(() => parseSessionEvents([header, { ...events[1], requestId: undefined }] as unknown as SessionEvent[]), {
    code: 'session_tool_activity_invalid',
  });
});

test('branch records accept inherited tool activity only inside the parent prefix', () => {
  const header = {
    kind: 'session', formatVersion: 4, sessionId: 'branch-session', projectRoot: '/repo',
    branchOf: 'parent-session', branchAt: 0,
  };
  const inherited = {
    seq: 0, kind: 'toolActivity', ignorable: true, sessionId: 'parent-session',
    runId: '00000000-0000-4000-8000-000000000001', callId: 'call-1', tool: 'read_image',
    phase: 'started', at: '2026-11-17T00:00:00.000Z',
  };
  assert.deepEqual(parseSessionEvents([header, inherited] as unknown as SessionEvent[]).events.map((event) => event.kind), ['toolActivity']);
  assert.throws(() => parseSessionEvents([header, { ...inherited, sessionId: 'other-parent' }] as unknown as SessionEvent[]), {
    code: 'session_tool_activity_invalid',
  });
  assert.throws(() => parseSessionEvents([header, { ...inherited, seq: 1 }] as unknown as SessionEvent[]), {
    code: 'session_tool_activity_invalid',
  });
});

test('direct file change facts are bounded, portable, and tied to a tool result', () => {
  const header = { kind: 'session', formatVersion: 4, sessionId: 'file-change-session', projectRoot: '/repo' };
  const change = {
    path: 'src/example.ts', operation: 'edit', outcome: 'written',
    beforeVersion: 'a'.repeat(16), expectedAfterVersion: 'b'.repeat(16), observedAfterVersion: 'b'.repeat(16),
    observedAt: '2026-11-17T00:00:00.000Z', baselineStatus: 'available', baselineExists: true,
    baselineVersion: 'a'.repeat(16), baselineRef: { name: `change-${'d'.repeat(16)}-${'0'.repeat(8)}-${'0'.repeat(4)}-4000-8000-${'0'.repeat(12)}.snapshot`,
      bytes: 12, sha256: 'c'.repeat(64) },
    observedStatus: 'available', observedExists: true, expectedMatchesObserved: true, changedFromBaseline: true,
  };
  const tool = { seq: 0, kind: 'tool', tool: 'edit', callId: 'call-1', runId: 'run-1',
    result: { kind: 'result', failed: false, content: '' }, fileChanges: [change] };
  assert.equal(parseSessionEvents([header, tool] as unknown as SessionEvent[]).events[0]?.fileChanges instanceof Array, true);
  for (const invalid of [
    { ...change, path: 'C:/outside.txt' },
    { ...change, path: '../outside.txt' },
    { ...change, baselineRef: { ...change.baselineRef, name: '../outside.snapshot' } },
    { ...change, observedAfterVersion: 'not-a-version' },
    { ...change, baselineStatus: 'maybe' },
  ]) {
    assert.throws(() => parseSessionEvents([header, { ...tool, fileChanges: [invalid] }] as unknown as SessionEvent[]), {
      code: 'session_file_change_invalid',
    });
  }
  assert.throws(() => parseSessionEvents([header, { ...tool, fileChanges: [{ ...change, operation: 'write' }] }] as unknown as SessionEvent[]), {
    code: 'session_file_change_invalid',
  }, 'the recorded operation must match the tool name');
});

test('Desktop file saves are additive ignorable Session facts and cannot claim an Agent Run', () => {
  const header = { kind: 'session', formatVersion: 5, sessionId: 'desktop-file-session', projectRoot: '/repo' };
  const fact = {
    path: 'src/example.ts', operation: 'write', outcome: 'written',
    beforeVersion: 'a'.repeat(16), expectedAfterVersion: 'b'.repeat(16), observedAfterVersion: 'b'.repeat(16),
    observedAt: '2026-11-17T00:00:00.000Z', baselineStatus: 'available', baselineExists: true,
    baselineVersion: 'a'.repeat(16), baselineRef: { name: `change-${'d'.repeat(16)}-${'0'.repeat(8)}-${'0'.repeat(4)}-4000-8000-${'0'.repeat(12)}.snapshot`,
      bytes: 12, sha256: 'c'.repeat(64) },
    observedStatus: 'available', observedExists: true, expectedMatchesObserved: true, changedFromBaseline: true,
  };
  const event = { seq: 0, kind: 'workspaceFileChange', ignorable: true, source: 'desktop', fileChanges: [fact] };
  assert.equal(parseSessionEvents([header, event] as unknown as SessionEvent[]).events[0]?.kind, 'workspaceFileChange');
  for (const invalid of [
    { ...event, source: 'model' },
    { ...event, ignorable: false },
    { ...event, fileChanges: [] },
    { ...event, runId: '00000000-0000-4000-8000-000000000001' },
    { ...event, fileChanges: [{ ...fact, operation: 'delete' }] },
  ]) {
    assert.throws(() => parseSessionEvents([header, invalid] as unknown as SessionEvent[]), {
      code: 'session_workspace_file_change_invalid',
    });
  }
});

test('check results require Session format 5 and a matching terminal finite execution', () => {
  const sessionId = 'check-session';
  const runId = '00000000-0000-4000-8000-000000000001';
  const callId = 'provider-call-1';
  const executionId = '00000000-0000-4000-8000-000000000002';
  const header = { kind: 'session', formatVersion: 5, sessionId, projectRoot: '/repo' };
  const declaration = { name: 'focused test', purpose: 'verify the requested behavior', expectedExitCodes: [0], scope: ['src/example.ts'] };
  const sample = { path: 'src/example.ts', status: 'available', exists: true, version: 'a'.repeat(16), sampledAt: '2026-11-17T00:00:00.000Z' };
  const identity = {
    ignorable: true, executionId, cursorGeneration: '00000000-0000-4000-8000-000000000003',
    projectIdentity: '/repo', sessionId, runId, callId, timeoutMs: 120_000,
    logTotalBytes: 0, logFirstAvailableOffset: 0, cancelRequested: false, deadlineExceeded: false,
    terminationPending: false, cleanupPending: false,
    check: declaration, checkScopeStart: [sample],
  };
  const accepted = { seq: 0, kind: 'execution', state: 'accepted', acceptedAt: '2026-11-17T00:00:00.000Z', ...identity };
  const started = { seq: 1, kind: 'execution', state: 'started', startedAt: '2026-11-17T00:00:01.000Z', ...identity };
  const exited = { seq: 2, kind: 'execution', state: 'exited', startedAt: started.startedAt,
    finishedAt: '2026-11-17T00:00:02.000Z', exitCode: 0, ...identity };
  const check = {
    seq: 3, kind: 'check', sessionId, runId, callId, executionId, at: '2026-11-17T00:00:02.100Z',
    declaration, executionState: 'exited', exitCode: 0, commandStatus: 'met', reportStatus: 'not_requested',
    logStatus: 'complete', logTotalBytes: 0, logFirstAvailableOffset: 0,
    scopeStart: [sample], scopeEnd: [sample], scopeStatus: 'sampled', coverage: 'session_scope_samples_only',
  };
  const parsed = parseSessionEvents([header, accepted, started, exited, check] as unknown as SessionEvent[]);
  assert.equal(parsed.events.at(-1)?.kind, 'check');
  assert.throws(() => parseSessionEvents([
    { ...header, formatVersion: 4 }, check,
  ] as unknown as SessionEvent[]), { code: 'session_event_version_unsupported' });
  assert.throws(() => parseSessionEvents([header, accepted, started, exited, { ...check, callId: 'other-call' }] as unknown as SessionEvent[]), {
    code: 'session_check_event_invalid',
  });
  assert.throws(() => parseSessionEvents([header, accepted, started, exited, { ...check, ignorable: true }] as unknown as SessionEvent[]), {
    code: 'session_check_event_invalid',
  });
});

test('session Permission events require format 2 and remain in the canonical record', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'permission.jsonl');
    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 2, sessionId: 'permission', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ seq: 0, kind: 'sessionPermission', profile: 'workspace-write', network: 'policy' })}\n`);
    const record = await createSessionLog({ directory, id: 'permission' }).read();
    assert.equal(record[0].kind, 'sessionPermission');

    await writeFile(path, `${JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 'permission', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ seq: 0, kind: 'sessionPermission', profile: 'full-access', network: 'unrestricted' })}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'permission' }).read(), (error) => {
      const failure = error as { code?: string; detail: string };
      assert.equal(failure.code, 'session_event_version_unsupported');
      assert.match(failure.detail, /format version 2/);
      return true;
    });
  });
});

// 首行之外再出现一份会话元信息，说明这份记录被拼接过；读下去只会读出错误的装配。
test('a second header line is a refusal, not a second session', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'spliced.jsonl');
    const header = JSON.stringify({ kind: 'session', formatVersion: 1, sessionId: 'spliced', projectRoot: '/repo', createdAt: '2026-01-01T00:00:00.000Z' });
    await writeFile(path, `${header}\n${tool(0, 'one')}\n${header}\n`);
    await assert.rejects(() => createSessionLog({ directory, id: 'spliced' }).read(), (error) => {
      const failure = error as { code?: string };
      assert.equal(failure.code, 'session_header_position');
      return true;
    });
  });
});

// 用量事件会写入并从记录中读回。它不参与模型投影，但保留连续的事件序号，避免检查点范围出现空缺。
test('the usage event this build writes comes back out of a record', async () => {
  await withDirectory(async (directory) => {
    const session = createSessionLog({ directory, id: 'usage-kept' });
    await session.append({ kind: 'user', text: 'one' });
    await session.append({ kind: 'usage', ignorable: true, input: 400, output: 5, estimated: 120 });
    await session.append({ kind: 'usage', ignorable: true, input: null, output: 7, estimated: 140, measurement: 'request-v1',
      cache: { source: 'chat-completions', sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 20 }, { field: 'prompt_cache_miss_tokens', tokens: 30 }],
        hitInputTokens: 20, missInputTokens: 30, creationInputTokens: null, uncachedInputTokens: null,
        providerInputIncludesCache: true, consistent: null } });
    const events = await createSessionLog({ directory, id: 'usage-kept' }).read();
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.equal(events[1].kind, 'usage');
    assert.deepEqual(events[2], {
      seq: 2, kind: 'usage', ignorable: true, input: null, output: 7, estimated: 140, measurement: 'request-v1',
      cache: { source: 'chat-completions', sourceFields: [{ field: 'prompt_cache_hit_tokens', tokens: 20 }, { field: 'prompt_cache_miss_tokens', tokens: 30 }],
        hitInputTokens: 20, missInputTokens: 30, creationInputTokens: null, uncachedInputTokens: null,
        providerInputIncludesCache: true, consistent: null },
    }, 'nullable cache-aware records survive while old usage rows remain readable');
    assert.deepEqual((await session.modelView() as { role?: string }[]).map((entry) => entry.role), ['user'], '用量那一格不进投影');
  });
});

test('a usage event keeps unknown totals null instead of coercing null or absence to zero', () => {
  const request = { system: '', tools: [], messages: [{ role: 'user', text: 'one' }] };
  assert.deepEqual(usageEvent(request, [{ type: 'usage', input: null, output: null, cache: {
    source: 'anthropic-messages', sourceFields: [{ field: 'cache_read_input_tokens', tokens: 12 }],
    hitInputTokens: 12, missInputTokens: null, creationInputTokens: null,
    uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
  } }]), {
    kind: 'usage', ignorable: true, purpose: 'agent', input: null, output: null,
    estimated: estimateRequest(request),
    measurement: 'request-v1', cache: {
      source: 'anthropic-messages', sourceFields: [{ field: 'cache_read_input_tokens', tokens: 12 }],
      hitInputTokens: 12, missInputTokens: null, creationInputTokens: null,
      uncachedInputTokens: null, providerInputIncludesCache: false, consistent: null,
    },
  });
  assert.equal(usageEvent(request, [{ type: 'usage', input: null, output: null }]), null);
  assert.equal(usageEvent(request, [{ type: 'usage', input: 0, output: 0 }])!.input, 0, 'an explicitly reported zero remains distinct from missing usage');
});
