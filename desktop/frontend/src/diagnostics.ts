import type { DesktopAppInfo } from '../../electron/api';
import type { Status } from './status';

/** Build a copyable support summary without session identifiers, paths, transcript content, or raw logs. */
export function diagnosticSummary({ info, hostNodeVersion, status, connected, counts, waiting, logCount }: {
  info: DesktopAppInfo | null;
  hostNodeVersion: string | null;
  status: Status | null;
  connected: boolean;
  counts: { sent: number; received: number };
  waiting: number;
  logCount: number;
}): string {
  return JSON.stringify({
    application: info === null ? null : {
      name: info.name,
      version: info.version,
      packaged: info.packaged,
      platform: info.platform,
      architecture: info.architecture,
      electronVersion: info.electronVersion,
      build: info.build,
    },
    connection: connected ? 'connected' : 'disconnected',
    hostNodeVersion,
    transport: { sent: counts.sent, received: counts.received, pending: waiting },
    session: status === null ? null : {
      mode: status.mode,
      policy: status.policy,
      permission: status.permission === undefined ? null : {
        profile: status.permission.profile,
        network: status.permission.network,
        capabilities: status.permission.capabilities,
        workspaceTrusted: status.permission.workspaceTrusted,
      },
      denials: status.denials,
      availableToolCount: status.tools.length,
      eventCount: status.eventCount,
    },
    hostLogLineCount: logCount,
  }, null, 2);
}
