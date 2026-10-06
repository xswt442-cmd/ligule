import { Fold } from './Fold';
import type { Verbosity } from './types';

// 审批那一格：答的取值只有 allow 与 deny 两种，界面不动判定档位（D81 边界三）。
export type Ask = {
  id: string;
  tool: string;
  // 那一句要动的对象：命令文本、路径、目标地址或那一项 MCP 能力名。
  detail: string;
  change: string;
  // 判定链给的那一句为什么问，原样显示，不替它改写。
  reason: string;
  backend: string;
  content: string;
};

// 档位那一格说的是现在这一档怎么走到「问人」这一格的。只有 auto 与 ask 两种（D17）。
const TIER: Record<string, string> = {
  auto: '规则表、守卫与命令语法都过关的那一件直接放行，看不透的才问到人',
  ask: '要有放行规则盖住每一个分段才不用问，否则每一件事都问到人',
};

export function ApprovalCard({ ask, queued, verbosity, policy, onAnswer }: {
  ask: Ask;
  queued: number;
  verbosity: Verbosity;
  policy: string;
  onAnswer: (decision: 'allow' | 'deny') => void;
}) {
  return <section className="approval" aria-label="要人答应的调用">
    <div className="approval-head">
      <span className="approval-kind">要执行</span>
      <code className="row-tool">{ask.tool}</code>
      {ask.backend !== '' && <span className="row-note">{ask.backend}</span>}
      {queued > 0 && <span className="row-note">还有 {queued} 条在问</span>}
    </div>
    {ask.detail !== '' && <div className="row-target">{ask.detail}</div>}
    {ask.change !== '' && <div className="row-target">{ask.change}</div>}
    {ask.reason !== '' && <p className="approval-reason">{ask.reason}</p>}
    <Fold text={ask.content} verbosity={verbosity} always label="看改动" />
    <div className="approval-actions">
      <button type="button" data-tone="allow" onClick={() => onAnswer('allow')}>允许一次</button>
      <button type="button" data-tone="deny" onClick={() => onAnswer('deny')}>不允许</button>
      <span className="approval-tier">档位 {policy}：{TIER[policy] ?? '读不到那一档'}</span>
    </div>
  </section>;
}
