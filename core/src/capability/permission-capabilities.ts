import {
  createPermissionContext,
  type PermissionCapabilities,
  type PermissionContext,
} from '../kernel/permission.js';
import {
  probeLinuxSandboxIsolation,
  type LinuxSandboxProbeResult,
} from './sandbox-linux.js';

export interface PermissionCapabilitySnapshot {
  readonly backend: 'bubblewrap' | 'unavailable';
  readonly capabilities: PermissionCapabilities;
  readonly limitations: readonly string[];
  readonly reason?: string;
}

export interface PermissionCapabilityProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly probeLinux?: () => Promise<LinuxSandboxProbeResult>;
  readonly probeLinuxProcessOwnership?: () => Promise<boolean>;
  readonly probeWindowsProcessOwnership?: () => Promise<boolean>;
}

const UNAVAILABLE_CAPABILITIES: PermissionCapabilities = Object.freeze({
  filesystemRead: 'unavailable',
  filesystemWrite: 'unavailable',
  network: 'unavailable',
  process: 'unavailable',
});

function unavailableSnapshot(reason: string): PermissionCapabilitySnapshot {
  return Object.freeze({
    backend: 'unavailable',
    capabilities: UNAVAILABLE_CAPABILITIES,
    limitations: Object.freeze([reason]),
    reason,
  });
}

export async function detectPermissionCapabilities(
  options: PermissionCapabilityProbeOptions = {},
): Promise<PermissionCapabilitySnapshot> {
  const platform = options.platform ?? process.platform;
  let processOwnership = false;
  try {
    if (platform === 'linux') {
      processOwnership = await (options.probeLinuxProcessOwnership ?? probeLinuxProcessOwnership)();
    } else if (platform === 'win32') {
      processOwnership = await (options.probeWindowsProcessOwnership ?? probeWindowsProcessOwnership)();
    }
  } catch {
    processOwnership = false;
  }

  if (platform !== 'linux') {
    const reason = `no OS sandbox backend is available for ${platform}`;
    return Object.freeze({
      ...unavailableSnapshot(reason),
      capabilities: Object.freeze({ ...UNAVAILABLE_CAPABILITIES, process: processOwnership ? 'full' : 'unavailable' }),
      limitations: Object.freeze([
        reason,
        ...(processOwnership ? ['Job Object APIs loaded; process assignment is verified when the Guardian starts.'] : []),
        ...(processOwnership ? [] : ['the command process ownership backend is unavailable']),
      ]),
    });
  }

  let result: LinuxSandboxProbeResult;
  try {
    result = await (options.probeLinux ?? probeLinuxSandboxIsolation)();
  } catch (error) {
    result = { available: false, reason: `Linux sandbox capability probe failed: ${(error as Error).message}` };
  }
  if (!result.available) {
    const snapshot = unavailableSnapshot(result.reason);
    return Object.freeze({
      ...snapshot,
      capabilities: Object.freeze({ ...UNAVAILABLE_CAPABILITIES, process: processOwnership ? 'full' : 'unavailable' }),
      limitations: Object.freeze([
        result.reason,
        ...(processOwnership ? [] : ['Linux child subreaper support is unavailable']),
      ]),
    });
  }

  return Object.freeze({
    backend: 'bubblewrap',
    capabilities: Object.freeze({
      filesystemRead: 'partial',
      filesystemWrite: 'partial',
      network: 'full',
      process: processOwnership ? 'full' : 'unavailable',
    }),
    limitations: Object.freeze([
      'Filesystem reads remain partial because readable host operating-system files are still visible outside the workspace.',
      'Filesystem writes remain partial because hard-link checks and workspace mount validation cannot prevent a concurrent same-user host process from racing them.',
      'Network isolation is full only for disabling Shell network access; destination-based network allowlists are not enforced inside the sandbox.',
      'Process isolation uses a PID namespace and parent-death cleanup, but does not impose CPU, memory, or process-count limits.',
      ...(processOwnership ? [] : ['Linux child subreaper support is unavailable for direct command execution.']),
    ]),
  });
}

async function probeLinuxProcessOwnership(): Promise<boolean> {
  try {
    const koffi = (await import('koffi')).default;
    const libc = koffi.load('libc.so.6');
    const getChildSubreaper = libc.func('prctl', 'int', [
      'int', koffi.out(koffi.pointer('int')), 'uintptr_t', 'uintptr_t', 'uintptr_t',
    ]) as (option: number, value: Array<number | null>, arg3: number, arg4: number, arg5: number) => number;
    const value: Array<number | null> = [null];
    return getChildSubreaper(37, value, 0, 0, 0) === 0 && (value[0] === 0 || value[0] === 1);
  } catch {
    return false;
  }
}

async function probeWindowsProcessOwnership(): Promise<boolean> {
  try {
    const koffi = (await import('koffi')).default;
    const kernel = koffi.load('kernel32.dll');
    kernel.func('__stdcall', 'CreateJobObjectW', 'intptr', ['void*', 'str16']);
    kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['intptr', 'int', 'void*', 'uint32_t']);
    kernel.func('__stdcall', 'GetCurrentProcess', 'intptr', []);
    kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['intptr', 'intptr']);
    kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    kernel.func('__stdcall', 'GetLastError', 'uint32_t', []);
    return true;
  } catch {
    return false;
  }
}

export async function createInteractivePermissionContext(
  options: PermissionCapabilityProbeOptions = {},
): Promise<PermissionContext> {
  const snapshot = await detectPermissionCapabilities(options);
  return createPermissionContext('read-only', 'policy', snapshot.capabilities);
}
