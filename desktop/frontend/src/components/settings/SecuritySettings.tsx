import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../../protocol';
import { readSettingsCatalog, type SettingsCatalog } from '../../settings-catalog';
import type { Status } from '../../status';
import { useText } from '../../locale';
import { Group, Modal, Row } from '../ui';
import { PolicyRules } from '../PolicyRules';

export function SecuritySettings({ client, projectRoot, sessionId, status, onStatus, onEdit }: {
  client: Client;
  projectRoot: string;
  sessionId: string | null;
  status: Status | null;
  onStatus: (status: Status) => void;
  onEdit: (reason: string) => void;
}) {
  const t = useText();
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await readSettingsCatalog(client, projectRoot, sessionId);
      setCatalog(next);
      setFailure('');
    } catch (error) {
      setFailure(code(error));
    }
  }, [client, projectRoot, sessionId]);
  useEffect(() => { void load(); }, [load]);

  const updateTrust = async (trusted: boolean) => {
    if (projectRoot.trim() === '' || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await client.call('workspace.trust', {
        projectRoot,
        trusted,
        ...(trusted ? { confirmWorkspaceTrust: true } : {}),
      }, 15_000);
      setConfirmTrust(false);
      await load();
      if (sessionId !== null) {
        const next = await client.call('status.get', { sessionId }, 15_000) as Status;
        onStatus(next);
      }
    } catch (error) {
      setFailure(code(error));
    } finally {
      setBusy(false);
    }
  };

  const permission = status?.permission;
  return <div className="security-settings">
    {failure !== '' && <p className="session-note" data-tone="bad">{t('读取或更新安全状态失败。', 'Could not read or update security settings.')} <code>{failure}</code></p>}
    <Group title={t('审批方式', 'Approval behavior')}>
      <Row label={t('默认审批档', 'Default approval tier')}>
        <span>{catalog?.policyDefault ?? t('未知', 'Unknown')}</span>
        {status !== null && <span className="catalog-tag">{t(`当前会话：${status.policy}`, `Session: ${status.policy}`)}</span>}
      </Row>
      <Row label={t('自定义规则', 'Custom rules')}>
        <details className="catalog-fold">
          <summary>{t('查看与编辑审批规则', 'View and edit approval rules')}</summary>
        <PolicyRules client={client} projectRoot={projectRoot} onEdit={onEdit} />
        </details>
      </Row>
    </Group>
    <Group title={t('工作区信任', 'Workspace trust')}>
      <Row label={t('当前项目', 'Current project')}><code className="catalog-path">{projectRoot || t('未选择项目', 'No project selected')}</code></Row>
      <Row label={t('信任状态', 'Trust status')}>
        <span>{catalog === null ? t('正在读取…', 'Loading…') : catalog.projectTrusted ? t('已信任', 'Trusted') : t('未信任', 'Not trusted')}</span>
        {catalog?.projectTrusted
          ? <button type="button" disabled={busy} onClick={() => void updateTrust(false)}>{t('撤销信任', 'Revoke trust')}</button>
          : <button type="button" disabled={busy || projectRoot === ''} onClick={() => setConfirmTrust(true)}>{t('信任此工作区', 'Trust this workspace')}</button>}
      </Row>
      <p className="sheet-note">{t('项目脚本和钩子会以当前 OS 账户运行；Policy 与平台 Sandbox 仍生效。', 'Project scripts and hooks run as this OS user; Policy and platform sandbox limits still apply.')}</p>
    </Group>
    <Group title={t('当前会话隔离能力', 'Current session isolation')}>
      {permission === undefined
        ? <p className="stub">{t('打开会话后显示权限档、网络和平台隔离状态。', 'Open a conversation to see its permission profile, network access, and platform enforcement.')}</p>
        : <>
          <Row label={t('权限 / 网络', 'Permission / network')}><span>{permission.profile} · {permission.network}</span></Row>
          <Row label={t('平台执行', 'Platform enforcement')}>
            <span>{t(`只读 ${permission.profiles.readOnly} · 工作区写入 ${permission.profiles.workspaceWrite} · 命令 ${permission.execution.available ? '可用' : '不可用'}`, `Read-only ${permission.profiles.readOnly} · workspace-write ${permission.profiles.workspaceWrite} · commands ${permission.execution.available ? 'available' : 'unavailable'}`)}</span>
          </Row>
          <details className="catalog-fold security-capability-details">
            <summary>{t(`查看平台能力详情${permission.limitations.length === 0 ? '' : `（限制 ${permission.limitations.length} 项）`}`, `View platform details${permission.limitations.length === 0 ? '' : ` (${permission.limitations.length} limitations)`}`)}</summary>
            <Row label={t('文件读取 / 写入', 'File read / write')}><span>{permission.capabilities.filesystemRead} / {permission.capabilities.filesystemWrite}</span></Row>
            <Row label={t('网络 / 进程', 'Network / process')}><span>{permission.capabilities.network} / {permission.capabilities.process}</span></Row>
            <Row label={t('命令执行', 'Command execution')}>
              <span>{permission.execution.available ? t('可用', 'Available') : t('不可用', 'Unavailable')}{permission.execution.code === null ? '' : ` · ${permission.execution.code}`}</span>
            </Row>
            {permission.limitations.length > 0 && <ul>{permission.limitations.map((item) => <li key={item}>{item}</li>)}</ul>}
          </details>
        </>}
    </Group>
    {confirmTrust && <Modal title={t('确认信任工作区', 'Confirm workspace trust')} className="confirm" onClose={() => setConfirmTrust(false)}>
      <h2 className="confirm-lead">{t('允许项目代码在当前账户下运行？', 'Allow project code to run as this account?')}</h2>
      <p className="confirm-note">{t('此操作信任以下项目中的脚本、Git 命令和钩子。信任不会绕过会话 Policy；Windows 的 workspace-write 仍有部分隔离限制。', 'This trusts scripts, Git commands, and hooks in this project. Trust does not bypass session Policy; Windows workspace-write still has partial isolation limits.')}</p>
      <code className="catalog-path">{projectRoot}</code>
      <div className="confirm-actions"><button type="button" onClick={() => setConfirmTrust(false)}>{t('取消', 'Cancel')}</button><button type="button" className="danger" disabled={busy} onClick={() => void updateTrust(true)}>{t('确认信任', 'Trust project')}</button></div>
    </Modal>}
  </div>;
}
