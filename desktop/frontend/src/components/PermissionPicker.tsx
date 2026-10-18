import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { PermissionConfirmation, PermissionConfirmations } from '../permission-control';
import { canChangePermission, changePermissionAndRefresh, permissionConfirmations, permissionOf, PermissionRefreshError, readPermissionStatus } from '../permission-control';
import type { PermissionEnforcement, PermissionNetwork, PermissionProfile, SessionPermission, Status } from '../status';
import { Icon } from './Icon';
import { keepEscape, Modal } from './ui';

export function PermissionPicker({ client, sessionId, status, running, onStatus }: {
  client: Client;
  sessionId: string | null;
  status: Status | null;
  running: boolean;
  onStatus: (status: Status) => void;
}) {
  const t = useText();
  const permission = permissionOf(status);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<PermissionProfile>(permission.profile);
  const [network, setNetwork] = useState<PermissionNetwork>(permission.network);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [confirmations, setConfirmations] = useState<PermissionConfirmation[]>([]);
  const [confirmed, setConfirmed] = useState<PermissionConfirmations>({ fullAccess: false, network: false });

  useEffect(() => {
    setProfile(permission.profile);
    setNetwork(permission.network);
    setNeedsRefresh(false);
  }, [permission.profile, permission.network]);

  const target = { profile, network };
  const canEdit = canChangePermission(status, running, busy || needsRefresh);
  const hasChanges = profile !== permission.profile || network !== permission.network;
  const unavailableStatus = status === null || status.permission === undefined || permission.execution.code === 'permission_status_unavailable';
  const isRunning = running || status?.running === true;
  const changeState = busy ? t('正在更新', 'Updating')
    : needsRefresh ? t('需要刷新状态', 'Status refresh required')
      : isRunning ? t('运行中，暂不可更改', 'Unavailable while running')
        : permission.changeAllowed ? t('允许更改', 'Allowed') : t('不允许更改', 'Not allowed');

  const save = async (confirmationsForChange: PermissionConfirmations) => {
    if (!canEdit || status === null) return;
    setBusy(true);
    setFailure('');
    try {
      const next = await changePermissionAndRefresh(client, status, target, confirmationsForChange, running);
      onStatus(next);
      setNeedsRefresh(false);
      setOpen(false);
    } catch (error) {
      if (error instanceof PermissionRefreshError) {
        setNeedsRefresh(true);
        setFailure(t(`权限已提交，但无法读取最新状态：${error.causeCode}`, `Permission change was submitted, but the latest status could not be read: ${error.causeCode}`));
      } else {
        setFailure(t(`Host 拒绝或无法完成权限更改：${code(error)}`, `Host refused or could not complete the permission change: ${code(error)}`));
      }
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!canEdit || !hasChanges) return;
    const required = permissionConfirmations(permission, target);
    setConfirmed({ fullAccess: false, network: false });
    if (required.length === 0) {
      void save({ fullAccess: false, network: false });
      return;
    }
    setConfirmations(required);
    setOpen(false);
  };

  const cancelConfirmation = () => {
    setConfirmations([]);
    setConfirmed({ fullAccess: false, network: false });
    setOpen(true);
  };

  const confirmNext = () => {
    const current = confirmations[0];
    if (current === undefined) return;
    const nextConfirmed = {
      fullAccess: confirmed.fullAccess || current === 'full-access',
      network: confirmed.network || current === 'unrestricted-network',
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
    : t('确认启用不受限网络', 'Confirm unrestricted network');

  return <>
    <Popover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next && status !== null) {
        setProfile(permission.profile);
        setNetwork(permission.network);
        setFailure('');
      }
    }}>
      <Popover.Trigger asChild>
        <button type="button" className="composer-choice permission-trigger" disabled={sessionId === null || status === null || busy}
          title={t('当前会话的操作系统权限', 'Operating-system permissions for this session')}>
          <Icon name="shield" size={14} /><span>{t('权限', 'Permissions')} · {profileLabel(permission.profile, t)}</span><Icon name="fold" size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="permission-panel" side="top" align="start" sideOffset={8}
          aria-label={t('会话权限', 'Session permissions')} aria-describedby={undefined} onEscapeKeyDown={keepEscape}>
          <div className="permission-head">
            <strong>{t('会话权限', 'Session permissions')}</strong>
            <Popover.Close asChild><button className="icon-button" type="button" aria-label={t('收起权限', 'Close permissions')}>&times;</button></Popover.Close>
          </div>
          <p className="permission-note">{t(
            '权限限制会话可访问的操作系统资源。Policy 审批规则单独生效。',
            'Permissions limit the operating-system resources this session can access. Policy approval rules remain separate.',
          )}</p>

          <div className="permission-current">
            <span>{t('当前会话', 'Current session')}</span>
            <strong>{profileLabel(permission.profile, t)} · {networkLabel(permission.network, t)}</strong>
          </div>
          <div className="permission-change-state">
            <span>{t('权限更改', 'Permission changes')}</span>
            <strong>{changeState}</strong>
          </div>

          <div className="permission-fields">
            <label>
              <span>{t('文件与命令', 'Files and commands')}</span>
              <select aria-label={t('文件与命令权限', 'File and command permission')} value={profile} disabled={!canEdit}
                onChange={(event) => setProfile(event.target.value as PermissionProfile)}>
                <option value="read-only">{profileLabel('read-only', t)}</option>
                <option value="workspace-write">{profileLabel('workspace-write', t)}</option>
                <option value="full-access">{profileLabel('full-access', t)}</option>
              </select>
            </label>
            <label>
              <span>{t('网络访问', 'Network access')}</span>
              <select aria-label={t('网络访问权限', 'Network access permission')} value={network} disabled={!canEdit}
                onChange={(event) => setNetwork(event.target.value as PermissionNetwork)}>
                <option value="policy">{networkLabel('policy', t)}</option>
                <option value="disabled">{networkLabel('disabled', t)}</option>
                <option value="unrestricted">{networkLabel('unrestricted', t)}</option>
              </select>
            </label>
          </div>

          <div className="permission-capabilities" aria-label={t('平台隔离能力', 'Platform sandbox capabilities')}>
            <strong>{t('平台隔离能力', 'Platform sandbox capabilities')}</strong>
            <Capability label={t('读取文件', 'File reads')} value={permission.capabilities.filesystemRead} />
            <Capability label={t('写入文件', 'File writes')} value={permission.capabilities.filesystemWrite} />
            <Capability label={t('网络隔离', 'Network isolation')} value={permission.capabilities.network} />
            <Capability label={t('进程隔离', 'Process isolation')} value={permission.capabilities.process} />
          </div>

          <div className="permission-execution" role="status">
            <strong>{t('命令执行', 'Command execution')}: {permission.execution.available ? t('可用', 'Available') : t('不可用', 'Unavailable')}</strong>
            {!permission.execution.available && <p>{executionReason(permission, t)}</p>}
          </div>

          {unavailableStatus && <p className="permission-note" role="status">{t(
            '无法读取 Host 的权限状态。界面按只读处理，并禁用更改。',
            'The Host permission status is unavailable. This session is treated as read-only and changes are disabled.',
          )}</p>}
          {isRunning && <p className="permission-note" role="status">{t('会话运行期间不能更改权限。', 'Permissions cannot change while this session is running.')}</p>}
          {!unavailableStatus && !permission.changeAllowed && <p className="permission-note" role="status">{t(
            permission.changeReason === 'permission_extension_restart_required'
              ? '当前会话仍加载着扩展代码，Host 不能在同一进程内安全降低权限。先禁用扩展并重启 Host，再更改权限。'
              : permission.changeReason === 'permission_session_running'
                ? '会话运行期间不能更改权限。'
                : '此连接不允许更改会话权限。',
            permission.changeReason === 'permission_extension_restart_required'
              ? 'Extensions are still loaded in this Host process, so it cannot safely lower permissions in place. Disable the extensions and restart Host before changing permissions.'
              : permission.changeReason === 'permission_session_running'
                ? 'Permissions cannot change while the session is running.'
                : 'This connection does not allow session permission changes.',
          )}</p>}
          {failure !== '' && <p className="permission-failure" role="alert">{failure}</p>}
          {needsRefresh && <button type="button" disabled={busy} onClick={() => void refresh()}>{t('刷新权限状态', 'Refresh permission status')}</button>}

          <div className="permission-actions">
            <button type="button" disabled={!hasChanges || busy} onClick={() => { setProfile(permission.profile); setNetwork(permission.network); setFailure(''); }}>{t('放弃更改', 'Discard changes')}</button>
            <button type="button" className="primary-button" disabled={!canEdit || !hasChanges} onClick={apply}>
              {busy ? t('正在更改…', 'Updating…') : t('应用更改', 'Apply changes')}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>

    {confirmation !== null && <Modal title={confirmationTitle} className="confirm" onClose={cancelConfirmation}>
      <h2 className="confirm-lead">{confirmation === 'full-access'
        ? t('此会话将获得完全访问权限。', 'This session will receive full-access permission.')
        : t('此会话将使用不受限网络。', 'This session will use unrestricted network access.')}</h2>
      <p className="confirm-note">{confirmation === 'full-access'
        ? t('完全访问会放宽会话的操作系统资源限制。若加载扩展，它们会作为可信代码直接运行；扩展直接调用操作系统能力时不经过 Policy 或危险命令拒绝。', 'Full access relaxes the session’s operating-system resource restrictions. Loaded extensions run as trusted code; direct operating-system calls from extensions do not pass through Policy or dangerous-command denials.')
        : t('不受限网络允许 Shell、MCP 服务器和扩展使用当前 OS 用户可访问的网络。内置网络工具仍按 Policy 判定。', 'Unrestricted network lets Shell, MCP servers, and extensions use the network available to this OS user. Built-in network tools remain subject to Policy.')}</p>
      <div className="confirm-actions">
        <button type="button" onClick={cancelConfirmation}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" onClick={confirmNext}>
          {confirmations.length > 1 ? t('继续确认', 'Continue') : t('确认并应用', 'Confirm and apply')}
        </button>
      </div>
    </Modal>}
  </>;
}

