import { useText } from '../locale';
import { Modal } from './ui';
import type { SessionPermissionEditor } from '../use-session-permission';

/**
 * Confirmation step for a pending permission change. Both the composer popover
 * and settings apply permission through the same hook, so they share the copy.
 */
export function PermissionConfirmationDialog({ editor }: { editor: SessionPermissionEditor }) {
  const t = useText();
  const confirmation = editor.confirmation;
  if (confirmation === null) return null;
  return <Modal title={editor.confirmationTitle} className="confirm" onClose={editor.cancelConfirmation}>
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
      <button type="button" onClick={editor.cancelConfirmation}>{t('取消', 'Cancel')}</button>
      <button type="button" className="primary-button" onClick={editor.confirmNext}>
        {editor.confirmationCount > 1 ? t('继续确认', 'Continue') : t('确认并应用', 'Confirm and apply')}
      </button>
    </div>
  </Modal>;
}
