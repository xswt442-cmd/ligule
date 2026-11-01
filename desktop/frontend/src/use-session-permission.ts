import { useEffect, useState } from 'react';
import { code, type Client } from './protocol';
import { useText } from './locale';
import type { PermissionConfirmation, PermissionConfirmations, PermissionTarget } from './permission-control';
import { canChangePermission, changePermissionAndRefresh, permissionConfirmations, permissionOf, PermissionRefreshError, readPermissionStatus } from './permission-control';
import type { PermissionNetwork, PermissionProfile, Status } from './status';

export type SessionPermissionEditor = {
  readonly current: PermissionTarget;
  readonly profile: PermissionProfile;
  readonly network: PermissionNetwork;
  readonly setProfile: (profile: PermissionProfile) => void;
  readonly setNetwork: (network: PermissionNetwork) => void;
  readonly canEdit: boolean;
  readonly hasChanges: boolean;
  readonly unavailableStatus: boolean;
  readonly isRunning: boolean;
  readonly busy: boolean;
  readonly failure: string;
  readonly needsRefresh: boolean;
  readonly changeState: string;
  readonly confirmation: PermissionConfirmation | null;
  readonly confirmationTitle: string;
  readonly confirmationCount: number;
  readonly workspaceTrusted: boolean;
  readonly refresh: () => Promise<void>;
  readonly apply: () => void;
  readonly discard: () => void;
  readonly confirmNext: () => void;
  readonly cancelConfirmation: () => void;
  readonly clearFailure: () => void;
};

/**
 * One draft-and-confirm flow for the session permission, shared by the composer
 * popover (profile only) and settings (profile, network, and isolation).
 */
