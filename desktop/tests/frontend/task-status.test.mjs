import assert from 'node:assert/strict';
import test from 'node:test';
import { taskSummaryLabelOf, taskSummaryOf } from '../../frontend/src/status.ts';

const task = (overrides = {}) => ({
  modelCalls: 3,
  maxModelCalls: 12,
  timeoutMs: 60_000,
  requestTimeoutMs: 10_000,
  interactionWaitTimeoutMs: 30_000,
  interactionWaitMs: 5_000,
  executionElapsedMs: 30_000,
  executionPaused: false,
  startedAt: '2026-10-31T00:00:00.000Z',
  deadlineAt: '2026-10-31T00:00:30.000Z',
  ...overrides,
});

test('task summary advances the execution deadline and model usage while active', () => {
  const summary = taskSummaryOf(task(), undefined, {
    phase: 'model_request', startedAt: 1_000, phaseStartedAt: 1_000,
    lastProgressAt: 9_000, modelCalls: 4, toolCalls: 0, outputTokens: null,
  }, 1_000, 11_000);

  assert.deepEqual(summary, {
    modelCalls: 4,
    maxModelCalls: 12,
    executionRemainingMs: 20_000,
    interactionWaitMs: 5_000,
    interactionWaitTimeoutMs: 30_000,
    executionPaused: false,
  });
});

test('an interaction phase advances wait but does not imply the whole run is paused', () => {
  const summary = taskSummaryOf(task(), undefined, {
    phase: 'awaiting_approval', startedAt: 1_000, phaseStartedAt: 8_000,
    lastProgressAt: 8_000, modelCalls: 3, toolCalls: 1, outputTokens: null,
  }, 1_000, 11_000);

  assert.deepEqual(summary, {
    modelCalls: 3,
    maxModelCalls: 12,
    executionRemainingMs: 20_000,
    interactionWaitMs: 8_000,
    interactionWaitTimeoutMs: 30_000,
    executionPaused: false,
  });
});

test('a fresh paused snapshot does not count already observed wait twice', () => {
  const summary = taskSummaryOf(task({ executionPaused: true, executionElapsedMs: 37_000, interactionWaitMs: 8_000 }), undefined, {
    phase: 'awaiting_input', startedAt: 1_000, phaseStartedAt: 8_000,
    lastProgressAt: 8_000, modelCalls: 3, toolCalls: 1, outputTokens: null,
  }, 9_000, 11_000);

  assert.deepEqual(summary, {
    modelCalls: 3,
    maxModelCalls: 12,
    executionRemainingMs: 23_000,
    interactionWaitMs: 10_000,
    interactionWaitTimeoutMs: 30_000,
    executionPaused: true,
  });
});

test('a refreshed active snapshot resumes deadline projection after interaction', () => {
  const summary = taskSummaryOf(task({ executionPaused: false, executionElapsedMs: 37_000, interactionWaitMs: 8_000 }), undefined, {
    phase: 'tool_execution', startedAt: 1_000, phaseStartedAt: 10_000,
    lastProgressAt: 10_000, modelCalls: 3, toolCalls: 1, outputTokens: null,
  }, 9_000, 11_000);

  assert.equal(summary?.executionPaused, false);
  assert.equal(summary?.executionRemainingMs, 21_000);
  assert.equal(summary?.interactionWaitMs, 8_000);
});

test('task summary labels include model use, remaining execution, interaction wait, and pause in both locales', () => {
  const summary = {
    modelCalls: 4,
    maxModelCalls: 12,
    executionRemainingMs: 65_000,
    interactionWaitMs: 9_000,
    interactionWaitTimeoutMs: 30_000,
    executionPaused: true,
  };
  assert.equal(taskSummaryLabelOf(summary, 'zh'), '4/12 次模型调用 · 执行剩余 1分5秒 · 累计交互等待 9秒/30秒 · 执行期限已暂停');
  assert.equal(taskSummaryLabelOf(summary, 'en'), '4/12 model calls · execution left 1m 5s · interaction wait 9s/30s · deadline paused');
});
