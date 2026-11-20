// 一次 Run 结束时需要收口的外部资源：子 Run 与有限命令各自拥有自己的登记表，
// 这里拥有它们共同的生命周期阶段与失败合并，Host 只按阶段调用一次。
export type RunResourceParticipant = {
  /** 关闭新的工作准入：此后再到达的子 Run 或有限命令不再属于这一轮。 */
  readonly beginCompletionCandidate: () => void;
  /** 重新开放准入：完成候选未成立时恢复接收工作。 */
  readonly resume: () => void;
  /** 收口仍在进行的资源：正常完成时等待，失败或取消时先停止再等待。 */
  readonly settle: (status: 'completed' | 'failed' | 'cancelled') => Promise<void>;
  /** 终态写入前的最后收口：停止仍活跃的资源并保留终态记录。 */
  readonly finish: () => Promise<void>;
};

export type RunResources = RunResourceParticipant;

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

async function settleAll(
  participants: readonly RunResourceParticipant[],
  action: (participant: RunResourceParticipant) => Promise<void>,
  code: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(participants.map((participant) => action(participant)));
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
  if (failures.length > 0) throw new AggregateError(failures, code);
}

export function runResourcesOf(participants: readonly RunResourceParticipant[]): RunResources {
  return {
    beginCompletionCandidate: () => applyToAll(participants, (participant) => participant.beginCompletionCandidate()),
    resume: () => applyToAll(participants, (participant) => participant.resume()),
    settle: async (status) => await settleAll(participants, (participant) => participant.settle(status), 'run_resources_settle_failed'),
    finish: async () => await settleAll(participants, (participant) => participant.finish(), 'run_resources_finish_failed'),
  };
}
