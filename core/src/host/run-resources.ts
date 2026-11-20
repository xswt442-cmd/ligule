// 一次 Run 结束时需要收口的外部资源：子 Run 与有限命令各自拥有自己的登记表，
// 这里拥有它们共同的生命周期阶段、失败合并与失败归属，Host 只按阶段调用一次。
import { KernelError } from '../kernel/error.js';

export type RunResourceParticipant = {
  /** 出现在收口失败诊断里的资源名。 */
  readonly name: string;
  /** 关闭新的工作准入：此后再到达的子 Run 或有限命令不再属于这一轮。 */
  readonly beginCompletionCandidate: () => void;
  /** 重新开放准入：完成候选未成立时恢复接收工作。 */
  readonly resume: () => void;
  /** 收口仍在进行的资源：正常完成时等待，失败或取消时先停止再等待。 */
  readonly settle: (status: 'completed' | 'failed' | 'cancelled') => Promise<void>;
  /** 终态写入前的最后收口：停止仍活跃的资源并保留终态记录。 */
  readonly finish: () => Promise<void>;
};

export type RunResources = Omit<RunResourceParticipant, 'name'>;

class ParticipantFailureError extends Error {
  readonly participant: string;

  constructor(participant: string, error: unknown) {
    super(participant, { cause: error });
    this.name = 'ParticipantFailureError';
    this.participant = participant;
  }
}

// 阶段内的每个资源都必须被执行；同步失败保留第一个原因，异步失败合并成一条领域错误。
function applyToAll(participants: readonly RunResourceParticipant[], action: (participant: RunResourceParticipant) => void): void {
  let failure: unknown;
  let failed = false;
  for (const participant of participants) {
    try {
      action(participant);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && error.code !== '') return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

async function settleAll(
  participants: readonly RunResourceParticipant[],
  action: (participant: RunResourceParticipant) => Promise<void>,
  code: 'run_resources_settle_failed' | 'run_resources_finish_failed',
): Promise<void> {
  // 逆序无关；每个参与者在一个 async 包装里执行，同步抛错也会变成被汇总的拒绝。
  const outcomes = await Promise.allSettled(participants.map(async (participant) => {
    try {
      await action(participant);
    } catch (error) {
      throw new ParticipantFailureError(participant.name, error);
    }
  }));
  const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason as ParticipantFailureError] : []);
  if (failures.length === 0) return;
  throw new KernelError(code, {
    detail: failures.map((failure) => `${failure.participant}: ${codeOf(failure.cause)}`).join('; '),
    cause: new AggregateError(failures.map((failure) => failure.cause), code),
  });
}

export function runResourcesOf(participants: readonly RunResourceParticipant[]): RunResources {
  return {
    beginCompletionCandidate: () => applyToAll(participants, (participant) => participant.beginCompletionCandidate()),
    resume: () => applyToAll(participants, (participant) => participant.resume()),
    settle: async (status) => await settleAll(participants, (participant) => participant.settle(status), 'run_resources_settle_failed'),
    finish: async () => await settleAll(participants, (participant) => participant.finish(), 'run_resources_finish_failed'),
  };
}
