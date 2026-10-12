import { Modal } from './ui';
import { useText } from '../locale';

export function HoldSheet({ lead, reasons, onStay, onLeave }: {
  lead: string;
  reasons: string[];
  onStay: () => void;
  onLeave: () => void;
}) {
  const t = useText();
  return <Modal title={t('这里还有未保存的修改', 'Unsaved changes')} className="confirm" onClose={onStay}>
    <p className="confirm-lead">{lead}</p>
    <ul className="confirm-list">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    <div className="confirm-actions">
      <button type="button" data-tone="stay" onClick={onStay}>{t('继续编辑', 'Keep editing')}</button>
      <button type="button" data-tone="discard" onClick={onLeave}>{t('放弃这些修改', 'Discard changes')}</button>
    </div>
  </Modal>;
}
