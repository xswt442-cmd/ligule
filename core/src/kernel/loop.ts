// 循环负责限制迭代次数和模型请求预算，并使用 AbortSignal 处理取消。
// Host 配置哪些工具会结束本轮；该信息不暴露给模型。
// 提供方通过统一接口接入，服务地址来自配置，凭据通过环境变量解析。
import { KernelError, KernelRuntimeError } from './error.js';
import { usageEvent } from '../session/usage.js';
import { failureOf } from './result.js';
import type { Kernel } from './kernel.js';
import type { PromptAssembly } from './prompt.js';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args?: unknown;
}

export type ModelMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly toolCalls?: readonly ToolCall[]; readonly reasoning?: string }
  | { readonly role: 'tool'; readonly id?: string; readonly tool?: string; readonly content: unknown; readonly failed?: boolean; readonly code?: string };

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ModelRequest {
  readonly system: string;
  readonly tools: readonly ModelTool[];
  readonly messages: readonly ModelMessage[];
}

export type ProviderEvent =
  | { readonly type: 'text' | 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly type: 'usage'; readonly input: number; readonly output: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'tool_calls' | 'length' | 'max_tokens' };

export interface ModelProvider {
  readonly requiresCompletion?: true;
  readonly maxOutputTokens?: number;
  stream(request: ModelRequest, options?: { readonly signal?: AbortSignal }): AsyncIterable<ProviderEvent>;
}

export interface LoopSession {
  append(event: Record<string, unknown>): Promise<unknown>;
  modelView(): Promise<unknown[]>;
}

export interface LoopLimits {
  readonly iterations: number;
  readonly modelCalls: number;
}

export interface LoopCompaction {
  prepare(request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[]>;
  recover(error: unknown, request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[] | null>;
  observe(request: LoopCompactionRequest, events: ProviderEvent[]): Promise<void>;
}

export interface LoopCompactionRequest {
  readonly system: string;
  readonly tools: unknown;
  readonly messages: unknown[];
}

export interface LoopOptions {
  readonly kernel: Kernel;
  readonly provider: ModelProvider;
  readonly prompt?: Pick<PromptAssembly, 'render'>;
  readonly session?: LoopSession;
  readonly limits?: LoopLimits;
  readonly completesRun?: readonly string[];
  readonly compaction?: LoopCompaction | null;
  readonly turnContext?: (() => Record<string, unknown>) | null;
  readonly onProgress?: (event: LoopProgressEvent) => void;
}

export type LoopProgressPhase = 'preparing' | 'model_request' | 'tool_execution' | 'compaction' | 'awaiting_approval' | 'awaiting_input' | 'settling';

export type LoopProgressEvent =
  | { readonly kind: 'phase'; readonly phase: LoopProgressPhase; readonly modelCalls: number; readonly toolCalls: number }
  | { readonly kind: 'activity'; readonly phase: LoopProgressPhase; readonly activity: 'model_output' | 'tool'; readonly modelCalls: number; readonly toolCalls: number };

export interface LoopResult {
  readonly text: string;
  readonly iterations: number;
  readonly modelCalls: number;
  readonly completedBy?: string;
}

export interface LoopRunOptions {
  readonly signal?: AbortSignal;
  readonly user?: Record<string, unknown>;
  readonly onProgress?: (event: LoopProgressEvent) => void;
  readonly completesRun?: readonly string[];
  readonly turnContext?: Record<string, unknown>;
  // 校验通过后才记录成功终态；抛出的领域错误由本轮统一写入失败终态。
  readonly validateCompletion?: () => void;
}

type TurnStatus = 'completed' | 'cancelled' | 'failed';

function sequenceOf(event: unknown): number | undefined {
  return typeof event === 'object' && event !== null && 'seq' in event && typeof event.seq === 'number'
    ? event.seq
    : undefined;
}

function isToolCall(value: unknown): value is ToolCall {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string';
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== 'object' || value === null || !('role' in value)) return false;
  if (value.role === 'user') return 'text' in value && typeof value.text === 'string';
  if (value.role === 'assistant') {
    if (!('text' in value) || typeof value.text !== 'string') return false;
    if ('reasoning' in value && value.reasoning !== undefined && typeof value.reasoning !== 'string') return false;
    return !('toolCalls' in value) || value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall));
  }
  return value.role === 'tool' && (!('id' in value) || value.id === undefined || typeof value.id === 'string') && 'content' in value;
}

