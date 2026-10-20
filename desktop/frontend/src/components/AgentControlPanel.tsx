import { useCallback, useEffect, useMemo, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { Icon } from './Icon';
import { Modal } from './ui';

type PermissionProfile = 'read-only' | 'workspace-write' | 'full-access';
type NetworkLimit = 'disabled' | 'policy' | 'unrestricted';
type PolicyMode = 'ask' | 'auto' | 'never';
type Grant = {
  id: string;
  name: string;
  projectRoot: string;
  source: 'trusted-ui' | 'legacy';
  defaultPermissionProfile: PermissionProfile;
  maxPermissionProfile: PermissionProfile;
  defaultNetwork: NetworkLimit;
  maxNetwork: NetworkLimit;
  defaultPolicy: PolicyMode;
  allowedPolicies: PolicyMode[];
  allowOperator: boolean;
  confirmedFullAccess: boolean;
  confirmedUnrestrictedNetwork: boolean;
  confirmedPartialWorkspaceWrite: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};
type Snapshot = { version: string; grants: Grant[] };
type Draft = {
  name: string;
  defaultPermissionProfile: PermissionProfile;
  maxPermissionProfile: PermissionProfile;
  defaultNetwork: NetworkLimit;
  maxNetwork: NetworkLimit;
  defaultPolicy: PolicyMode;
  allowedPolicies: PolicyMode[];
  allowOperator: boolean;
  confirmFullAccess: boolean;
  confirmUnrestrictedNetwork: boolean;
  confirmPartialWorkspaceWrite: boolean;
  confirmWorkspaceTrust: boolean;
  expiresAt: string;
};

function emptyDraft(): Draft {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localExpiry = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000);
  return {
    name: '',
    defaultPermissionProfile: 'read-only',
    maxPermissionProfile: 'read-only',
    defaultNetwork: 'disabled',
    maxNetwork: 'disabled',
    defaultPolicy: 'ask',
    allowedPolicies: ['ask'],
    allowOperator: false,
    confirmFullAccess: false,
    confirmUnrestrictedNetwork: false,
    confirmPartialWorkspaceWrite: false,
    confirmWorkspaceTrust: false,
    expiresAt: localExpiry.toISOString().slice(0, 16),
  };
}

const PROFILE_RANK: Record<PermissionProfile, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_RANK: Record<NetworkLimit, number> = { disabled: 0, policy: 1, unrestricted: 2 };