function Capability({ label, value }: { label: string; value: PermissionEnforcement }) {
  const t = useText();
  return <div><span>{label}</span><span data-level={value}>{enforcementLabel(value, t)}</span></div>;
}

function profileLabel(profile: PermissionProfile, t: (chinese: string, english: string) => string): string {
  if (profile === 'read-only') return t('只读', 'Read only');
  if (profile === 'workspace-write') return t('工作区可写', 'Workspace write');
  return t('完全访问', 'Full access');
}

function networkLabel(network: PermissionNetwork, t: (chinese: string, english: string) => string): string {
  if (network === 'policy') return t('按策略限制', 'Policy controlled');
  if (network === 'unrestricted') return t('不受限', 'Unrestricted');
  return t('禁用', 'Disabled');
}

function enforcementLabel(value: PermissionEnforcement, t: (chinese: string, english: string) => string): string {
  if (value === 'full') return t('完整', 'Full');
  if (value === 'partial') return t('部分', 'Partial');
  return t('不可用', 'Unavailable');
}

function executionReason(permission: SessionPermission, t: (chinese: string, english: string) => string): string {
  switch (permission.execution.code) {
    case 'permission_sandbox_unavailable': return t('此平台无法将写入限制在会话工作区内。', 'This platform cannot confine writes to the session workspace.');
    case 'permission_process_isolation_unavailable': return t('此平台无法隔离并管理命令的进程树。', 'This platform cannot isolate and manage the command process tree.');
    case 'permission_network_isolation_unavailable': return t('此平台无法执行当前会话的网络限制。', 'This platform cannot enforce the current session network restriction.');
    case 'permission_status_unavailable': return t('无法读取 Host 提供的执行能力状态。', 'The Host execution capability status is unavailable.');
    default: return permission.execution.reason ?? permission.execution.code ?? t('Host 未提供原因。', 'The Host did not provide a reason.');
  }
}
