import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import type { PermissionConfirmation, PermissionConfirmations, PermissionTarget } from '../permission-control';
import { canChangePermission, changePermissionAndRefresh, permissionConfirmations, permissionOf, PermissionRefreshError, readPermissionStatus } from '../permission-control';
import type { PermissionEnforcement, PermissionNetwork, PermissionProfile, Status } from '../status';
import { Icon } from './Icon';
import { keepEscape, Modal } from './ui';

export function PermissionPicker({ client, sessionId, status, projectRoot, initialPermission, initialConfirmations, disabled, running, onInitialChange, onStatus, onOpenSecurity }: {
  client: Client;
  sessionId: string | null;
  status: Status | null;
  projectRoot: string;
  initialPermission: PermissionTarget;
  initialConfirmations: PermissionConfirmations;
  disabled: boolean;
  running: boolean;
  onInitialChange: (target: PermissionTarget, confirmations: PermissionConfirmations) => void;
  onStatus: (status: Status) => void;
  onOpenSecurity: () => void;
}) {
  const t = useText();
  const permission = permissionOf(status);
  const current = sessionId === null ? initialPermission : { profile: permission.profile, network: permission.network };
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<PermissionProfile>(permission.profile);
  const [network, setNetwork] = useState<PermissionNetwork>(permission.network);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [projectTrusted, setProjectTrusted] = useState(permission.workspaceTrusted);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustingWorkspace, setTrustingWorkspace] = useState(false);
  const [confirmations, setConfirmations] = useState<PermissionConfirmation[]>([]);
  const [confirmed, setConfirmed] = useState<PermissionConfirmations>({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });

  useEffect(() => {
    setProfile(current.profile);
    setNetwork(current.network);
    setNeedsRefresh(false);
  }, [current.profile, current.network]);

  useEffect(() => { setProjectTrusted(permission.workspaceTrusted); }, [permission.workspaceTrusted]);

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
        workspaceTrust: projectTrusted || confirmationsForChange.workspaceTrust,
      });
      setNeedsRefresh(false);
      setOpen(false);
      return;
    }
    if (status === null) return;
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
    const currentPermission = {
      ...permission,
      profile: current.profile,
      network: current.network,
      partialWorkspaceWriteConfirmed: sessionId === null ? initialConfirmations.partialWorkspaceWrite : permission.partialWorkspaceWriteConfirmed,
      workspaceTrusted: sessionId === null ? projectTrusted : permission.workspaceTrusted,
    };
    const required = permissionConfirmations(currentPermission, target);
    setConfirmed({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
    if (required.length === 0) {
      void save({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
      return;
    }
    setConfirmations(required);
    setOpen(false);
  };

  const cancelConfirmation = () => {
    setConfirmations([]);
    setConfirmed({ fullAccess: false, network: false, partialWorkspaceWrite: false, workspaceTrust: false });
    setOpen(true);
  };

  const confirmNext = () => {
    const current = confirmations[0];
    if (current === undefined) return;
    const nextConfirmed = {
      fullAccess: confirmed.fullAccess || current === 'full-access',
      network: confirmed.network || current === 'unrestricted-network',
      partialWorkspaceWrite: confirmed.partialWorkspaceWrite || current === 'partial-workspace-write',
      workspaceTrust: confirmed.workspaceTrust || current === 'workspace-trust',
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

  const trustWorkspace = async () => {
    if (projectRoot.trim() === '' || trustingWorkspace || isRunning) return;
    setTrustingWorkspace(true);
    setFailure('');
    try {
      await client.call('workspace.trust', { projectRoot, trusted: true, confirmWorkspaceTrust: true }, 15_000);
      setProjectTrusted(true);
      if (sessionId !== null) {
        const next = await readPermissionStatus(client, sessionId);
        onStatus(next);
      }
      setTrustOpen(false);
    } catch (error) {
      setFailure(t(`无法信任工作区：${code(error)}`, `Could not trust workspace: ${code(error)}`));
    } finally {
      setTrustingWorkspace(false);
    }
  };

  return <>
    <Popover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        setProfile(current.profile);
        setNetwork(current.network);
        setFailure('');
      }
    }}>
      <Popover.Trigger asChild>
        <button type="button" className="composer-choice permission-trigger" disabled={disabled || (sessionId !== null && (status === null || busy))}
          title={sessionId === null ? t('新会话的操作系统权限', 'Operating-system permissions for the new conversation') : t('当前会话的操作系统权限', 'Operating-system permissions for this conversation')}>
          <Icon name="shield" size={14} /><span>{t('权限', 'Permissions')} · {profileLabel(current.profile, t)}</span><Icon name="fold" size={12} />
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
            <span>{sessionId === null ? t('新会话', 'New conversation') : t('当前会话', 'Current conversation')}</span>
            <strong>{profileLabel(current.profile, t)} · {networkLabel(current.network, t)}</strong>
          </div>
          <div className="permission-change-state">
            <span>{t('权限更改', 'Permission changes')}</span>
            <strong>{changeState}</strong>
          </div>
          <div className="permission-change-state">
            <span>{t('项目代码信任', 'Project code trust')}</span>
            <strong>{projectTrusted ? t('已信任', 'Trusted') : t('未信任', 'Untrusted')}</strong>
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

          {sessionId === null
            ? <p className="permission-note" role="status">{t('平台能力会在创建会话时由 Host 检查；不支持的操作仍会被拒绝。', 'The Host checks platform capabilities when it creates the conversation; unsupported operations remain denied.')}</p>
            : !unavailableStatus && <>
                <div className="permission-summary" role="status">
                  <strong>{t('当前隔离', 'Current isolation')}</strong>
                  <span>{t(`读 ${enforcementLabel(permission.capabilities.filesystemRead, t)} · 写 ${enforcementLabel(permission.capabilities.filesystemWrite, t)} · 网络 ${enforcementLabel(permission.capabilities.network, t)} · 进程 ${enforcementLabel(permission.capabilities.process, t)}`,
                    `Read ${enforcementLabel(permission.capabilities.filesystemRead, t)} · write ${enforcementLabel(permission.capabilities.filesystemWrite, t)} · network ${enforcementLabel(permission.capabilities.network, t)} · process ${enforcementLabel(permission.capabilities.process, t)}`)}</span>
                  <span data-tone={permission.execution.available ? 'ok' : 'bad'}>{t(`命令执行 ${permission.execution.available ? '可用' : '不可用'}`, `Command execution ${permission.execution.available ? 'available' : 'unavailable'}`)}</span>
                </div>
                <button type="button" className="permission-details-link" onClick={() => { setOpen(false); onOpenSecurity(); }}>
                  {t('查看平台隔离详情', 'View platform isolation details')}
                </button>
              </>}

          {unavailableStatus && <p className="permission-note" role="status">{t(
            '无法读取 Host 的权限状态。界面按只读处理，并禁用更改。',
            'The Host permission status is unavailable. This session is treated as read-only and changes are disabled.',
          )}</p>}
          {!projectTrusted && <button type="button" className="permission-trust-button"
            disabled={busy || trustingWorkspace || isRunning || projectRoot.trim() === ''}
            onClick={() => setTrustOpen(true)}>
            {t('信任此工作区以运行项目代码', 'Trust this workspace for project code')}
          </button>}
          {sessionId !== null && isRunning && <p className="permission-note" role="status">{t('会话运行期间不能更改权限。', 'Permissions cannot change while the session is running.')}</p>}
          {sessionId !== null && !unavailableStatus && !permission.changeAllowed && <p className="permission-note" role="status">{t(
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
            <button type="button" disabled={!hasChanges || busy} onClick={() => { setProfile(current.profile); setNetwork(current.network); setFailure(''); }}>{t('放弃更改', 'Discard changes')}</button>
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
        : confirmation === 'unrestricted-network'
          ? t('此会话将使用不受限网络。', 'This session will use unrestricted network access.')
          : confirmation === 'partial-workspace-write'
            ? t('请确认你已阅读适用的部分隔离限制。', 'Confirm that you have read the applicable partial-isolation limits.')
            : t('请确认信任此工作区中的项目代码。', 'Confirm that you trust project code in this workspace.')}</h2>
      <p className="confirm-note">{confirmation === 'full-access'
        ? t('完全访问会放宽会话的操作系统资源限制。若加载扩展，它们会作为可信代码直接运行；扩展直接调用操作系统能力时不经过 Policy 或危险命令拒绝。', 'Full access relaxes the session’s operating-system resource restrictions. Loaded extensions run as trusted code; direct operating-system calls from extensions do not pass through Policy or dangerous-command denials.')
        : confirmation === 'unrestricted-network'
          ? t('不受限网络允许 Shell、MCP 服务器和扩展使用当前 OS 用户可访问的网络。内置网络工具仍按 Policy 判定。', 'Unrestricted network lets Shell, MCP servers, and extensions use the network available to this OS user. Built-in network tools remain subject to Policy.')
          : confirmation === 'partial-workspace-write'
            ? t('Host 会在创建会话时检测平台。若使用 Windows 部分隔离后端，它无法限制文件读取和网络，并可能被既有硬链接、目录重解析点或可写父目录的删除权限绕过。它不适合运行恶意代码。Shell 会直接修改工作区；强制终止可能留下仅本次 SID 的 ACL。Windows 也可能在传播临时 ACE 时将受影响 DACL 标记为自动继承；正常清理会撤销本次 ACE，但该元数据标记可能保留。Shell 每次运行还会使用临时用户配置目录，用户级设置和缓存不会沿用。', 'The Host checks the platform when it creates the conversation. If it uses the Windows partial-isolation backend, it cannot restrict file reads or network, and existing hard links, reparse points, or delete-child rights on a writable parent can bypass the workspace boundary. It is not a container for hostile code. Shell writes directly to the workspace, and force-killing the Guardian can leave an ACL for this run’s SID. Windows may also mark affected DACLs as auto-inherited while propagating temporary ACEs; normal cleanup revokes the run’s ACE, but that metadata may remain. Each Shell command also uses a temporary user profile; user-level settings and caches are not reused.')
            : t('信任此工作区后，Ligule 可以在逐次审批后运行项目代码和 Git 命令。信任会记录在本机的工作区信任列表中，可通过 TUI 的 /trust revoke 撤销。', 'After you trust this workspace, Ligule can run project code and Git commands after per-call approval. The trust is saved in the local workspace list and can be revoked with /trust revoke in TUI.')}</p>
      <div className="confirm-actions">
        <button type="button" onClick={cancelConfirmation}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" onClick={confirmNext}>
          {confirmations.length > 1 ? t('继续确认', 'Continue') : t('确认并应用', 'Confirm and apply')}
        </button>
      </div>
    </Modal>}
    {trustOpen && <Modal title={t('信任此工作区', 'Trust this workspace')} className="confirm" onClose={() => setTrustOpen(false)}>
      <h2 className="confirm-lead">{t('信任此目录中的项目代码、Git 命令与 Hook？', 'Trust project code, Git commands, and hooks in this directory?')}</h2>
      <p className="confirm-note"><code>{projectRoot}</code></p>
      <p className="confirm-note">{t('每次执行仍需通过 Policy 审批；信任允许 Ligule 识别并逐次审批项目代码和 Git 命令。撤销可在 TUI 中输入 /trust revoke。', 'Each execution still goes through Policy approval. Trust lets Ligule identify and ask before running project code and Git commands. Revoke it with /trust revoke in TUI.')}</p>
      {failure !== '' && <p className="permission-failure" role="alert">{failure}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={trustingWorkspace} onClick={() => setTrustOpen(false)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={trustingWorkspace || isRunning} onClick={() => void trustWorkspace()}>
          {trustingWorkspace ? t('正在保存…', 'Saving…') : t('信任此工作区', 'Trust workspace')}
        </button>
      </div>
    </Modal>}
  </>;
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
