import { useState } from 'react';
import { Popover } from 'radix-ui';
import { useText } from '../locale';
import type { Client } from '../protocol';
import type { PermissionConfirmations, PermissionTarget } from '../permission-control';
import type { PermissionProfile, Status } from '../status';
import { useSessionPermission } from '../use-session-permission';
import { profileLabel } from '../permission-labels';
import { Icon } from './Icon';
import { PermissionConfirmationDialog } from './PermissionConfirmationDialog';
import { keepEscape } from './ui';

/**
 * The composer shortcut only chooses the session profile. Network access and
 * platform isolation live in Settings → 权限与安全.
 */
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
  const [open, setOpen] = useState(false);
  const editor = useSessionPermission({ client, sessionId, status, initialPermission, initialConfirmations, disabled, running, onInitialChange, onStatus });
  const { profile, setProfile, current } = editor;

  const openSettings = () => {
    setOpen(false);
    onOpenSecurity();
  };

  return <>
    <Popover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        editor.discard();
        editor.clearFailure();
      }
    }}>
      <Popover.Trigger asChild>
        <button type="button" className="composer-choice permission-trigger" disabled={disabled || (sessionId !== null && (status === null || editor.busy))}
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
          <p className="permission-note">{t('限制会话可访问的系统资源；审批规则单独生效。', 'Limits the system resources this conversation can reach. Approval rules are separate.')}</p>

          <div className="permission-change-state">
            <span>{sessionId === null ? t('新会话', 'New conversation') : t('当前会话', 'Current conversation')}</span>
            <strong>{profileLabel(current.profile, t)}</strong>
          </div>
          <div className="permission-change-state">
            <span>{t('权限更改', 'Permission changes')}</span>
            <strong>{editor.changeState}</strong>
          </div>

          <div className="permission-fields">
            <label>
              <span>{t('文件与命令', 'Files and commands')}</span>
              <select aria-label={t('文件与命令权限', 'File and command permission')} value={profile} disabled={!editor.canEdit}
                onChange={(event) => setProfile(event.target.value as PermissionProfile)}>
                <option value="read-only">{profileLabel('read-only', t)}</option>
                <option value="workspace-write">{profileLabel('workspace-write', t)}</option>
                <option value="full-access">{profileLabel('full-access', t)}</option>
              </select>
            </label>
          </div>

          {!editor.workspaceTrusted && <p className="permission-note" role="status">{t('项目代码尚未信任；运行项目命令前需在设置中信任此工作区。', 'Project code is not trusted yet. Trust the workspace in Settings before running project commands.')}</p>}
          {editor.unavailableStatus && <p className="permission-note" role="status">{t(
            '无法读取 Host 的权限状态。界面按只读处理，并禁用更改。',
            'The Host permission status is unavailable. This session is treated as read-only and changes are disabled.',
          )}</p>}
          {sessionId !== null && editor.isRunning && !editor.unavailableStatus && <p className="permission-note" role="status">{t('会话运行期间不能更改权限。', 'Permissions cannot change while the session is running.')}</p>}
          {sessionId !== null && !editor.unavailableStatus && !editor.isRunning && !editor.canEdit && status !== null && <p className="permission-note" role="status">{t('此连接不允许更改会话权限。', 'This connection does not allow session permission changes.')}</p>}
          {editor.failure !== '' && <p className="permission-failure" role="alert">{editor.failure}</p>}
          {editor.needsRefresh && <button type="button" disabled={editor.busy} onClick={() => void editor.refresh()}>{t('刷新权限状态', 'Refresh permission status')}</button>}

          <button type="button" className="permission-details-link" onClick={openSettings}>
            {t('网络访问、隔离与项目信任…', 'Network, isolation, and project trust…')}
          </button>
          {projectRoot.trim() === '' && <p className="permission-note" role="status">{t('尚未选择工作区。', 'No workspace selected.')}</p>}

          <div className="permission-actions">
            <button type="button" disabled={!editor.hasChanges || editor.busy} onClick={editor.discard}>{t('放弃更改', 'Discard changes')}</button>
            <button type="button" className="primary-button" disabled={!editor.canEdit || !editor.hasChanges} onClick={editor.apply}>
              {editor.busy ? t('正在更改…', 'Updating…') : t('应用更改', 'Apply changes')}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <PermissionConfirmationDialog editor={editor} />
  </>;
}
