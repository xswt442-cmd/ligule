// 进程资源的所有权：一个作用域（Run、会话、项目、授权）要停止时，有限命令与长运行进程必须一起停止。
//
// 之前每个触发点在 Host 里各自拼“两行调用”，顺序和范围靠记忆保持；忘掉其中一行就会留下
// 未被收回的子进程。这里把每种作用域真正拥有哪些进程资源写在一个地方。
import type { FiniteCommandRegistry, FiniteCommandStopReason } from '../capability/finite-command.js';
import type { ManagedProcessRegistry } from '../capability/managed-process.js';

export interface ProcessOwnerSession {
  readonly id: string;
  readonly managedProcesses: ManagedProcessRegistry;
}

export interface ProcessOwnership {
  /** 结束一个 Run 拥有的进程资源：该 Run 的有限命令与该会话的长运行进程。 */
  stopRun(state: ProcessOwnerSession & { readonly activeRunId?: string }, reason?: FiniteCommandStopReason): Promise<void>;
  /** 权限收窄：会话的长运行进程连同其派生 Operation 会话的有限命令一起停止。 */
  stopAfterPermissionChange(state: ProcessOwnerSession, operationIds: readonly string[]): Promise<void>;
  /** 项目不再受信任：项目内全部有限命令与受影响会话的长运行进程。 */
  stopAfterTrustChange(projectIdentity: string, states: readonly ProcessOwnerSession[]): Promise<void>;
  /** 委托授权被撤销：该授权的有限命令与授予它的会话的长运行进程。 */
  stopAfterGrantRevocation(grantId: string, states: readonly ProcessOwnerSession[]): Promise<void>;
}

export function createProcessOwnership(finite: FiniteCommandRegistry): ProcessOwnership {
  return {
    async stopRun(state, reason = 'run_cancel') {
      if (state.activeRunId !== undefined) await finite.stopRun(state.id, state.activeRunId, reason);
      await state.managedProcesses.stopAll();
    },
    async stopAfterPermissionChange(state, operationIds) {
      await state.managedProcesses.stopAll();
      for (const operationId of operationIds) await finite.stopSession(operationId);
    },
    async stopAfterTrustChange(projectIdentity, states) {
      await Promise.all([
        finite.stopProject(projectIdentity),
        ...states.map(async (state) => await state.managedProcesses.stopWorkspaceTrusted()),
      ]);
    },
    async stopAfterGrantRevocation(grantId, states) {
      await Promise.all([
        finite.stopGrant(grantId),
        ...states.map(async (state) => await state.managedProcesses.stopAll()),
      ]);
    },
  };
}
