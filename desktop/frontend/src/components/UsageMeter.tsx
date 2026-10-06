import type { Usage } from '../status';

// 上下文那一格：本地估算、窗口与压力线（D82、D86）。估算前面那个波浪号说的是它不是端点给的确数。
const thousands = (value: number) => `${Math.round(value / 100) / 10}k`;

export function UsageMeter({ usage }: { usage: Usage }) {
  const share = Math.min(1, usage.estimated / usage.window);
  const pressure = Math.min(1, usage.threshold / usage.window);
  return <span className="usage" title={`量法 ${usage.measurement}；修正系数 ${usage.factor ?? '还没校准'}`}>
    <span className="usage-bar" data-over={usage.estimated > usage.threshold ? 'true' : undefined}>
      <span className="usage-fill" style={{ width: `${share * 100}%` }} />
      <span className="usage-line" style={{ insetInlineStart: `${pressure * 100}%` }} />
    </span>
    <span className="usage-text">上下文 ~{thousands(usage.estimated)} / {thousands(usage.window)}，压力线 {thousands(usage.threshold)}</span>
  </span>;
}