export function AgentControlPanel({ client, projectRoot, onEdit }: {
  client: Client;
  projectRoot: string;
  onEdit?: (reason: string) => void;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; code?: string; bad: boolean } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<Grant | null>(null);
  const [copied, setCopied] = useState('');
  const project = projectRoot.trim();
  const profileExceeds = PROFILE_RANK[draft.defaultPermissionProfile] > PROFILE_RANK[draft.maxPermissionProfile];
  const networkExceeds = NETWORK_RANK[draft.defaultNetwork] > NETWORK_RANK[draft.maxNetwork];
  const policyMissing = !draft.allowedPolicies.includes(draft.defaultPolicy);
  const invalidExpiry = draft.expiresAt !== '' && !Number.isFinite(Date.parse(draft.expiresAt));
  const canSave = !busy && snapshot !== null && project !== '' && draft.name.trim() !== ''
    && !profileExceeds && !networkExceeds && !policyMissing && !invalidExpiry
    && (draft.maxPermissionProfile !== 'full-access' || draft.confirmFullAccess)
    && (draft.maxPermissionProfile === 'read-only' || draft.confirmPartialWorkspaceWrite)
    && draft.confirmWorkspaceTrust
    && (draft.maxNetwork !== 'unrestricted' || draft.confirmUnrestrictedNetwork);
  const held = busy && dirty
    ? t('外部控制授权正在保存。', 'The Agent Control grant is being saved.')
    : dirty
      ? t('有一份外部控制授权草稿尚未保存。', 'An Agent Control grant draft is not saved yet.')
      : '';

  useEffect(() => {
    if (onEdit === undefined) return;
    onEdit(held);
    return () => onEdit('');
  }, [held, onEdit]);

  const load = useCallback(async (keepNote = false) => {
    try {
      const result = await client.call('agent-control.list', {}, 15_000) as Snapshot;
      setSnapshot(result);
      if (!keepNote) setNote(null);
    } catch (error) {
      setNote({ text: t('无法读取本机外控授权。', 'Could not read local Agent Control grants.'), code: code(error), bad: true });
    }
  }, [client, t]);

  useEffect(() => { void load(); }, [load]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDirty(true);
    setDraft(current => ({ ...current, [key]: value }));
    setNote(null);
  };

  const save = async () => {
    if (!canSave || snapshot === null) return;
    setBusy(true);
    setNote(null);
    try {
      const expiration = draft.expiresAt === '' ? '' : new Date(draft.expiresAt).toISOString();
      const result = await client.call('agent-control.create', {
        version: snapshot.version,
        grantName: draft.name,
        projectRoot: project,
        defaultPermissionProfile: draft.defaultPermissionProfile,
        maxPermissionProfile: draft.maxPermissionProfile,
        defaultNetwork: draft.defaultNetwork,
        maxNetwork: draft.maxNetwork,
        defaultPolicy: draft.defaultPolicy,
        allowedPolicyAsk: draft.allowedPolicies.includes('ask'),
        allowedPolicyAuto: draft.allowedPolicies.includes('auto'),
        allowedPolicyNever: draft.allowedPolicies.includes('never'),
        allowOperator: draft.allowOperator,
        confirmFullAccess: draft.confirmFullAccess,
        confirmUnrestrictedNetwork: draft.confirmUnrestrictedNetwork,
        confirmPartialWorkspaceWrite: draft.confirmPartialWorkspaceWrite,
        confirmWorkspaceTrust: draft.confirmWorkspaceTrust,
        expiresAt: expiration,
      }, 30_000) as Snapshot;
      setSnapshot(result);
      setDraft(emptyDraft());
      setDirty(false);
      setNote({ text: t('授权已保存。请将授权 ID 放入本地 MCP 配置。', 'Grant saved. Use its ID in your local MCP configuration.'), bad: false });
    } catch (error) {
      setNote({ text: t('授权保存失败。', 'Could not save the grant.'), code: code(error), bad: true });
      await load(true);
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (snapshot === null || confirmingRevoke === null) return;
    setBusy(true);
    try {
      const result = await client.call('agent-control.revoke', {
        grantId: confirmingRevoke.id,
        version: snapshot.version,
      }, 30_000) as Snapshot;
      setSnapshot(result);
      setNote({ text: t('授权已撤销。已连接的 MCP 进程将在检查到撤销后取消运行并拒绝后续调用。', 'Grant revoked. Connected MCP processes cancel active work and reject later calls when they detect the revocation.'), bad: false });
    } catch (error) {
      setNote({ text: t('授权撤销失败。', 'Could not revoke the grant.'), code: code(error), bad: true });
      await load(true);
    } finally {
      setBusy(false);
      setConfirmingRevoke(null);
    }
  };

  const copyConfig = async (grant: Grant) => {
    const args = ['mcp-server', '--project', grant.projectRoot, '--grant', grant.id];
    if (grant.allowOperator) args.push('--operator');
    const config = JSON.stringify({ mcpServers: { ligule: { command: 'ligule', args } } }, null, 2);
    try {
      await navigator.clipboard.writeText(config);
      setCopied(grant.id);
      setNote({ text: t('本地 MCP 配置已复制。配置不包含模型凭据。', 'Local MCP configuration copied. It contains no model credentials.'), bad: false });
    } catch (error) {
      setNote({ text: t('复制配置失败。', 'Could not copy the configuration.'), code: code(error), bad: true });
    }
  };

  const activeGrants = useMemo(() => snapshot?.grants ?? [], [snapshot]);

  return <div className="agent-control-panel">
    <div className="agent-control-toolbar">
      <span className="agent-control-status">{t('MCP 连接状态未知', 'MCP connection status unknown')}</span>
      <button type="button" className="rail-refresh" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={13} />{t('重新读取', 'Reload')}</button>
    </div>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>{note.code !== undefined && <code>{note.code}</code>}
    </div>}
    <p className="agent-control-notice">{t('新授权默认只读、禁用网络并在 24 小时后到期，可按需调整。授权供本机 stdio MCP 使用，每份只绑定一个项目。名称只是备注；同一 OS 账户下的程序仍可访问本机授权数据。', 'New grants default to read-only, disabled network access, and a 24-hour expiry; adjust them as needed. Grants are for local stdio MCP and each is bound to one project. Names are labels only; programs under the same OS account can still access local grant data.')}</p>

    <section className="region-group agent-control-create">
      <h3>{t('新建外控授权', 'Create an Agent Control grant')}</h3>
      <div className="grant-basic-grid">
        <label className="grant-field">
          <span>{t('授权项目', 'Project')}</span>
          <input value={project} readOnly placeholder={t('请先选择工作区', 'Choose a workspace first')} aria-label={t('授权项目目录', 'Grant project directory')} />
        </label>
        <label className="grant-field">
          <span>{t('名称备注', 'Name')}</span>
          <input value={draft.name} maxLength={80} onChange={(event) => update('name', event.target.value)} placeholder={t('例如 Codex 本地任务', 'e.g. Codex local task')} />
        </label>
      </div>

      <div className="grant-config-grid">
        <section className="grant-config-card">
          <h4>{t('文件与命令权限', 'Files and commands')}</h4>
          <div className="grant-choice-grid">
            <label className="grant-field">
              <span>{t('默认权限', 'Default')}</span>
              <select value={draft.defaultPermissionProfile} onChange={(event) => update('defaultPermissionProfile', event.target.value as PermissionProfile)}>
                <option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full-access">full-access</option>
              </select>
            </label>
            <label className="grant-field">
              <span>{t('权限上限', 'Maximum')}</span>
              <select value={draft.maxPermissionProfile} onChange={(event) => update('maxPermissionProfile', event.target.value as PermissionProfile)}>
                <option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full-access">full-access</option>
              </select>
            </label>
          </div>
          {profileExceeds && <p className="grant-validation">{t('默认权限不能高于权限上限。', 'Default permission cannot exceed the maximum.')}</p>}
          {draft.maxPermissionProfile === 'full-access' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmFullAccess} onChange={(event) => update('confirmFullAccess', event.target.checked)} />
            <span>{t('确认允许访问当前 OS 账户可访问的全部资源。', 'Allow access to everything available to this OS account.')}</span>
          </label>}
          {draft.maxPermissionProfile !== 'read-only' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmPartialWorkspaceWrite} onChange={(event) => update('confirmPartialWorkspaceWrite', event.target.checked)} />
            <span>{t('确认接受可能适用的部分隔离限制。Windows 工作区写入无法限制读取和网络，硬链接或可写父目录删除权限也可能越过工作区范围；正常清理会撤销临时 ACE，但自动继承元数据标记可能保留。Shell 每次运行使用临时用户配置目录，用户级缓存不会沿用。', 'Accept the partial-isolation limits that may apply. Windows workspace-write cannot restrict reads or network, and hard links or delete-child rights on writable parent folders may escape the workspace boundary. Normal cleanup revokes temporary ACEs, but auto-inheritance metadata may remain. Each Shell command uses a temporary user profile, so user-level caches are not reused.')}</span>
          </label>}
        </section>

        <section className="grant-config-card">
          <h4>{t('网络访问', 'Network access')}</h4>
          <div className="grant-choice-grid">
            <label className="grant-field">
              <span>{t('默认范围', 'Default')}</span>
              <select value={draft.defaultNetwork} onChange={(event) => update('defaultNetwork', event.target.value as NetworkLimit)}>
                <option value="disabled">disabled</option><option value="policy">policy</option><option value="unrestricted">unrestricted</option>
              </select>
            </label>
            <label className="grant-field">
              <span>{t('范围上限', 'Maximum')}</span>
              <select value={draft.maxNetwork} onChange={(event) => update('maxNetwork', event.target.value as NetworkLimit)}>
                <option value="disabled">disabled</option><option value="policy">policy</option><option value="unrestricted">unrestricted</option>
              </select>
            </label>
          </div>
          {networkExceeds && <p className="grant-validation">{t('默认网络范围不能高于上限。', 'Default network access cannot exceed the maximum.')}</p>}
          {draft.maxNetwork === 'unrestricted' && <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmUnrestrictedNetwork} onChange={(event) => update('confirmUnrestrictedNetwork', event.target.checked)} />
            <span>{t('单独确认允许不受限网络访问。', 'Separately confirm unrestricted network access.')}</span>
          </label>}
        </section>

        <section className="grant-config-card">
          <h4>{t('审批方式', 'Approval behavior')}</h4>
          <label className="grant-field">
            <span>{t('默认 Policy', 'Default Policy')}</span>
            <select value={draft.defaultPolicy} onChange={(event) => update('defaultPolicy', event.target.value as PolicyMode)}>
              <option value="ask">ask</option><option value="auto">auto</option><option value="never">never</option>
            </select>
          </label>
          <fieldset className="grant-policies">
            <legend>{t('允许的模式', 'Allowed modes')}</legend>
            {(['ask', 'auto', 'never'] as const).map((policy) => <label key={policy}>
              <input type="checkbox" checked={draft.allowedPolicies.includes(policy)} onChange={(event) => {
                const selected = event.target.checked
                  ? [...draft.allowedPolicies, policy]
                  : draft.allowedPolicies.filter((item) => item !== policy);
                update('allowedPolicies', selected);
              }} /> {policy}
            </label>)}
          </fieldset>
          {policyMissing && <p className="grant-validation">{t('默认 Policy 必须在允许列表中。', 'The default Policy must be allowed.')}</p>}
          <label className="grant-confirmation">
            <input type="checkbox" checked={draft.allowOperator} onChange={(event) => update('allowOperator', event.target.checked)} />
            <span>{t('允许 MCP 使用者通过 --operator 处理普通审批。', 'Allow the MCP client to handle ordinary approvals with --operator.')}</span>
          </label>
        </section>

        <section className="grant-config-card grant-lifetime-card">
          <h4>{t('授权期限', 'Grant lifetime')}</h4>
          <label className="grant-confirmation grant-risk">
            <input type="checkbox" checked={draft.confirmWorkspaceTrust} onChange={(event) => update('confirmWorkspaceTrust', event.target.checked)} />
            <span>{t('我信任上方项目目录中的项目代码；项目脚本和 Git 命令仍会逐次请求审批。', 'I trust project code in the directory above; project scripts and Git commands still require approval for each call.')}</span>
          </label>
          <label className="grant-field">
            <span>{t('到期时间（可留空）', 'Expires (optional)')}</span>
            <input type="datetime-local" value={draft.expiresAt} onChange={(event) => update('expiresAt', event.target.value)} />
          </label>
          {invalidExpiry && <p className="grant-validation">{t('到期时间格式无效。', 'The expiry time is invalid.')}</p>}
        </section>
      </div>

      <div className="inline-field grant-actions">
        <button type="button" disabled={!canSave} onClick={() => void save()}>{busy ? t('正在保存…', 'Saving…') : t('创建授权', 'Create grant')}</button>
        <button type="button" disabled={busy || !dirty} onClick={() => { setDraft(emptyDraft()); setDirty(false); setNote(null); }}>{t('清除草稿', 'Clear draft')}</button>
      </div>
    </section>

    <section className="region-group">
      <h3>{t(`已保存授权（${activeGrants.length}）`, `Saved grants (${activeGrants.length})`)}</h3>
      {snapshot === null ? <p className="stub">{t('正在读取授权…', 'Loading grants…')}</p> : activeGrants.length === 0
        ? <p className="stub">{t('尚未创建授权。', 'No grants have been created.')}</p>
        : activeGrants.map((grant) => {
          const revoked = grant.revokedAt !== null;
          const expired = grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now();
          const source = grant.source === 'trusted-ui'
            ? t('可信界面创建', 'Trusted UI')
            : t('历史记录未保存来源', 'Legacy record; source not recorded');
          return <article className="grant-row" key={grant.id}>
            <div className="grant-row-head"><strong>{grant.name}</strong><span data-state={revoked ? 'revoked' : expired ? 'expired' : 'active'}>{revoked ? t('已撤销', 'Revoked') : expired ? t('已到期', 'Expired') : t('可用', 'Available')}</span></div>
            <code>{grant.projectRoot}</code>
            <p>{t('权限', 'Permission')}: {grant.defaultPermissionProfile} / {grant.maxPermissionProfile} · {t('网络', 'network')}: {grant.defaultNetwork} / {grant.maxNetwork} · Policy: {grant.allowedPolicies.join(', ')}</p>
            <p>{t('有效期', 'Expires')}: {grant.expiresAt === null ? t('无期限', 'No expiry') : new Date(grant.expiresAt).toLocaleString()} · {t('普通审批代答', 'Operator replies')}: {grant.allowOperator ? t('允许', 'allowed') : t('关闭', 'disabled')}</p>
            <details><summary>{t('授权详情与 MCP 配置', 'Grant details and MCP configuration')}</summary>
              <code>{grant.id}</code>
              <p>{t('创建', 'Created')}: {new Date(grant.createdAt).toLocaleString()} · {t('来源', 'Source')}: {source}{grant.revokedAt === null ? '' : ` · ${t('撤销', 'Revoked')}: ${new Date(grant.revokedAt).toLocaleString()}`}</p>
              <p>{t('权限/网络之外，Session 实际能力仍受当前 OS Sandbox 和 Policy 限制。', 'Session capabilities remain subject to the current OS sandbox and Policy.')}</p>
              <button type="button" className="mini chip" onClick={() => void copyConfig(grant)}>{copied === grant.id ? t('已复制配置', 'Configuration copied') : t('复制 MCP 配置', 'Copy MCP config')}</button>
            </details>
            {!revoked && <button type="button" className="mini chip danger" disabled={busy} onClick={() => setConfirmingRevoke(grant)}>{t('撤销授权', 'Revoke grant')}</button>}
          </article>;
        })}
    </section>

    {confirmingRevoke !== null && <Modal title={t('撤销 Agent Control 授权', 'Revoke Agent Control grant')} className="confirm" onClose={() => setConfirmingRevoke(null)}>
      <h2 className="confirm-lead">{t(`撤销「${confirmingRevoke.name}」？`, `Revoke “${confirmingRevoke.name}”?`)}</h2>
      <p className="confirm-note">{t('MCP Host 会在下次操作或最多约半秒内发现撤销，取消正在运行的任务，并拒绝后续调用。已经完成的 OS 副作用无法收回。', 'The MCP Host detects revocation on the next operation or within about half a second, cancels active work, and rejects later calls. Completed OS side effects cannot be undone.')}</p>
      <div className="confirm-actions"><button type="button" onClick={() => setConfirmingRevoke(null)}>{t('保留授权', 'Keep grant')}</button><button type="button" className="danger" disabled={busy} onClick={() => void revoke()}>{t('确认撤销', 'Revoke')}</button></div>
    </Modal>}
  </div>;
}
