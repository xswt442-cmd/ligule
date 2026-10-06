import { Fold } from './Fold';
import type { Verbosity } from './types';

// 审批那一格：答的取值只有 allow 与 deny 两种，界面不动判定档位（D81 边界三）。
export type Ask = {
  id: string;
  tool: string;
  // 那一句要动的对象：命令文本、路径、目标地址或那一项 MCP 能力名。
  detail: string;
  change: string;
  reason: string;
  backend: string;
  content: string;
};

export function ApprovalCard({ ask, queued, verbosity, onAnswer }: {
  ask: Ask;
  queued: number;
  verbosity: Verbosity;
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
    <Fold text={ask.content} verbosity={verbosity} />
    <div className="approval-actions">
      <button type="button" onClick={() => onAnswer('allow')}>允许一次</button>
      <button type="button" onClick={() => onAnswer('deny')}>不允许</button>
    </div>
  </section>;
}
