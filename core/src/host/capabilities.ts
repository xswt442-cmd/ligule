import { KernelError } from '../kernel/error.js';

// 外控可信能力的唯一判定表。Host 只在这里把“请求从哪条经过认证的通道来”翻译成能力：
// 可信本地 UI（TUI、Desktop 壳或进程内 control facade），或经过认证的 Agent Control 桥。
// 协议参数、Grant ID、requestKey 或 origin 都不能直接换取能力。

/** 请求到达 Host 的可信通道。 */
export interface ControlTrust {
  /** 该 Host 由可信本地 UI 启动。 */
  readonly permissionControl: boolean;
  /** 请求经过认证的 Agent Control 桥时存在；operator 由 Grant 的 allowOperator 决定。 */
  readonly agentControl?: { readonly operator: boolean };
}

/** 只允许可信本地 UI 使用的能力。 */
export type TrustedUiCapability =
  | 'agent-control'
  | 'mcp-trust'
  | 'settings'
  | 'extensions'
  | 'workspace-trust'
  | 'screen-capture'
  | 'browser'
  | 'storage'
  | 'artifact-native'
  | 'session-export';

const TRUSTED_UI_DENIAL: Record<TrustedUiCapability, string> = {
  'agent-control': 'agent_control_trusted_ui_required',
  'mcp-trust': 'mcp_trust_trusted_ui_required',
  settings: 'settings_catalog_trusted_ui_required',
  extensions: 'extensions_set_trusted_ui_required',
  'workspace-trust': 'workspace_trust_control_unavailable',
  'screen-capture': 'screen_capture_control_unavailable',
  browser: 'browser_control_trusted_ui_required',
  storage: 'storage_control_trusted_ui_required',
  'artifact-native': 'artifact_native_control_required',
  'session-export': 'session_export_trusted_ui_required',
};

/** 仅可信本地 UI 可用的能力：普通 MCP 客户端与桥连接一律拒绝。 */
export function requireTrustedUi(capability: TrustedUiCapability, trust: ControlTrust): void {
  if (trust.permissionControl) return;
  throw new KernelError(TRUSTED_UI_DENIAL[capability]);
}

/** Permission/Profile/Policy 变更能力：可信 UI，或 Grant 允许的桥 operator。 */
export function canChangePermission(trust: ControlTrust): boolean {
  return trust.permissionControl || trust.agentControl?.operator === true;
}

/**
 * 这次连接上能否变更 Permission：可信本地 UI、经过认证的桥连接，或 Grant 允许的 operator。
 * 普通 MCP 客户端与未认证对端永远不能通过。
 */
export function maySetPermission(trust: ControlTrust, bridge: boolean): boolean {
  return canChangePermission(trust) || bridge;
}

/** Permission 变更入口：拒绝时区分“没有可信通道”和“桥不是 operator”。 */
export function requirePermissionControl(trust: ControlTrust): void {
  if (trust.permissionControl) return;
  if (trust.agentControl === undefined) throw new KernelError('permission_control_unavailable');
  if (!trust.agentControl.operator) throw new KernelError('agent_control_operator_required');
}

/**
 * 一次连接可见的 Run 作用域，由可信通道决定，请求参数不能参与。
 * `undefined` 表示全部作用域，只给可信本地 UI（它的连接由 Host 所在进程自己创建）。
 */
export function runScopesOf(trust: ControlTrust, bridge: boolean, controllerScope: string): readonly string[] | undefined {
  if (trust.permissionControl) return undefined;
  return bridge ? ['human', controllerScope] : [controllerScope];
}

/** 只有可信本地 UI 或经过认证的桥连接可以把 Run 记为 human 来源。 */
export function mayRecordHumanRun(trust: ControlTrust, bridge: boolean): boolean {
  return trust.permissionControl || bridge;
}

/** 由已认证 Grant 派生的 controller 作用域；没有 Grant 的本地 controller 使用 `local`。 */
export function controllerScopeOf(grantId: string | undefined): string {
  return 'controller:' + (grantId ?? 'local');
}

// Run 来源证据：写入 Run 接受记录，供 run.receipt 与审计读取。只由 Host 的通道判定产生，
// 任何请求参数都不能指定。

/** 请求到达 Host 的通道。 */
export type RunVia = 'trusted-ui' | 'agent-control-bridge' | 'mcp';

/** Run 被记为 human 的来源依据；controller 来源使用 controller-local/controller-grant。 */
export type RunResolvedBy =
  | 'permission-control'
  | 'agent-control-bridge'
  | 'caller-scope-default'
  | 'controller-local'
  | 'controller-grant';

export function runChannelOf(trust: ControlTrust, bridge: boolean): RunVia {
  if (bridge) return 'agent-control-bridge';
  return trust.permissionControl ? 'trusted-ui' : 'mcp';
}

export function runOriginBasis(trust: ControlTrust, bridge: boolean): RunResolvedBy {
  if (trust.permissionControl) return 'permission-control';
  return bridge ? 'agent-control-bridge' : 'caller-scope-default';
}
