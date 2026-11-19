// 子 Run 的建立点：会话记录、运行接受记录与 steering 收件箱一次建成。
//
// 纯构造，不启动执行、不碰工具注册；调用方负责随后的 Kernel/装配与生命周期。
// 这样「一个子 Run 只有一份身份」在结构上成立，预览、启动与恢复都不必各自拼装。
import { createSessionLog, type SessionLog } from '../session/session.js';
import { createRunAcceptance, type RunAcceptance, type RunParentage } from '../session/run.js';
import { createRunSteeringInbox, type RunSteeringInbox } from '../kernel/run-steering.js';
import type { PreparedSubagentRun, SubagentRunArguments } from './subagent-spec.js';

/** 子会话首行携带的模式身份；模式解析完成前可以为空。 */
export interface ChildRunModeIdentity {
  name: string;
  layer: string;
  source?: 'named' | 'inline';
  digest?: string;
  fileDigest?: string;
  tools?: string[];
  prompt?: string[];
}

/** 与 `createRunAcceptance` 的 delegation 参数同形，仅供模型可见摘要使用。 */
export interface ChildRunDelegation {
  readonly parentRunId: string | null;
  readonly parentCallId: string | null;
  readonly mode: unknown;
  readonly presetId?: string;
  readonly presetDigest?: string;
  readonly outputTokens: number | null;
  readonly thinkingEffort: string | null;
  readonly loopIterations: number | null;
  readonly modelCalls: number | null;
  readonly outputSchema: Record<string, unknown> | null;
}

export interface BeginChildRunInput {
  readonly directory: string;
  /** 子会话 ID；持久记录里它就是稳定的 subrun handle。 */
  readonly sessionId: string;
  readonly task: string;
  readonly source: 'human' | 'controller';
  readonly delegation: ChildRunDelegation;
  readonly parentage: RunParentage | undefined;
  readonly meta: () => { readonly projectRoot?: string | undefined; readonly mode?: ChildRunModeIdentity | undefined };
}

export interface BegunChildRun {
  readonly session: SessionLog;
  readonly acceptance: RunAcceptance;
  readonly steering: RunSteeringInbox;
}

/** 接受来源是持久的；控制器的子 Run 不能被记成人类发起。 */
export function childRunCallerScope(source: 'human' | 'controller'): string {
  return source === 'human' ? 'human' : 'controller:subagent';
}

export function beginChildRun(input: BeginChildRunInput): BegunChildRun {
  const session = createSessionLog({ directory: input.directory, id: input.sessionId, meta: input.meta });
  const acceptance = createRunAcceptance(input.sessionId, input.task, input.delegation,
    childRunCallerScope(input.source), undefined, undefined, input.parentage);
  return { session, acceptance, steering: createRunSteeringInbox(session, acceptance.runId) };
}

/** 模型可见的委托摘要：只记录本次真正生效的取值，不做二次解析。 */
export function childRunDelegation(
  args: SubagentRunArguments,
  prepared: PreparedSubagentRun,
  parentRunId: string | undefined,
  parentCallId: string | undefined,
): ChildRunDelegation {
  return {
    parentRunId: parentRunId ?? null,
    parentCallId: parentCallId ?? null,
    mode: prepared.preset === undefined ? args.mode ?? null : prepared.resolvedMode?.application ?? null,
    ...(prepared.preset === undefined ? {} : { presetId: prepared.preset.id, presetDigest: prepared.preset.digest }),
    outputTokens: args.outputTokens ?? null,
    thinkingEffort: args.thinkingEffort ?? null,
    loopIterations: args.loopIterations ?? null,
    modelCalls: args.modelCalls ?? null,
    outputSchema: args.outputSchema ?? null,
  };
}
