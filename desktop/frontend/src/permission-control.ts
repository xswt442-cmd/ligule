import type { Client } from './protocol';
import type { PermissionEnforcement, PermissionNetwork, PermissionProfile, SessionPermission, Status } from './status';

export type PermissionTarget = { profile: PermissionProfile; network: PermissionNetwork };
export type PermissionConfirmation = 'full-access' | 'unrestricted-network' | 'partial-workspace-write' | 'workspace-trust';
export type PermissionConfirmations = { fullAccess: boolean; network: boolean; partialWorkspaceWrite: boolean; workspaceTrust: boolean };

const SAFE_PERMISSION: SessionPermission = Object.freeze({
  profile: 'read-only',
  network: 'policy',
  capabilities: Object.freeze({
    filesystemRead: 'unavailable',
    filesystemWrite: 'unavailable',
    network: 'unavailable',
    process: 'unavailable',
  }),
  profiles: Object.freeze({ readOnly: 'unavailable', workspaceWrite: 'unavailable' }),
  limitations: Object.freeze(['Permission capability status is unavailable.']),
  partialWorkspaceWriteConfirmationRequired: true,
  partialWorkspaceWriteConfirmed: false,
  workspaceTrusted: false,
  execution: Object.freeze({
    available: false,
    code: 'permission_status_unavailable',
    reason: 'permission status is unavailable; changes are disabled',
  }),
  changeAllowed: false,
});

const PROFILES: readonly PermissionProfile[] = ['read-only', 'workspace-write', 'full-access'];
const NETWORKS: readonly PermissionNetwork[] = ['policy', 'unrestricted', 'disabled'];
const ENFORCEMENT: readonly PermissionEnforcement[] = ['full', 'partial', 'unavailable'];

export function permissionOf(status: Status | null): SessionPermission {
  return isSessionPermission(status?.permission) ? status.permission : SAFE_PERMISSION;
}

export function canChangePermission(status: Status | null, running: boolean, busy = false): boolean {
  return status !== null && isSessionPermission(status.permission) && status.permission.changeAllowed
    && !status.running && !running && !busy;
}

export function permissionConfirmations(current: SessionPermission, target: PermissionTarget): PermissionConfirmation[] {
  const required: PermissionConfirmation[] = [];
  if (target.profile === 'full-access' && current.profile !== 'full-access') required.push('full-access');
  if (target.network === 'unrestricted' && current.network !== 'unrestricted') required.push('unrestricted-network');
  if (target.profile === 'workspace-write' && !current.workspaceTrusted) required.push('workspace-trust');
  if (target.profile === 'workspace-write' && current.partialWorkspaceWriteConfirmationRequired
    && !current.partialWorkspaceWriteConfirmed) required.push('partial-workspace-write');
  return required;
}

function permissionRequest(
  status: Status | null,
  target: PermissionTarget,
  confirmed: PermissionConfirmations,
  running: boolean,
): Record<string, unknown> | null {
  if (!canChangePermission(status, running)) throw new Error('permission_change_unavailable');
  const current = permissionOf(status);
  const required = permissionConfirmations(current, target);
  if (required.includes('full-access') && !confirmed.fullAccess) {
    throw new Error('permission_full_access_confirmation_required');
  }
  if (required.includes('unrestricted-network') && !confirmed.network) {
    throw new Error('permission_network_confirmation_required');
  }
  if (required.includes('partial-workspace-write') && !confirmed.partialWorkspaceWrite) {
    throw new Error('permission_partial_sandbox_confirmation_required');
  }
  if (required.includes('workspace-trust') && !confirmed.workspaceTrust) {
    throw new Error('workspace_trust_confirmation_required');
  }
  if (target.profile === current.profile && target.network === current.network) return null;
  return {
    sessionId: status?.sessionId,
    permissionProfile: target.profile,
    permissionNetwork: target.network,
    confirmFullAccess: confirmed.fullAccess,
    confirmNetwork: confirmed.network,
    ...(confirmed.partialWorkspaceWrite ? { confirmPartialWorkspaceWrite: true } : {}),
    ...(confirmed.workspaceTrust ? { confirmWorkspaceTrust: true } : {}),
  };
}

export class PermissionRefreshError extends Error {
  readonly code = 'permission_status_refresh_failed';
  readonly causeCode: string;

  constructor(causeCode: string) {
    super(`permission_status_refresh_failed:${causeCode}`);
    this.causeCode = causeCode;
  }
}

export async function changePermissionAndRefresh(
  client: Client,
  status: Status | null,
  target: PermissionTarget,
  confirmed: PermissionConfirmations,
  running: boolean,
): Promise<Status> {
  const params = permissionRequest(status, target, confirmed, running);
  if (params === null) {
    if (status === null) throw new Error('permission_change_unavailable');
    return status;
  }
  const sessionId = status?.sessionId;
  if (sessionId === undefined) throw new Error('permission_change_unavailable');
  await client.call('permission.set', params, 15_000);

  try {
    return await readPermissionStatus(client, sessionId);
  } catch (error) {
    throw new PermissionRefreshError(errorCode(error));
  }
}

export async function readPermissionStatus(client: Client, sessionId: string): Promise<Status> {
  const next: unknown = await client.call('status.get', { sessionId }, 15_000);
  if (typeof next !== 'object' || next === null || !('sessionId' in next)
    || next.sessionId !== sessionId || !('permission' in next) || !isSessionPermission(next.permission)) {
    throw new Error('permission_status_refresh_invalid');
  }
  return next as Status;
}

function isSessionPermission(value: unknown): value is SessionPermission {
  if (typeof value !== 'object' || value === null) return false;
  const permission = value as Record<string, unknown>;
  const capabilities = permission.capabilities;
  const profiles = permission.profiles;
  const limitations = permission.limitations;
  const execution = permission.execution;
  if (!PROFILES.includes(permission.profile as PermissionProfile)
    || !NETWORKS.includes(permission.network as PermissionNetwork)
    || typeof permission.changeAllowed !== 'boolean'
    || typeof capabilities !== 'object' || capabilities === null
    || typeof execution !== 'object' || execution === null) return false;
  const limits = capabilities as Record<string, unknown>;
  const run = execution as Record<string, unknown>;
  return ENFORCEMENT.includes(limits.filesystemRead as PermissionEnforcement)
    && ENFORCEMENT.includes(limits.filesystemWrite as PermissionEnforcement)
    && ENFORCEMENT.includes(limits.network as PermissionEnforcement)
    && ENFORCEMENT.includes(limits.process as PermissionEnforcement)
    && typeof profiles === 'object' && profiles !== null
    && ENFORCEMENT.includes((profiles as Record<string, unknown>).readOnly as PermissionEnforcement)
    && ENFORCEMENT.includes((profiles as Record<string, unknown>).workspaceWrite as PermissionEnforcement)
    && Array.isArray(limitations) && limitations.every((limitation) => typeof limitation === 'string')
    && typeof permission.partialWorkspaceWriteConfirmationRequired === 'boolean'
    && typeof permission.partialWorkspaceWriteConfirmed === 'boolean'
    && typeof permission.workspaceTrusted === 'boolean'
    && typeof run.available === 'boolean'
    && (run.code === null || typeof run.code === 'string')
    && (run.reason === null || typeof run.reason === 'string');
}

function errorCode(error: unknown): string {
  const shaped = error as { code?: string; message?: string };
  return shaped.code ?? shaped.message ?? String(error);
}