function modelMessagesOf(values: readonly unknown[]): ModelMessage[] {
  return values.map((value) => {
    if (!isModelMessage(value)) throw new TypeError('the session model view contains an invalid message');
    return value;
  });
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = Object.freeze({ iterations: 64, modelCalls: 64 });

const TURN_CANCEL_CODES = new Set(['provider_cancelled', 'loop_cancelled', 'ask_user_cancelled']);

function failureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'loop_failed';
  if ('code' in error && typeof error.code === 'string' && error.code !== '') return error.code;
  if ('name' in error && error.name === 'AbortError') return 'provider_cancelled';
  return 'loop_failed';
}

// 连续的并发调用组成一组并同时启动；串行调用各自成组，形成顺序边界。
interface CallGroup {
  readonly parallel: boolean;
  readonly calls: ToolCall[];
}

function groupCalls(calls: readonly ToolCall[], executionOf: (name: string) => 'parallel' | 'serial'): CallGroup[] {
  const groups: CallGroup[] = [];
  for (const call of calls) {
    const parallel = executionOf(call.name) === 'parallel';
    const last = groups[groups.length - 1];
    if (parallel && last?.parallel) last.calls.push(call);
    else groups.push({ parallel, calls: [call] });
  }
  return groups;
}

// 返回指定组中从 `index` 开始尚未执行的调用。
function restOf(groups: readonly CallGroup[], groupIndex: number, index = -1): ToolCall[] {
  return groups.slice(groupIndex).flatMap((group, offset) => group.calls.slice(offset === 0 ? index + 1 : 0));
}

