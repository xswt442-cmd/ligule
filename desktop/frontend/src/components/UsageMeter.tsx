import { useState } from 'react';
import type { Usage } from '../status';

// 上下文那一格：抬头只给一条压力线与一个百分比，点开或悬停才是这一份估算的来路（D86、D96）。
// 浮层里每一格都读自 `status.get`，只有本轮计时是界面自己数的（D81 边界二）。
export function UsageMeter({ usage, seconds, running }: { usage: Usage; seconds: number; running: boolean }) {
  const [open, setOpen] = useState(false);
  const share = Math.min(1, usage.estimated / usage.window);
  const pressure = Math.min(1, usage.threshold / usage.window);
  const rows: [string, string][] = [
    ['本地估算', `~${usage.estimated.toLocaleString()} 个记号（${usage.measurement}）`],
    ['窗口', usage.window.toLocaleString()],
    ['压力线', `${usage.threshold.toLocaleString()}（过线就该压）`],
    ['压完保留', usage.retained.toLocaleString()],
    ['修正系数', usage.factor === null ? '还没校准，用的是本地那一份估算' : `×${usage.factor.toFixed(2)}`],
    ['端点报回', usage.reported === null ? '还没有一次报回' : `第 ${usage.reported.seq} 条：入 ${usage.reported.input.toLocaleString()}、出 ${usage.reported.output.toLocaleString()}`],
    ['本轮计时', running ? `${seconds} 秒（界面自己数的）` : '空闲'],
  ];
  return <span className="usage" data-open={open ? 'true' : undefined}>
    <button
      type="button"
      className="usage-trigger"
      title={`本地估算 ~${usage.estimated.toLocaleString()}，窗口 ${usage.window.toLocaleString()}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => setOpen((current) => !current)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        // 关掉浮层就算说完了：这一句不能再往上传，否则正在跑的那一轮会被一起打断（D92 的先后）。
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <span className="usage-bar" data-over={usage.estimated > usage.threshold ? 'true' : undefined}>
        <span className="usage-fill" style={{ width: `${share * 100}%` }} />
        <span className="usage-line" style={{ insetInlineStart: `${pressure * 100}%` }} />
      </span>
      <span className="usage-text">{Math.round(share * 100)}% 已用</span>
    </button>
    {open && <div className="usage-pop" role="dialog" aria-label="上下文用量">
      {rows.map(([label, value]) => <div key={label} className="usage-row">
        <span>{label}</span>
        <b>{value}</b>
      </div>)}
    </div>}
  </span>;
}
