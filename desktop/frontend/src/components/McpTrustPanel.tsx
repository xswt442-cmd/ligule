import { useCallback, useEffect, useState } from 'react';
import { code, type Client } from '../protocol';
import { useText } from '../locale';
import { Icon } from './Icon';
import { Modal, Row } from './ui';

type TrustScope = 'session' | 'project' | 'user';
type TrustRecord = { source: 'trusted-ui'; trusted: boolean; updatedAt: string } | null;
type Server = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  environmentNames: string[];
  identityDigest: string;
  trust: { scope: TrustScope; source: 'trusted-ui'; trusted: boolean; updatedAt: string } | null;
  trustScopes: Record<TrustScope, TrustRecord>;
};
type Snapshot = { version: string; servers: Server[] };
type Note = { text: string; bad: boolean; code?: string };

const scopeText = (scope: TrustScope, t: (chinese: string, english: string) => string) => {
  if (scope === 'session') return t('当前会话', 'This session');
  if (scope === 'project') return t('当前项目', 'This project');
  return t('所有项目', 'All projects');
};

export function McpTrustPanel({ client, projectRoot, sessionId }: {
  client: Client;
  projectRoot: string;
  sessionId: string | null;
}) {
  const t = useText();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scope, setScope] = useState<TrustScope>('project');
  const [confirming, setConfirming] = useState<Server | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const target = {
    ...(projectRoot === '' ? {} : { projectRoot }),
    ...(sessionId === null ? {} : { sessionId }),
  };

  const load = useCallback(async (keepNote = false) => {
    try {
      const result = await client.call('mcp.trust.list', target, 15_000) as Snapshot;
      setSnapshot(result);
      if (!keepNote) setNote(null);
    } catch (error) {
      setNote({ text: t('无法读取 MCP Server 信任状态。', 'Could not read MCP server trust.'), code: code(error), bad: true });
    }
  }, [client, projectRoot, sessionId, t]);

  useEffect(() => { void load(); }, [load]);

  const save = async (server: Server, trusted: boolean) => {
    if (snapshot === null) return;
    setBusy(true);
    setNote(null);
    try {
      await client.call('mcp.trust.set', {
        ...target,
        server: server.name,
        identityDigest: server.identityDigest,
        scope,
        trusted,
        ...(scope === 'session' ? {} : { version: snapshot.version }),
        ...(trusted ? { confirmTrust: true, confirmExternalAccess: true } : {}),
      }, 30_000);
      await load(true);
      setNote({
        text: trusted
          ? t(`已在${scopeText(scope, t)}信任 ${server.name}。工具调用仍受当前 Policy 与外控授权限制。`, `${server.name} is trusted for ${scopeText(scope, t).toLowerCase()}. Tool calls remain subject to Policy and Agent Control limits.`)
          : t(`已撤销${scopeText(scope, t)}对 ${server.name} 的信任。`, `Trust for ${server.name} was revoked at ${scopeText(scope, t).toLowerCase()} scope.`),
        bad: false,
      });
    } catch (error) {
      setNote({ text: t('MCP Server 信任设置没有保存。', 'MCP server trust was not saved.'), code: code(error), bad: true });
      await load(true);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const servers = snapshot?.servers ?? [];

  return <div className="mcp-trust-panel">
    <div className="agent-control-toolbar">
      <span className="agent-control-status">{t(`${servers.length} 个已配置 Server`, `${servers.length} configured servers`)}</span>
      <button type="button" className="rail-refresh" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={13} />{t('重新读取', 'Reload')}</button>
    </div>
    {note !== null && <div className="session-note" data-tone={note.bad ? 'bad' : undefined}>
      <span>{note.text}</span>{note.code !== undefined && <code>{note.code}</code>}
    </div>}
    <p className="agent-control-notice">{t('信任只允许 Ligule 启动本地程序。Server 在 Shell 沙箱外以当前账户运行，可访问该账户的文件和网络；工具仍受 Policy 与外控 Grant 限制。', 'Trust only lets Ligule start the local program. The server runs as this OS user outside the Shell sandbox, with access to that user’s files and network; tool calls remain subject to Policy and Agent Control grants.')}</p>
    <Row label={t('管理范围', 'Trust scope')}>
      <select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as TrustScope)}>
        <option value="session" disabled={sessionId === null}>{scopeText('session', t)}</option>
        <option value="project">{scopeText('project', t)}</option>
        <option value="user">{scopeText('user', t)}</option>
      </select>
    </Row>
    {snapshot === null ? <p className="stub">{t('正在读取 Server…', 'Loading servers…')}</p>
      : servers.length === 0 ? <p className="stub">{t('当前项目没有配置 MCP Server。', 'No MCP servers are configured for this project.')}</p>
        : servers.map((server) => {
          const selected = server.trustScopes[scope];
          const trusted = server.trust?.trusted === true;
          return <section className="mcp-trust-server" key={`${server.name}:${server.identityDigest}`}>
            <div className="mcp-trust-heading">
              <strong>{server.name}</strong>
              <span data-state={trusted ? 'trusted' : 'untrusted'}>
                {server.trust === null
                  ? t('未信任', 'Untrusted')
                  : server.trust.trusted
                    ? t(`已信任：${scopeText(server.trust.scope, t)}`, `Trusted: ${scopeText(server.trust.scope, t)}`)
                    : t(`已在${scopeText(server.trust.scope, t)}阻止`, `Blocked for ${scopeText(server.trust.scope, t)}`)}
              </span>
            </div>
            <details className="catalog-fold mcp-trust-config">
              <summary>{t('程序配置与各层信任', 'Program configuration and trust scopes')}</summary>
              <dl className="mcp-trust-details">
                <dt>{t('程序', 'Program')}</dt><dd><code>{server.command}</code></dd>
                <dt>{t('参数', 'Arguments')}</dt><dd>{server.args.length === 0 ? t('无', 'None') : <code>{server.args.join('\n')}</code>}</dd>
                <dt>{t('工作目录', 'Working directory')}</dt><dd><code>{server.cwd}</code></dd>
                <dt>{t('环境变量名', 'Environment variable names')}</dt><dd>{server.environmentNames.length === 0 ? t('无', 'None') : <code>{server.environmentNames.join(', ')}</code>}</dd>
              </dl>
              <div className="mcp-trust-scopes">
                {(['session', 'project', 'user'] as const).map((item) => <span key={item} data-state={server.trustScopes[item]?.trusted === true ? 'trusted' : server.trustScopes[item]?.trusted === false ? 'blocked' : 'unset'}>
                  {scopeText(item, t)}: {server.trustScopes[item] === null ? t('未设置', 'unset') : server.trustScopes[item]!.trusted ? t('信任', 'trusted') : t('阻止', 'blocked')}
                  {server.trustScopes[item] === null ? null : <> · {t('可信本机界面', 'trusted local UI')}</>}
                </span>)}
              </div>
            </details>
            <div className="inline-field mcp-trust-actions">
              {selected?.trusted === true
                ? <button type="button" className="mini chip danger" disabled={busy} onClick={() => void save(server, false)}>{t(`撤销${scopeText(scope, t)}信任`, `Revoke ${scopeText(scope, t).toLowerCase()} trust`)}</button>
                : <button type="button" disabled={busy || (scope === 'session' && sessionId === null)} onClick={() => setConfirming(server)}>{t(`信任到${scopeText(scope, t)}`, `Trust for ${scopeText(scope, t).toLowerCase()}`)}</button>}
            </div>
          </section>;
        })}

    {confirming !== null && <Modal title={t('信任 MCP Server', 'Trust MCP server')} className="confirm" onClose={() => setConfirming(null)}>
      <h2 className="confirm-lead">{t(`允许启动 ${confirming.name}？`, `Allow ${confirming.name} to start?`)}</h2>
      <p className="confirm-note">{t('它会在 Shell 沙箱外以当前 OS 用户运行。信任记录绑定当前程序配置摘要；配置变化后需要重新信任。MCP 工具的 Policy 授权与外控 Grant 上限仍分别生效。', 'It runs as the current OS user outside the Shell sandbox. Trust is bound to this server configuration; changes require trust again. MCP tool Policy and Agent Control grant limits remain separate.')}</p>
      <div className="confirm-actions">
        <button type="button" onClick={() => setConfirming(null)}>{t('取消', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void save(confirming, true)}>{t('确认信任', 'Trust server')}</button>
      </div>
    </Modal>}
  </div>;
}
