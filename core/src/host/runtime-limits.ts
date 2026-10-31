import { KernelError } from '../kernel/error.js';
import type { TaskBudgetLimits } from '../kernel/task-budget.js';
import { DEFAULT_LOOP_LIMITS, MAX_PARALLEL_TOOLS, type LoopLimits } from '../kernel/loop.js';
import { limitsOf, type CapabilityConfig } from '../capability/limits.js';
import { resultLimit } from '../kernel/result.js';

type RuntimeLimitConfig = CapabilityConfig & { readonly loop?: unknown };

export interface SessionLoopLimitState {
  readonly loopIterations: number;
  readonly loopModelCalls: number;
  readonly loopMaxParallelTools: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Host 把配置中的循环限制验证成一次运行可用的值，避免缺省上限造成无限循环。
export function loopLimitsOf(config: RuntimeLimitConfig): LoopLimits & { readonly maxParallelTools: number } {
  const limits = { ...DEFAULT_LOOP_LIMITS, ...(isRecord(config.loop) ? config.loop : {}) };
  const positiveInteger = (value: unknown, key: 'iterations' | 'modelCalls' | 'maxParallelTools'): number => {
    const maximum = key === 'maxParallelTools' ? MAX_PARALLEL_TOOLS : Number.MAX_SAFE_INTEGER;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new KernelError('host_loop_limits_invalid', { detail: `${key} must be an integer between 1 and ${maximum}` });
    }
    return value;
  };
  return {
    iterations: positiveInteger(limits.iterations, 'iterations'),
    modelCalls: positiveInteger(limits.modelCalls, 'modelCalls'),
    maxParallelTools: positiveInteger(limits.maxParallelTools, 'maxParallelTools'),
  };
}

export function sessionLoopLimits(state: SessionLoopLimitState): LoopLimits {
  return {
    get iterations() { return state.loopIterations; },
    get modelCalls() { return state.loopModelCalls; },
    get maxParallelTools() { return state.loopMaxParallelTools; },
  };
}

export function taskLimitsOf(config: RuntimeLimitConfig, modelCalls: number, requested?: Partial<TaskBudgetLimits>): TaskBudgetLimits {
  const loop = isRecord(config.loop) ? config.loop : {};
  const limits = { maxModelCalls: loop.totalModelCalls ?? modelCalls, timeoutMs: loop.taskTimeoutMs ?? 1_800_000,
    requestTimeoutMs: loop.requestTimeoutMs ?? 120_000, interactionWaitTimeoutMs: loop.interactionWaitTimeoutMs ?? 43_200_000 };
  const check = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
  if (!check(limits.maxModelCalls, Number.MAX_SAFE_INTEGER) || !check(limits.timeoutMs, 86_400_000)
    || !check(limits.requestTimeoutMs, Math.min(limits.timeoutMs, 3_600_000)) || !check(limits.interactionWaitTimeoutMs, 604_800_000)) throw new KernelError('task_budget_invalid');
  if (requested !== undefined && (!isRecord(requested) || Object.keys(requested).some(key => !['maxModelCalls', 'timeoutMs', 'requestTimeoutMs', 'interactionWaitTimeoutMs'].includes(key)))) {
    throw new KernelError('task_budget_invalid');
  }
  const timeoutMs = requested?.timeoutMs ?? limits.timeoutMs;
  const effective: TaskBudgetLimits = { maxModelCalls: requested?.maxModelCalls ?? limits.maxModelCalls, timeoutMs,
    requestTimeoutMs: requested?.requestTimeoutMs ?? Math.min(limits.requestTimeoutMs, timeoutMs),
    interactionWaitTimeoutMs: requested?.interactionWaitTimeoutMs ?? limits.interactionWaitTimeoutMs };
  if (!check(effective.maxModelCalls, limits.maxModelCalls) || !check(effective.timeoutMs, limits.timeoutMs)
    || !check(effective.requestTimeoutMs, Math.min(limits.requestTimeoutMs, effective.timeoutMs))
    || !check(effective.interactionWaitTimeoutMs, limits.interactionWaitTimeoutMs)) throw new KernelError('task_budget_exceeds_limit');
  return effective;
}

// Compression thresholds combine the selected model window with workspace caps and the shared result-size limit.
export function compactionLimitsOf(config: RuntimeLimitConfig, selectedContextTokens?: unknown, selectedOutputTokens?: unknown) {
  const limits = limitsOf(config);
  const contextTokens = selectedContextTokens ?? limits.contextTokens;
  if (contextTokens === undefined) return undefined;
  if (typeof contextTokens !== 'number' || !Number.isSafeInteger(contextTokens) || contextTokens <= 0) {
    throw new KernelError('host_compaction_limits_invalid', { detail: `contextTokens must be a positive safe integer, got ${JSON.stringify(contextTokens)}` });
  }
  const compactThresholdRatio = limits.compactThresholdRatio;
  const compactRetainRatio = limits.compactRetainRatio;
  if (typeof compactThresholdRatio !== 'number' || !(compactThresholdRatio > 0)) {
    throw new KernelError('host_compaction_limits_invalid', { detail: 'compactThresholdRatio must be a positive number' });
  }
  if (typeof compactRetainRatio !== 'number' || !(compactRetainRatio > 0)) {
    throw new KernelError('host_compaction_limits_invalid', { detail: 'compactRetainRatio must be a positive number' });
  }
  if (compactThresholdRatio > 1 || compactRetainRatio >= compactThresholdRatio) {
    throw new KernelError('host_compaction_limits_invalid', {
      detail: `compactRetainRatio (${compactRetainRatio}) must be below compactThresholdRatio (${compactThresholdRatio}), and the threshold must be at most 1`,
    });
  }
  const outputTokens = selectedOutputTokens;
  return {
    contextTokens,
    compactThresholdRatio,
    compactRetainRatio,
    ...(typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens > 0 ? { outputTokens } : {}),
    resultBytes: resultLimit(config),
  };
}
