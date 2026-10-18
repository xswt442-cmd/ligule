import type { Client } from './protocol';
import type { PermissionEnforcement, PermissionNetwork, PermissionProfile, SessionPermission, Status } from './status';

export type PermissionTarget = { profile: PermissionProfile; network: PermissionNetwork };
export type PermissionConfirmation = 'full-access' | 'unrestricted-network';
export type PermissionConfirmations = { fullAccess: boolean; network: boolean };

const SAFE_PERMISSION: SessionPermission = Object.freeze({
  profile: 'read-only',
  network: 'policy',
  capabilities: Object.freeze({
    filesystemRead: 'unavailable',
    filesystemWrite: 'unavailable',
    network: 'unavailable',
    process: 'unavailable',
  }),
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
  if (target.profile === current.profile && target.network === current.network) return null;
  return {
    sessionId: status?.sessionId,
    permissionProfile: target.profile,
    permissionNetwork: target.network,
    confirmFullAccess: confirmed.fullAccess,
    confirmNetwork: confirmed.network,
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
    && typeof run.available === 'boolean'
    && (run.code === null || typeof run.code === 'string')
    && (run.reason === null || typeof run.reason === 'string');
}

function errorCode(error: unknown): string {
  const shaped = error as { code?: string; message?: string };
  return shaped.code ?? shaped.message ?? String(error);
}
