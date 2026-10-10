import { Modal } from './ui';
import type { QuitRow } from '../quit';

// 退出前那一张确认（方案 6.4）：把受影响的会话一列列说出来，默认那枚是「返回应用」，
// 另一枚才是「中断任务并退出」。radix 进层时把焦点放在第一个能按的东西上，所以「返回应用」排在前面。
export function QuitSheet({ rows, onBack, onQuit }: { rows: QuitRow[]; onBack: () => void; onQuit: () => void }) {
  return <Modal title="退出之前先看看这几份会话" className="confirm" onClose={onBack}>
    <p className="confirm-lead">现在退出会打断这几份会话：</p>
    <ul className="confirm-list">
      {rows.map((row) => (
        <li key={row.sessionId}>
          <code>会话 {row.sessionId.slice(0, 8)}</code>
          <span>{row.reasons.join('、')}</span>
        </li>
      ))}
    </ul>
    <p className="confirm-note">草稿与排着的句子留在本机，下一次打开还在。跑着的那一轮会被打断，已经落进记录的内容不丢。</p>
    <div className="confirm-actions">
      <button type="button" data-tone="stay" onClick={onBack}>返回应用</button>
      <button type="button" data-tone="quit" onClick={onQuit}>中断任务并退出</button>
    </div>
  </Modal>;
}
