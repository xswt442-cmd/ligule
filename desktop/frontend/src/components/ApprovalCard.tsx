import { useEffect, useState } from 'react';
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
  rememberable?: boolean;
  rememberScopes?: readonly ('session' | 'project' | 'user')[];
  rememberHintKey?: 'tool' | 'command';
  content: string;
  english?: { change: string; content: string };
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

type RememberScope = 'session' | 'project' | 'user';

export function ApprovalCard({ ask, queued, verbosity, active, onAnswer, onOpen }: {
  ask: Ask;
  queued: number;
  verbosity: Verbosity;
  active: string | null;
  onAnswer: (decision: 'allow' | 'deny', rememberScope?: RememberScope) => void;
  onOpen: (sessionId: string) => void;
}) {
  const t = useText();
  const background = ask.sessionId !== active;
  const tier = TIER[ask.policy];
  const [rememberScope, setRememberScope] = useState<'once' | RememberScope>('once');
  const selectedMemoryScope = rememberScope !== 'once' && ask.rememberScopes?.includes(rememberScope) === true ? rememberScope : 'once';
  const rememberHint = ask.rememberHintKey === 'command'
    ? t('命令规则会匹配这条命令的前缀及参数边界。', 'The command rule matches this command prefix at an argument boundary.')
    : t('规则会应用于此工具能力的所有调用参数。', 'The rule applies to this tool capability for all arguments.');
  useEffect(() => setRememberScope('once'), [ask.id]);
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
      {ask.change !== '' && <div className="row-target">{t(ask.change, ask.english?.change ?? ask.change)}</div>}
      {ask.reason !== '' && <p className="approval-reason">{ask.reason}</p>}
      <Fold text={t(ask.content, ask.english?.content ?? ask.content)} verbosity={verbosity} always label={t('查看完整内容', 'View full content')} />
    </div>
    <div className="approval-actions">
      {ask.rememberable === true && ask.rememberScopes !== undefined && ask.rememberScopes.length > 0 && <label className="approval-memory">
        <span>{t('记住到', 'Remember in')}</span>
        <select value={rememberScope} onChange={(event) => setRememberScope(event.target.value as 'once' | RememberScope)}>
          <option value="once">{t('仅这一次', 'This time only')}</option>
          {ask.rememberScopes.map((scope) => <option key={scope} value={scope}>
            {scope === 'session' ? t('当前会话', 'This session') : scope === 'project' ? t('当前项目', 'This project') : t('所有项目', 'All projects')}
          </option>)}
        </select>
      </label>}
      {ask.rememberable === true && ask.rememberScopes !== undefined && ask.rememberScopes.length > 0 && <span className="approval-memory-hint">{rememberHint}</span>}
      <button type="button" data-tone="allow" onClick={() => onAnswer('allow', selectedMemoryScope === 'once' ? undefined : selectedMemoryScope)}>
        {selectedMemoryScope === 'once' ? t('允许一次', 'Allow once') : t('允许并记住', 'Allow and remember')}
      </button>
      <button type="button" data-tone="deny" onClick={() => onAnswer('deny')}>{t('拒绝', 'Deny')}</button>
      <details className="approval-tier">
        <summary>{t('审批依据', 'Approval details')} · {ask.policy === '' ? t('未知档位', 'Unknown tier') : ask.policy} · {tierSource(ask, t)}</summary>
        <p>{tier === undefined ? t('无法读取本次审批档位的说明。', 'The approval tier details are unavailable.') : t(...tier)}</p>
      </details>
    </div>
  </section>;
}
