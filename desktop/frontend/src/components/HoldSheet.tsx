import { Modal } from './ui';

// 拦住离开的那一句（审阅 G2）：说清是哪几栏还攥着没写进配置的东西，默认那枚是留下——
// radix 进层时把焦点落在第一个能按的东西上，所以「继续编辑」排在前面，「放弃」要人明确按一次。
export function HoldSheet({ lead, reasons, onStay, onLeave }: {
  lead: string;
  reasons: string[];
  onStay: () => void;
  onLeave: () => void;
}) {
  return <Modal title="这里还有没写进配置的编辑" className="confirm" onClose={onStay}>
    <p className="confirm-lead">{lead}</p>
    <ul className="confirm-list">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    <div className="confirm-actions">
      <button type="button" data-tone="stay" onClick={onStay}>继续编辑</button>
      <button type="button" data-tone="discard" onClick={onLeave}>放弃这些修改</button>
    </div>
  </Modal>;
}
