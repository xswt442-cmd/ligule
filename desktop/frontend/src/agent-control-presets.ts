/**
 * Mirrors the Host's safe presets for the desktop grant form.
 *
 * The Host (`core/src/host/control-presets.ts`) owns the policy: a preset may only
 * suggest ceilings the Host already enforces, and the limits below are the same ones.
 * This module exists so the desktop can pre-fill the ordinary path (inspect a project,
 * or collaborate on its files) without asking a person to type profiles, network and
 * policy by hand. Anything wider — full access, unrestricted network, Operator, Screen
 * Capture, extra MCP servers or tools — stays on the explicit confirmation path.
 */
import type { NetworkLimit, PermissionProfile, PolicySelection } from './components/agent-control-types';

export type GrantPresetId = 'reader' | 'workspace';

export type GrantPresetLimits = {
  readonly defaultPermissionProfile: PermissionProfile;
  readonly maxPermissionProfile: PermissionProfile;
  readonly defaultNetwork: NetworkLimit;
  readonly maxNetwork: NetworkLimit;
  readonly defaultPolicy: PolicySelection;
  readonly allowedPolicies: readonly PolicySelection[];
};

export type GrantPreset = {
  readonly id: GrantPresetId;
  readonly label: { readonly zh: string; readonly en: string };
  readonly name: { readonly zh: string; readonly en: string };
  readonly description: { readonly zh: string; readonly en: string };
  readonly limits: GrantPresetLimits;
};

const PRESETS: readonly GrantPreset[] = [
  {
    id: 'reader',
    label: { zh: '信任此项目并以只读观察', en: 'Trust this project and observe read-only' },
    name: { zh: '只读观察', en: 'Read-only observer' },
    description: {
      zh: '创建上限为只读的外控授权：控制器只能读取会话与运行结果，不能写文件、执行 Shell、联网或操作其他能力。',
      en: 'Create an Agent Control grant capped at read-only: the controller can read the session and run results, but cannot write files, run Shell, use the network, or operate other capabilities.',
    },
    limits: {
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'read-only',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicies: ['ask'],
    },
  },
  {
    id: 'workspace',
    label: { zh: '信任此项目并以工作区写入协作', en: 'Trust this project with workspace-write' },
    name: { zh: '工作区协作', en: 'Workspace collaborator' },
    description: {
      zh: '创建上限为工作区写入的外控授权；默认仍以只读启动。不含 full-access、不受限网络、Screen Capture 或 Operator。',
      en: 'Create an Agent Control grant with a workspace-write ceiling; runs still start read-only. Excludes full-access, unrestricted network, Screen Capture, and Operator.',
    },
    limits: {
      defaultPermissionProfile: 'read-only',
      maxPermissionProfile: 'workspace-write',
      defaultNetwork: 'policy',
      maxNetwork: 'policy',
      defaultPolicy: 'ask',
      allowedPolicies: ['ask'],
    },
  },
];

export const grantPresets: readonly GrantPreset[] = PRESETS;

export function grantPreset(id: GrantPresetId): GrantPreset {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`unknown grant preset: ${id}`);
  return preset;
}

export type GrantDraftLimits = GrantPresetLimits & {
  readonly allowOperator: boolean;
  readonly allowScreenCapture: boolean;
  readonly confirmScreenCapture: boolean;
  readonly allowedMcpServers: readonly string[];
  readonly allowedMcpTools: readonly string[];
  readonly confirmFullAccess: boolean;
  readonly confirmUnrestrictedNetwork: boolean;
  readonly confirmPartialWorkspaceWrite: boolean;
  readonly confirmWorkspaceTrust: boolean;
};

/**
 * Pre-fills the ceilings a preset may carry and drops everything the preset does not
 * grant: operator replies, Screen Capture and extra MCP servers or tools. Confirmations
 * for wider capabilities are cleared and the project-trust yes is recorded explicitly
 * (creating a grant is itself the human's decision to trust the project), so no
 * confirmation is inherited by accident. Fields the preset does not own — name, expiry,
 * the selected workspace — are left exactly as the person typed them.
 */
export function applyGrantPreset<T extends GrantDraftLimits>(draft: T, id: GrantPresetId): T {
  const { limits } = grantPreset(id);
  return {
    ...draft,
    ...limits,
    allowedPolicies: [...limits.allowedPolicies],
    allowOperator: false,
    allowScreenCapture: false,
    confirmScreenCapture: false,
    allowedMcpServers: [],
    allowedMcpTools: [],
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    confirmPartialWorkspaceWrite: false,
    confirmWorkspaceTrust: true,
  };
}
