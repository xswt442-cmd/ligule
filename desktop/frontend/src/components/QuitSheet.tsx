import { Modal } from './ui';
import type { QuitRow } from '../quit';
import { useText } from '../locale';

function reasonText(reason: string, t: (chinese: string, english: string) => string): string {
  if (reason === '一轮在跑') return t('一轮正在运行', 'A turn is running');
  if (reason === '等一次批准') return t('等待审批', 'Waiting for approval');
  if (reason === '等你回答一道题') return t('等待回答', 'Waiting for an answer');
  const queued = /^排着 (\d+) 句没发出去$/.exec(reason);
  if (queued !== null) return t(`有 ${queued[1]} 条消息尚未发送`, `${queued[1]} queued message(s) have not been sent`);
  return reason;
}

export function QuitSheet({ rows, onBack, onQuit }: { rows: QuitRow[]; onBack: () => void; onQuit: () => void }) {
  const t = useText();
  return <Modal title={t('退出前确认', 'Confirm exit')} className="confirm" onClose={onBack}>
    <p className="confirm-lead">{t('退出会中断以下会话：', 'Exiting will interrupt these sessions:')}</p>
    <ul className="confirm-list">
      {rows.map((row) => (
        <li key={row.sessionId}>
          <code>{t('会话', 'Session')} {row.sessionId.slice(0, 8)}</code>
          <span>{row.reasons.map((reason) => reasonText(reason, t)).join(' · ')}</span>
        </li>
      ))}
    </ul>
    <p className="confirm-note">{t('草稿和队列会保存在本机。运行中的轮次会被中断，已写入记录的内容会保留。', 'Drafts and queued messages remain on this device. Running turns will be interrupted; recorded content is kept.')}</p>
    <div className="confirm-actions">
      <button type="button" data-tone="stay" onClick={onBack}>{t('返回应用', 'Return to app')}</button>
      <button type="button" data-tone="quit" onClick={onQuit}>{t('中断任务并退出', 'Interrupt and exit')}</button>
    </div>
  </Modal>;
}