export function createLoop({
  kernel, provider, prompt, session, limits = DEFAULT_LOOP_LIMITS, completesRun = [], compaction = null, turnContext = null, onProgress,
}: LoopOptions) {
  if (typeof provider?.stream !== 'function') throw new KernelError('loop_provider_required');
  const completing = new Set(completesRun);

  return {
    // 为本轮创建独立取消信号，并将取消传递给工具和模型提供方。
    // `options.user` 中的元数据只写入记录；模型仍接收 `input` 中的文本。
    async run(input: string, runOptions: LoopRunOptions = {}): Promise<LoopResult> {
      const { signal, user, onProgress: runProgress, completesRun: runCompletes, turnContext: runTurnContext } = runOptions;
      const progress = runProgress ?? onProgress;
      const completingThisRun = new Set([...completing, ...(runCompletes ?? [])]);
      const controller = new AbortController();
      const forward = () => controller.abort(signal?.reason);
      if (signal?.aborted) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      let calls = 0;
      let toolCallCount = 0;
      let iterations = 0;
      let text = '';
      let phase: LoopProgressPhase = 'preparing';
      let userSeq: number | undefined;
      let terminalAttempted = false;

      // 每个已返回给模型的工具调用都必须有对应结果，否则后续模型请求会因调用未完成而被拒绝。
      // 未执行的调用也要写入错误结果，保持记录结构完整。
      async function answerRemaining(skipped: readonly ToolCall[], content: string): Promise<void> {
        if (!session) return;
        for (const call of skipped) {
          await session.append({
            kind: 'tool', tool: call.name, callId: call.id, args: call.args,
            result: failureOf('tool_skipped', { content }),
          });
        }
      }

      // 将本轮用户输入写入记录，以便之后重建模型上下文。
      // 用户事件序号用于关联轮次完成状态和分支位置。
      // 每轮只写一条可忽略的终态事件；该事件不进入模型投影或检查点哈希。
      async function markTurn(status: TurnStatus, fields: Record<string, unknown> = {}): Promise<void> {
        if (!session || userSeq === undefined || terminalAttempted) return;
        terminalAttempted = true;
        await session.append({
          kind: 'turn', ignorable: true, status, userSeq, iterations, modelCalls: calls, ...fields,
        });
      }

      function reportPhase(next: LoopProgressPhase): void {
        phase = next;
        progress?.({ kind: 'phase', phase, modelCalls: calls, toolCalls: toolCallCount });
      }

      function reportActivity(activity: 'model_output' | 'tool'): void {
        progress?.({ kind: 'activity', phase, activity, modelCalls: calls, toolCalls: toolCallCount });
      }

      try {
        if (session) userSeq = sequenceOf(await session.append({ kind: 'user', text: input, ...user }));
        // 用户事件写入后若快照失败，记录本轮失败终态。Host 在接受输入前失败时没有事件序号，不写终态事件。
        if (session && (turnContext !== null || runTurnContext !== undefined)) {
          await session.append({ kind: 'turnContext', ignorable: true, userSeq, ...(turnContext?.() ?? {}), ...(runTurnContext ?? {}) });
        }
        for (let iteration = 1; iteration <= limits.iterations; iteration += 1) {
          reportPhase('preparing');
          if (calls >= limits.modelCalls) throw new KernelError('loop_model_budget_exhausted');
          iterations = iteration;
          calls += 1;

          const events = [];
          const system = prompt?.render() ?? '';
          const tools = kernel.manifest();
          let messages: unknown[] = session ? await session.modelView() : [{ role: 'user', text: input }];
          // 请求构造完成后、发送前检查上下文压力；超出阈值时压缩一次并重新构造请求。
          if (compaction !== null) messages = await compaction.prepare({ system, tools, messages }, controller.signal);
          // 在流式接收期间逐步组装模型发起的工具调用。
          for (let attempt = 0; ; attempt += 1) {
            try {
              reportPhase('model_request');
              for await (const event of provider.stream({ system, tools, messages: modelMessagesOf(messages) }, { signal: controller.signal })) {
                if (event.type === 'tool-call') toolCallCount += 1;
                if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') reportActivity('model_output');
                events.push(event);
              }
              break;
            } catch (error) {
              // 服务端报告上下文超限后最多压缩并重试一次；无法压缩、已经重试或其他错误都返回原错误。
              const retried = attempt === 0 && compaction !== null
                ? await compaction.recover(error, { system, tools, messages }, controller.signal)
                : null;
              if (retried === null) {
                const partialText = events.flatMap((event) => event.type === 'text' ? [event.text] : []).join('');
                const partialReasoning = events.flatMap((event) => event.type === 'reasoning' ? [event.text] : []).join('');
                const partialCalls = events.flatMap((event) => event.type === 'tool-call'
                  ? [{ id: event.id, name: event.name, args: event.args ?? {} }]
                  : []);
                if (session && (partialText !== '' || partialReasoning !== '' || partialCalls.length > 0)) {
                  if (partialReasoning !== '') await session.append({ kind: 'reasoning', text: partialReasoning });
                  await session.append({ kind: 'assistant', text: partialText, toolCalls: partialCalls,
                    ...(partialReasoning === '' ? {} : { reasoning: partialReasoning }) });
                }
                await answerRemaining(partialCalls, 'the provider response did not finish');
                throw error;
              }
              events.length = 0;
              messages = retried;
            }
          }
          // 使用服务端报告的真实用量校准本地估算，并将用量事件写入记录供界面和恢复读取。
          if (compaction !== null) await compaction.observe({ system, tools, messages }, events);
          else if (session !== undefined) {
            const usage = usageEvent({ system, tools, messages }, events);
            if (usage !== null) await session.append(usage);
          }

          text = events.flatMap((event) => event.type === 'text' ? [event.text] : []).join('');
          const reasoning = events.flatMap((event) => event.type === 'reasoning' ? [event.text] : []).join('');
          const toolCalls = events.flatMap((event) => event.type === 'tool-call'
            ? [{ id: event.id, name: event.name, args: event.args ?? {} }]
            : []);
          // 推理事件写入记录供界面和恢复查看，但不进入模型投影，以免后续请求重复占用上下文。
          if (session && reasoning !== '') await session.append({ kind: 'reasoning', text: reasoning });
          if (session) await session.append({ kind: 'assistant', text, toolCalls, ...(reasoning === '' ? {} : { reasoning }) });
          const finish = events.findLast((event) => event.type === 'finish');
          if (provider.requiresCompletion === true && finish === undefined) {
            await answerRemaining(toolCalls, 'the provider response ended without a completion signal');
            throw new KernelError('provider_stream_incomplete');
          }
          if (finish?.type === 'finish' && (finish.reason === 'length' || finish.reason === 'max_tokens')) {
            await answerRemaining(toolCalls, 'the provider response reached its output limit before completion');
            throw new KernelError('provider_output_exhausted');
          }
          if (toolCalls.length === 0 && text.trim() === '') throw new KernelError('provider_empty_response');
          const validation = toolCalls.map((call) => kernel.validateCall(call.name, call.args));
          const invalidIndex = validation.findIndex((result) => result.code !== undefined);
          if (invalidIndex >= 0) {
            if (session) {
              for (const [index, call] of toolCalls.entries()) {
                const outcome = validation[index];
                await session.append({
                  kind: 'tool', tool: call.name, callId: call.id, args: call.args,
                  result: failureOf(outcome.code ?? 'tool_skipped', {
                    content: outcome.detail ?? 'another call in this response was invalid',
                  }),
                });
              }
            }
            continue;
          }
          if (toolCalls.length === 0) {
            runOptions.validateCompletion?.();
            await markTurn('completed');
            return { text, iterations: iteration, modelCalls: calls };
          }

          reportPhase('tool_execution');
          const groups = groupCalls(toolCalls, (name) => kernel.execution(name));
          for (const [groupIndex, group] of groups.entries()) {
            reportActivity('tool');
            const settled = await Promise.allSettled(
              group.calls.map((call) => kernel.call(call.name, call.args, { signal: controller.signal, callId: call.id })),
            );
            for (const [index, outcome] of settled.entries()) {
              reportActivity('tool');
              // Kernel 已将工具失败转换为稳定错误码并写入记录，因此循环可以将失败结果交给模型继续处理。
              // Kernel 内部故障和意外异常会中止本轮并向上抛出。
              if (outcome.status === 'rejected' && (!(outcome.reason instanceof KernelError) || outcome.reason instanceof KernelRuntimeError)) {
                throw outcome.reason;
              }
              if (outcome.status === 'fulfilled' && completingThisRun.has(group.calls[index].name)) {
                // 结束本轮后，同一条助手消息中剩余的调用不会执行；为每个调用写入未执行结果。
                const name = group.calls[index].name;
                await answerRemaining(restOf(groups, groupIndex, index), `${name} ended this round before this call ran`);
                runOptions.validateCompletion?.();
                await markTurn('completed', { completedBy: name });
                return { text, completedBy: name, iterations: iteration, modelCalls: calls };
              }
            }
            if (controller.signal.aborted) {
              // 两组工具调用之间收到取消时，后续调用虽已由模型提出，但不能再执行。
              // 为其写入未执行结果和原因，避免会话中留下未完成调用。
              await answerRemaining(restOf(groups, groupIndex + 1), 'the run was cancelled before this call ran');
              throw new KernelError('loop_cancelled');
            }
          }
        }
        throw new KernelError('loop_iteration_limit');
      } catch (error) {
        const code = failureCode(error);
        const diagnostics = error instanceof KernelError ? error.diagnostics : undefined;
        await markTurn(TURN_CANCEL_CODES.has(code) ? 'cancelled' : 'failed', {
          code,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        });
        throw error;
      } finally {
        reportPhase('settling');
        signal?.removeEventListener('abort', forward);
      }
    },
  };
}
