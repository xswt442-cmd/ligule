import { KernelError } from './error.js';

// Permission describes resource access for a Session. Policy separately decides
// whether a permitted operation needs approval or must be refused.

export type PermissionProfile = 'read-only' | 'workspace-write' | 'full-access';
export type PermissionNetwork = 'policy' | 'unrestricted' | 'disabled';
export type PermissionEnforcement = 'full' | 'partial' | 'unavailable';
export type PermissionAccess = 'read' | 'write' | 'exec' | 'network' | 'interaction' | 'external' | 'inherit' | 'unknown';

export interface PermissionCapabilities {
  readonly filesystemRead: PermissionEnforcement;
  readonly filesystemWrite: PermissionEnforcement;
  readonly network: PermissionEnforcement;
  readonly process: PermissionEnforcement;
}

export interface PermissionContext {
  readonly profile: PermissionProfile;
  readonly network: PermissionNetwork;
  readonly capabilities: PermissionCapabilities;
}

export interface PermissionDenial {
  readonly code: string;
  readonly reason: string;
}

const PROFILE_VALUES: readonly PermissionProfile[] = ['read-only', 'workspace-write', 'full-access'];
const NETWORK_VALUES: readonly PermissionNetwork[] = ['policy', 'unrestricted', 'disabled'];
const ENFORCEMENT_VALUES: readonly PermissionEnforcement[] = ['full', 'partial', 'unavailable'];
const ACCESS_VALUES: readonly PermissionAccess[] = ['read', 'write', 'exec', 'network', 'interaction', 'external', 'inherit', 'unknown'];

export function isPermissionAccess(value: unknown): value is PermissionAccess {
  return ACCESS_VALUES.includes(value as PermissionAccess);
}

export function createPermissionContext(
  profile: unknown,
  network: unknown,
  capabilities: unknown,
): PermissionContext {
  if (!PROFILE_VALUES.includes(profile as PermissionProfile)) throw new KernelError('permission_profile_invalid');
  if (!NETWORK_VALUES.includes(network as PermissionNetwork)) throw new KernelError('permission_network_mode_invalid');
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new KernelError('permission_capabilities_invalid');
  }
  const record = capabilities as Record<string, unknown>;
  const keys = ['filesystemRead', 'filesystemWrite', 'network', 'process'];
  if (Object.keys(record).length !== keys.length
    || keys.some((key) => !ENFORCEMENT_VALUES.includes(record[key] as PermissionEnforcement))) {
    throw new KernelError('permission_capabilities_invalid');
  }
  return Object.freeze({
    profile: profile as PermissionProfile,
    network: network as PermissionNetwork,
    capabilities: Object.freeze({
      filesystemRead: record.filesystemRead as PermissionEnforcement,
      filesystemWrite: record.filesystemWrite as PermissionEnforcement,
      network: record.network as PermissionEnforcement,
      process: record.process as PermissionEnforcement,
    }),
  });
}

export const DEFAULT_PERMISSION_CONTEXT = createPermissionContext('read-only', 'policy', {
  filesystemRead: 'unavailable', filesystemWrite: 'unavailable', network: 'unavailable', process: 'unavailable',
});

export function permissionDenial(permission: PermissionContext, access: PermissionAccess): PermissionDenial | undefined {
  if (access === 'external' || access === 'unknown') {
    if (permission.profile !== 'full-access') {
      return {
        code: 'permission_external_access_requires_full_access',
        reason: 'this operation runs outside the session sandbox and requires full-access permission',
      };
    }
    if (permission.network !== 'unrestricted') {
      return {
        code: 'permission_external_network_unrestricted_required',
        reason: 'this external process can use the operating system network without the session network controls',
      };
    }
    if (access === 'external' && permission.capabilities.process !== 'full') {
      return { code: 'permission_process_isolation_unavailable', reason: 'this platform cannot isolate and manage the external process tree' };
    }
  }
  if (permission.profile === 'full-access') {
    if (access === 'exec' && permission.network !== 'unrestricted') {
      return {
        code: 'permission_network_isolation_unavailable',
        reason: 'shell network access is limited by session policy, but this platform cannot enforce that restriction',
      };
    }
    if (access === 'exec' && permission.capabilities.process !== 'full') {
      return { code: 'permission_process_isolation_unavailable', reason: 'this platform cannot isolate and manage the command process tree' };
    }
    if (access === 'network' && permission.network === 'disabled') {
      return { code: 'permission_network_denied', reason: 'network access is disabled for this session' };
    }
    return undefined;
  }

  if (access === 'write' && permission.profile === 'read-only') {
    return { code: 'permission_read_only', reason: 'this session only permits reads' };
  }
  if (access === 'network' && permission.network === 'disabled') {
    return { code: 'permission_network_denied', reason: 'network access is disabled for this session' };
  }
  if (access !== 'exec') return undefined;

  const filesystemReady = permission.capabilities.filesystemRead !== 'unavailable'
    && permission.capabilities.filesystemWrite !== 'unavailable';
  if (!filesystemReady) {
    return {
      code: 'permission_sandbox_unavailable',
      reason: permission.profile === 'read-only'
        ? 'this platform cannot enforce the required read-only filesystem access'
        : 'this platform cannot confine writes to the session workspace',
    };
  }
  if (permission.capabilities.process !== 'full') {
    return { code: 'permission_process_isolation_unavailable', reason: 'this platform cannot isolate and manage the command process tree' };
  }
  if (permission.network !== 'unrestricted' && permission.capabilities.network !== 'full') {
    return { code: 'permission_network_isolation_unavailable', reason: 'this platform cannot enforce the session network restriction' };
  }
  return undefined;
}
