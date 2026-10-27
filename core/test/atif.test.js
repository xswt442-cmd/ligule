import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionLog } from '../dist/index.js';
import { sessionTurnToAtif } from '../dist/session/atif.js';
import { createRunAcceptance } from '../dist/session/run.js';

async function makeSession({ unknown = false } = {}) {
  const testplace = resolve('testplace');
  await mkdir(testplace, { recursive: true });
  const directory = await mkdtemp(join(testplace, 'ligule-atif-'));
  const session = createSessionLog({ directory, id: 'atif-session' });
  const acceptance = createRunAcceptance('atif-session', 'inspect the private file', null, 'test');
  const user = await session.append({ kind: 'user', text: 'inspect the private file', run: acceptance });
  await session.append({ kind: 'usage', ignorable: true, input: 12, output: null, estimated: 10, measurement: 'request-v1' });
  await session.append({ kind: 'reasoning', text: 'private chain of thought' });
  await session.append({ kind: 'assistant', text: 'I will read it', toolCalls: [
    { id: 'call-1', name: 'read', args: { path: 'C:\\secret\\note.txt' } },
    { id: 'call-2', name: 'write', args: { path: 'result.txt', content: 'private parameter' } },
  ], reasoning: 'private chain of thought' });
  await session.append({ kind: 'tool', tool: 'read', callId: 'call-1', args: { path: 'C:\\secret\\note.txt' },
    result: unknown
      ? { kind: 'failure', failed: true, code: 'tool_outcome_unknown', content: 'external effect unknown' }
      : { kind: 'result', failed: false, content: 'private file contents' } });
  await session.append({ kind: 'tool', tool: 'write', callId: 'call-2', args: { path: 'result.txt', content: 'private parameter' },
    result: { kind: 'refusal', failed: true, code: 'permission_denied', reason: 'private refusal detail', content: '' } });
  await session.append({ kind: 'assistant', text: 'Done with private details.', toolCalls: [] });
  await session.append({ kind: 'turn', ignorable: true, status: 'failed', userSeq: user.seq,
    runId: acceptance.runId, code: 'run_failed' });
  return { directory, session, acceptance, user };
}

const source = (acceptance, user) => ({
  sessionId: 'atif-session',
  userSeq: user.seq,
  runId: acceptance.runId,
  agentName: 'ligule',
  agentVersion: '0.1.1-dev',
  modelName: 'provider/model',
});

test('exports one real Session turn as ATIF v1.8 with private content redacted', async () => {
  const fixture = await makeSession();
  try {
    const trajectory = sessionTurnToAtif(await fixture.session.read(), source(fixture.acceptance, fixture.user));
    if (process.env.LIGULE_ATIF_OUTPUT_PATH) {
      await writeFile(process.env.LIGULE_ATIF_OUTPUT_PATH, `${JSON.stringify(trajectory, null, 2)}\n`, 'utf8');
    }
    assert.equal(trajectory.schema_version, 'ATIF-v1.8');
    assert.equal(trajectory.session_id, fixture.acceptance.runId);
    assert.equal(trajectory.steps[0].message, '[redacted]');
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls);
    assert.equal(agent.message, '[redacted]');
    assert.deepEqual(agent.metrics, { prompt_tokens: 12 }, 'unknown completion usage is omitted, not zero');
    assert.deepEqual(agent.tool_calls.map((call) => [call.tool_call_id, call.arguments]), [
      ['call-1', {}], ['call-2', {}],
    ]);
    assert.deepEqual(agent.observation.results.map((result) => result.source_call_id), ['call-1', 'call-2']);
    assert.equal(agent.observation.results[0].extra.ligule.outcome, 'completed');
    assert.equal(agent.observation.results[1].extra.ligule.outcome, 'failed');
    assert.equal(agent.observation.results[1].extra.ligule.error_code, 'permission_denied');
    assert.equal(JSON.stringify(trajectory).includes('private'), false);
    assert.equal(JSON.stringify(trajectory).includes('C:\\secret'), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('explicit local sensitive-content option includes message, arguments, and tool output', async () => {
  const fixture = await makeSession();
  try {
    const trajectory = sessionTurnToAtif(await fixture.session.read(), source(fixture.acceptance, fixture.user), {
      includeSensitiveContent: true,
    });
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls);
    assert.equal(trajectory.steps[0].message, 'inspect the private file');
    assert.equal(agent.message, 'I will read it');
    assert.equal(agent.tool_calls[0].arguments.path, 'C:\\secret\\note.txt');
    assert.equal(agent.observation.results[0].content, 'private file contents');
    assert.equal('reasoning_content' in agent, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('unknown tool outcome remains unknown and an unresolved call is rejected', async () => {
  const fixture = await makeSession({ unknown: true });
  try {
    const events = await fixture.session.read();
    const trajectory = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user));
    const agent = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls);
    assert.equal(agent.observation.results[0].extra.ligule.outcome, 'unknown');
    assert.equal(agent.observation.results[0].extra.ligule.failed, true);

    const unresolved = events.filter((event) => !(event.kind === 'tool' && event.callId === 'call-1'));
    assert.throws(() => sessionTurnToAtif(unresolved, source(fixture.acceptance, fixture.user)), /atif_tool_result_missing/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects duplicate tool outcomes instead of choosing one', async () => {
  const fixture = await makeSession();
  try {
    const events = await fixture.session.read();
    const original = events.find((event) => event.kind === 'tool' && event.callId === 'call-1');
    assert.ok(original);
    const duplicate = { ...original, seq: Math.max(...events.map((event) => event.seq)) + 1 };
    assert.throws(() => sessionTurnToAtif([...events, duplicate], source(fixture.acceptance, fixture.user)), /atif_tool_result_duplicate/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('marks spilled output as incomplete instead of presenting the preview as full content', async () => {
  const fixture = await makeSession();
  try {
    const events = await fixture.session.read();
    const tool = events.find((event) => event.kind === 'tool' && event.callId === 'call-1');
    tool.result.content = 'start\n[omitted: full output is 100 bytes, kept in result-3-deadbeef.json]\nend';
    const trajectory = sessionTurnToAtif(events, source(fixture.acceptance, fixture.user), { includeSensitiveContent: true });
    const result = trajectory.steps.find((step) => step.source === 'agent' && step.tool_calls).observation.results[0];
    assert.equal(result.extra.ligule.output_truncated, true);
    assert.equal(result.extra.ligule.spill_content_missing, true);
    assert.ok(trajectory.extra.ligule.missing_features.includes('spill_content'));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
