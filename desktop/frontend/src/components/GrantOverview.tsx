import { useText } from '../locale';
import { Row } from './ui';
import type { Grant } from './agent-control-types';

export function GrantOverview({ grant, state, copied, disabled, onCopy, onRevoke }: {
  grant: Grant;
  state: string;
  copied: boolean;
  disabled: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const t = useText();
  return <details className="catalog-fold grant-inspector" open>
    <summary>{grant.name} · {state}</summary>
    <p className="catalog-current">{grant.projectRoot}</p>
    <div className="grant-summary-grid">
      <Row label={t('文件与命令', 'Files and commands')}><span>{grant.defaultPermissionProfile} / {grant.maxPermissionProfile}</span></Row>
      <Row label={t('网络', 'Network')}><span>{grant.defaultNetwork} / {grant.maxNetwork}</span></Row>
      <Row label="Policy"><span>{grant.defaultPolicy} · {grant.allowedPolicies.join(', ')}</span></Row>
      <Row label={t('MCP 范围', 'MCP scope')}><span>{grant.allowedMcpServers.length} {t('Server', 'servers')} · {grant.allowedMcpTools.length} {t('工具', 'tools')}</span></Row>
      <Row label={t('有效期', 'Expires')}><span>{grant.expiresAt === null ? t('无期限', 'No expiry') : new Date(grant.expiresAt).toLocaleString()}</span></Row>
      <Row label={t('普通审批代答', 'Operator replies')}><span>{grant.allowOperator ? t('允许', 'Allowed') : t('关闭', 'Disabled')}</span></Row>
      <Row label={t('屏幕截图', 'Screen capture')}><span>{grant.allowScreenCapture === true ? t('单独授权', 'Explicitly allowed') : t('关闭', 'Disabled')}</span></Row>
    </div>
    <details className="catalog-fold">
      <summary>{t('授权详情与连接配置', 'Grant details and connection')}</summary>
      <code>{grant.id}</code>
      <p>{t('创建', 'Created')}: {new Date(grant.createdAt).toLocaleString()} · {t('来源', 'Source')}: {grant.source === 'trusted-ui' ? t('可信界面创建', 'Trusted UI') : t('历史来源未记录', 'Legacy source not recorded')}</p>
      <p>{t('允许的 MCP Server', 'Allowed MCP servers')}: {grant.allowedMcpServers.join(', ') || t('无', 'none')}</p>
      <p>{t('允许的 MCP 工具', 'Allowed MCP tools')}: {grant.allowedMcpTools.join(', ') || t('无', 'none')}</p>
      <p>{t('运行会话能力仍受操作系统 Sandbox、Policy、Server 信任及本授权上限共同约束。', 'Runtime capability remains subject to OS sandboxing, Policy, server trust, and this grant’s ceilings.')}</p>
      <button type="button" className="mini chip" onClick={onCopy}>{copied ? t('已复制配置', 'Configuration copied') : t('复制 MCP 配置', 'Copy MCP config')}</button>
    </details>
    {grant.revokedAt === null && <button type="button" className="mini chip danger" disabled={disabled} onClick={onRevoke}>{t('撤销授权', 'Revoke grant')}</button>}
  </details>;
}
