import test from 'node:test';
import assert from 'node:assert/strict';
import { KernelError } from '../dist/kernel/error.js';
import { runResourcesOf, type RunResourceParticipant } from '../dist/host/run-resources.js';

function participant(
  log: string[],
  name: string,
  failures: { readonly settle?: () => unknown; readonly finish?: () => unknown } = {},
): RunResourceParticipant {
  return {
    name,
    beginCompletionCandidate: () => log.push(`${name}:begin`),
    resume: () => log.push(`${name}:resume`),
    settle: async (status) => {
      log.push(`${name}:settle:${status}`);
      if (failures.settle !== undefined) throw failures.settle();
    },
    finish: async () => {
      log.push(`${name}:finish`);
      if (failures.finish !== undefined) throw failures.finish();
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
    name: 'broken',
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

test('a synchronous settle failure still runs the other resource and becomes a domain error', async () => {
  const log: string[] = [];
  const broken: RunResourceParticipant = {
    name: 'child',
    beginCompletionCandidate: () => {},
    resume: () => {},
    settle: () => {
      log.push('child:settle');
      throw new KernelError('subagent_parent_cancelled');
    },
    finish: async () => {},
  };
  const resources = runResourcesOf([broken, participant(log, 'command')]);
  await assert.rejects(resources.settle('cancelled'), (error: unknown) => {
    assert.ok(error instanceof KernelError);
    assert.equal(error.code, 'run_resources_settle_failed');
    assert.match(error.detail ?? '', /child: subagent_parent_cancelled/);
    assert.ok(error.cause instanceof AggregateError);
    return true;
  });
  assert.deepEqual(log, ['child:settle', 'command:settle:cancelled']);
});

test('settle and finish report one domain error naming every failed resource', async () => {
  const log: string[] = [];
  const resources = runResourcesOf([
    participant(log, 'child', { settle: () => new KernelError('subagent_parent_cancelled') }),
    participant(log, 'command', { settle: () => new KernelError('execution_cleanup_pending') }),
  ]);
  await assert.rejects(resources.settle('failed'), (error: unknown) => {
    assert.ok(error instanceof KernelError);
    assert.equal(error.code, 'run_resources_settle_failed');
    assert.equal(error.detail, 'child: subagent_parent_cancelled; command: execution_cleanup_pending');
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });
  assert.deepEqual(log, ['child:settle:failed', 'command:settle:failed']);

  const finishLog: string[] = [];
  const finishing = runResourcesOf([
    participant(finishLog, 'child', { finish: () => new Error('finish_failed') }),
    participant(finishLog, 'command'),
  ]);
  await assert.rejects(finishing.finish(), (error: unknown) => {
    assert.ok(error instanceof KernelError);
    assert.equal(error.code, 'run_resources_finish_failed');
    assert.match(error.detail ?? '', /child: Error/);
    return true;
  });
  assert.deepEqual(finishLog, ['child:finish', 'command:finish']);
});
