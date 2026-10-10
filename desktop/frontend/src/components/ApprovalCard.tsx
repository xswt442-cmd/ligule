import { Fold } from './Fold';
import type { Verbosity } from './types';
import { useText } from '../locale';

export type Ask = {
  id: string;
  sessionId: string;
  project: string;
  tool: string;
  detail: string;
  change: string;
  reason: string;
  backend: string;
  policy: string;
  policySource: string;
  policyForced: boolean;
  content: string;
};

const TIER: Record<string, [string, string]> = {
  auto: ['自动档不使用放行规则；守卫或命令语法无法判定的操作会请求审批。', 'Auto mode ignores allow rules. Operations that guards or command parsing cannot decide require approval.'],
  ask: ['逐次询问档需要一条放行规则覆盖整条命令的每个分段，其他操作都请求审批。', 'Ask mode requires one allow rule to cover every part of the command; other operations require approval.'],
};

const tierSource = (ask: Ask, t: (chinese: string, english: string) => string): string => ask.policyForced
  ? t('连续拒绝已将本会话切到逐次询问。', 'Repeated denials switched this session to ask mode.')
  : ask.policySource === 'session' ? t('本会话的临时设置', 'Session override')
    : ask.policySource === 'config' ? t('配置默认值', 'Configuration default')
      : t('来源未提供', 'Source not provided');

export function ApprovalCard({ ask, queued, verbosity, active, onAnswer, onOpen }: {
  ask: Ask;
  queued: number;
  verbosity: Verbosity;
  active: string | null;
  onAnswer: (decision: 'allow' | 'deny') => void;
  onOpen: (sessionId: string) => void;
}) {
  const t = useText();
  const background = ask.sessionId !== active;
  const tier = TIER[ask.policy];
  return <section className="approval" aria-label={t('等待审批的操作', 'Action awaiting approval')}>
    <div className="approval-body">
      <div className="approval-head">
        <span className="approval-kind">{background ? t('另一会话请求审批', 'Another session requests approval') : t('请求审批', 'Approval requested')}</span>
        <code className="row-tool">{ask.tool}</code>
        {ask.project !== '' && <span className="row-note">{t('项目', 'Project')} {ask.project}</span>}
        {ask.backend !== '' && <span className="row-note">{t('服务', 'Service')} {ask.backend}</span>}
        {queued > 0 && <span className="row-note">{t(`后面还有 ${queued} 条`, `${queued} more queued`)}</span>}
        {background && <button type="button" onClick={() => onOpen(ask.sessionId)}>{t('打开会话', 'Open session')} {ask.sessionId.slice(0, 8)}</button>}
      </div>
      {ask.detail !== '' && <div className="row-target">{ask.detail}</div>}
      {ask.change !== '' && <div className="row-target">{ask.change}</div>}
      {ask.reason !== '' && <p className="approval-reason">{ask.reason}</p>}
      <Fold text={ask.content} verbosity={verbosity} always label={t('查看完整内容', 'View full content')} />
    </div>
    <div className="approval-actions">
      <button type="button" data-tone="allow" onClick={() => onAnswer('allow')}>{t('允许一次', 'Allow once')}</button>
      <button type="button" data-tone="deny" onClick={() => onAnswer('deny')}>{t('拒绝', 'Deny')}</button>
      <details className="approval-tier">
        <summary>{t('审批依据', 'Approval details')} · {ask.policy === '' ? t('未知档位', 'Unknown tier') : ask.policy} · {tierSource(ask, t)}</summary>
        <p>{tier === undefined ? t('无法读取本次审批档位的说明。', 'The approval tier details are unavailable.') : t(...tier)}</p>
      </details>
    </div>
  </section>;
}