export function useSessionPermission({ client, sessionId, status, initialPermission, initialConfirmations, disabled, running, onInitialChange, onStatus }: {
  client: Client;
  sessionId: string | null;
  status: Status | null;
  initialPermission: PermissionTarget;
  initialConfirmations: PermissionConfirmations;
  disabled: boolean;
  running: boolean;
  onInitialChange: (target: PermissionTarget, confirmations: PermissionConfirmations) => void;
  onStatus: (status: Status) => void;
}): SessionPermissionEditor {
  const t = useText();
  const permission = permissionOf(status);
  const current = sessionId === null ? initialPermission : { profile: permission.profile, network: permission.network };
  const [profile, setProfile] = useState<PermissionProfile>(permission.profile);
  const [network, setNetwork] = useState<PermissionNetwork>(permission.network);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [confirmations, setConfirmations] = useState<PermissionConfirmation[]>([]);
  const [confirmed, setConfirmed] = useState<PermissionConfirmations>({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });

  useEffect(() => {
    setProfile(current.profile);
    setNetwork(current.network);
    setNeedsRefresh(false);
  }, [current.profile, current.network]);

  const target = { profile, network };
  const canEdit = sessionId === null ? !disabled && !busy && !needsRefresh : canChangePermission(status, running, busy || needsRefresh || disabled);
  const hasChanges = profile !== current.profile || network !== current.network;
  const unavailableStatus = sessionId !== null && (status === null || status.permission === undefined || permission.execution.code === 'permission_status_unavailable');
  const isRunning = running || status?.running === true;
  const changeState = busy ? t('正在更新', 'Updating')
    : needsRefresh ? t('需要刷新状态', 'Status refresh required')
      : sessionId === null ? t('创建会话时应用', 'Applied when the conversation starts')
        : isRunning ? t('运行中，暂不可更改', 'Unavailable while running')
          : permission.changeAllowed ? t('允许更改', 'Allowed') : t('不允许更改', 'Not allowed');

  const save = async (confirmationsForChange: PermissionConfirmations) => {
    if (!canEdit) return;
    if (sessionId === null) {
      onInitialChange(target, {
        fullAccess: target.profile === 'full-access' && (confirmationsForChange.fullAccess
          || current.profile === 'full-access' && initialConfirmations.fullAccess),
        network: target.network === 'unrestricted' && (confirmationsForChange.network
          || current.network === 'unrestricted' && initialConfirmations.network),
        partialWorkspaceWrite: target.profile === 'workspace-write' && (confirmationsForChange.partialWorkspaceWrite
          || current.profile === 'workspace-write' && initialConfirmations.partialWorkspaceWrite),
        workspaceTrust: confirmationsForChange.workspaceTrust,
      });
      setNeedsRefresh(false);
      return;
    }
    if (status === null) return;
    setBusy(true);
    setFailure('');
    try {
      const next = await changePermissionAndRefresh(client, status, target, confirmationsForChange, running);
      onStatus(next);
      setNeedsRefresh(false);
    } catch (error) {
      if (error instanceof PermissionRefreshError) {
        setNeedsRefresh(true);
        setFailure(t(`权限已提交，但无法读取最新状态：${error.causeCode}`, `Permission change was submitted, but the latest status could not be read: ${error.causeCode}`));
      } else {
        setFailure(t(`Host 拒绝或无法完成权限更改：${code(error)}`, `Host refused or could not complete the permission change: ${code(error)}`));
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!canEdit || !hasChanges) return;
    const currentPermission = {
      ...permission,
      profile: current.profile,
      network: current.network,
      partialWorkspaceWriteConfirmed: sessionId === null ? initialConfirmations.partialWorkspaceWrite : permission.partialWorkspaceWriteConfirmed,
      workspaceTrusted: permission.workspaceTrusted,
    };
    const required = permissionConfirmations(currentPermission, target);
    setConfirmed({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
    if (required.length === 0) {
      void save({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
      return;
    }
    setConfirmations(required);
  };

  const cancelConfirmation = () => {
    setConfirmations([]);
    setConfirmed({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
  };

  const confirmNext = () => {
    const head = confirmations[0];
    if (head === undefined) return;
    const nextConfirmed = {
      fullAccess: confirmed.fullAccess || head === 'full-access',
      network: confirmed.network || head === 'unrestricted-network',
      partialWorkspaceWrite: confirmed.partialWorkspaceWrite || head === 'partial-workspace-write',
      workspaceTrust: confirmed.workspaceTrust || head === 'workspace-trust',
    };
    const remaining = confirmations.slice(1);
    setConfirmed(nextConfirmed);
    setConfirmations(remaining);
    if (remaining.length === 0) void save(nextConfirmed);
  };

  const refresh = async () => {
    if (sessionId === null) return;
    setBusy(true);
    setFailure('');
    try {
      const next = await readPermissionStatus(client, sessionId);
      onStatus(next);
      setNeedsRefresh(false);
    } catch (error) {
      setFailure(t(`无法刷新权限状态：${code(error)}`, `Could not refresh permission status: ${code(error)}`));
    } finally {
      setBusy(false);
    }
  };

  const confirmation = confirmations[0] ?? null;
  const confirmationTitle = confirmation === 'full-access'
    ? t('确认启用完全访问', 'Confirm full access')
    : confirmation === 'unrestricted-network'
      ? t('确认启用不受限网络', 'Confirm unrestricted network')
      : confirmation === 'partial-workspace-write'
        ? t('确认工作区部分隔离', 'Confirm partial workspace isolation')
        : t('信任此工作区', 'Trust this workspace');

  return {
    current,
    profile,
    network,
    setProfile,
    setNetwork,
    canEdit,
    hasChanges,
    unavailableStatus,
    isRunning,
    busy,
    failure,
    needsRefresh,
    changeState,
    confirmation,
    confirmationTitle,
    confirmationCount: confirmations.length,
    workspaceTrusted: permission.workspaceTrusted,
    refresh,
    apply,
    discard: () => { setProfile(current.profile); setNetwork(current.network); setFailure(''); },
    confirmNext,
    cancelConfirmation,
    clearFailure: () => setFailure(''),
  };
}
