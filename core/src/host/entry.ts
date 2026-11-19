import { KernelError } from '../kernel/error.js';
import {
  operationSessionDenial,
  requireTrustedUi,
  type ControlTrust,
  type TrustedUiCapability,
} from './capabilities.js';

// 入口声明：整方法级别的准入事实只在 dispatch 前判定一次，业务分支不再重复写 if。
// 只收录“整个方法都要求”的条件；依赖请求参数的条件（首次工作区信任确认、产物解析、
// Operation Session 取消自己那条命令）留在对应分支里，并在 tests/entry.test.ts 里列明。

/** 只允许可信本地 UI 调用的方法，以及它对应的能力。 */
export const ENTRY_TRUSTED_UI: ReadonlyMap<string, TrustedUiCapability> = new Map<string, TrustedUiCapability>([
  ['workspace.trust', 'workspace-trust'],
  ['session.side.create', 'side-session'],
  ['view.request.ack', 'view-request'],
  ['screen-capture.set', 'screen-capture'],
  ['browser.stop', 'browser'],
  ['browser.resume', 'browser'],
  ['session.export', 'session-export'],
  ['storage.inspect', 'storage'],
  ['storage.cleanup.preview', 'storage'],
  ['storage.cleanup.apply', 'storage'],
  ['operation.start', 'operation-run'],
  ['usage.diagnostics', 'request-diagnostics'],
  ['agent-control.list', 'agent-control'],
  ['agent-control.create', 'agent-control'],
  ['agent-control.revoke', 'agent-control'],
  ['mcp.trust.list', 'mcp-trust'],
  ['mcp.trust.set', 'mcp-trust'],
  ['mcp.trust.tools', 'mcp-trust'],
  ['settings.catalog', 'settings'],
  ['extensions.set', 'extensions'],
]);

/** 分发前的统一准入上下文；只由 Host 的通道判定与会话状态产生。 */
export interface EntryContext {
  readonly method: string;
  readonly trust: ControlTrust;
  /** 目标会话是一次命令的记录与控制载体（Operation Session）。 */
  readonly operationSession: boolean;
}

/**
 * 方法级准入：
 * 1. Operation Session 只能调用能力表内的命令记录与控制方法；
 * 2. 整方法要求可信本地 UI 的能力在这里拒绝。
 * 顺序保持“先会话形态、后通道能力”，这样 Operation Session 拿到的是它自己的拒绝码。
 */
export function admitEntry(context: EntryContext): void {
  if (context.operationSession) {
    const denial = operationSessionDenial(context.method);
    if (denial !== undefined) {
      throw new KernelError(denial, {
        detail: `an operation session does not carry the capability for ${context.method}`,
      });
    }
  }
  const capability = ENTRY_TRUSTED_UI.get(context.method);
  if (capability !== undefined) requireTrustedUi(capability, context.trust);
}
