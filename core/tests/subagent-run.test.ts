// 子 Run 的建立点必须只产生一份身份，且来源、父绑定与 steering 收件箱彼此一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginChildRun, childRunCallerScope } from '../dist/tools/subagent-run.js';

test('a child Run is accepted as controller work unless the caller is human', () => {
  assert.equal(childRunCallerScope('human'), 'human');
  assert.equal(childRunCallerScope('controller'), 'controller:subagent');
});

test('beginChildRun binds one acceptance, one session and one steering inbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ligule-subrun-identity-'));
  try {
    const parentage = {
      sessionId: 'parent-session', runId: '11111111-1111-4111-8111-111111111111',
      subrunId: 'child-session', callId: 'call-1',
    };
    const begun = beginChildRun({
      directory,
      sessionId: 'child-session',
      task: 'inspect the fixture',
      source: 'human',
      delegation: {
        parentRunId: '11111111-1111-4111-8111-111111111111', parentCallId: 'call-1', mode: null,
        outputTokens: null, thinkingEffort: null, loopIterations: null, modelCalls: null, outputSchema: null,
      },
      parentage,
      meta: () => ({ projectRoot: directory }),
    });
    assert.equal(begun.session.id, 'child-session');
    assert.equal(begun.acceptance.sessionId, 'child-session');
    assert.equal(begun.acceptance.callerScope, 'human');
    assert.equal(begun.acceptance.version, 3, 'a child acceptance persists its parent binding');
    assert.deepEqual(begun.acceptance.parentage, parentage);

    begun.steering.activate();
    await begun.session.append({ kind: 'user', origin: 'human', run: begun.acceptance });
    const accepted = await begun.steering.accept('human', 'keep the fixture untouched');
    assert.equal(accepted.runId, begun.acceptance.runId, 'the inbox targets the acceptance it was built with');
    const events = await begun.session.read();
    const steer = events.find((event) => event.kind === 'runInput');
    assert.equal(steer?.runId, begun.acceptance.runId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a controller child Run keeps its durable controller scope', () => {
  const begun = beginChildRun({
    directory: 'testplace/tmp',
    sessionId: 'controller-child',
    task: 'verify',
    source: 'controller',
    delegation: {
      parentRunId: null, parentCallId: null, mode: null,
      outputTokens: null, thinkingEffort: null, loopIterations: null, modelCalls: null, outputSchema: null,
    },
    parentage: undefined,
    meta: () => ({}),
  });
  assert.equal(begun.acceptance.callerScope, 'controller:subagent');
  assert.equal(begun.acceptance.version, 1, 'no parent binding means no parentage version');
});
