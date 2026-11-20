import test from 'node:test';
import assert from 'node:assert/strict';
import { runResourcesOf, type RunResourceParticipant } from '../dist/host/run-resources.js';

function participant(log: string[], name: string, failure?: Error): RunResourceParticipant {
  const record = (phase: string) => {
    log.push(`${name}:${phase}`);
    if (failure !== undefined && failure.message === phase) throw failure;
  };
  return {
    beginCompletionCandidate: () => record('begin'),
    resume: () => record('resume'),
    settle: async (status) => {
      log.push(`${name}:settle:${status}`);
      if (failure !== undefined && failure.message === `settle`) throw failure;
    },
    finish: async () => {
      log.push(`${name}:finish`);
      if (failure !== undefined && failure.message === `finish`) throw failure;
    },
  };
}

test('every resource takes part in each lifecycle phase exactly once', async () => {
  const log: string[] = [];
  const resources = runResourcesOf([participant(log, 'child'), participant(log, 'command')]);
  resources.beginCompletionCandidate();
  resources.resume();
  await resources.settle('cancelled');
  await resources.finish();
  assert.deepEqual(log, [
    'child:begin', 'command:begin',
    'child:resume', 'command:resume',
    'child:settle:cancelled', 'command:settle:cancelled',
    'child:finish', 'command:finish',
  ]);
});

test('a synchronous admission failure still closes the other resources', () => {
  const log: string[] = [];
  const broken: RunResourceParticipant = {
    beginCompletionCandidate: () => {
      log.push('broken:begin');
      throw new Error('admission_failed');
    },
    resume: () => log.push('broken:resume'),
    settle: async () => {},
    finish: async () => {},
  };
  const resources = runResourcesOf([broken, participant(log, 'command')]);
  assert.throws(() => resources.beginCompletionCandidate(), /admission_failed/);
  assert.deepEqual(log, ['broken:begin', 'command:begin']);
});

test('settle and finish report one aggregate error while running every resource', async () => {
  const log: string[] = [];
  const resources = runResourcesOf([
    participant(log, 'child', new Error('settle')),
    participant(log, 'command', new Error('settle')),
  ]);
  await assert.rejects(resources.settle('failed'), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'run_resources_settle_failed');
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(log, ['child:settle:failed', 'command:settle:failed']);

  const finishLog: string[] = [];
  const finishing = runResourcesOf([
    participant(finishLog, 'child', new Error('finish')),
    participant(finishLog, 'command'),
  ]);
  await assert.rejects(finishing.finish(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'run_resources_finish_failed');
    return true;
  });
  assert.deepEqual(finishLog, ['child:finish', 'command:finish']);
});
