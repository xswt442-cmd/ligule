import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Dialog } from 'radix-ui';
import { isCapturing, isComposing } from '../hotkeys';

// 输入法组合或快捷键录制期间，Esc 由当前控件处理，不关闭浮层。
// Radix 在 document 捕获阶段处理 Esc；浮层关闭后仍需阻止事件继续传播。
export function keepEscape(event: KeyboardEvent): void {
  if (isCapturing() || isComposing(event)) event.preventDefault();
}

// 对话框的焦点管理和关闭行为交给 Radix；样式与内容布局由本组件提供。
// 存在可见标题时，辅助标题仅供屏幕阅读器使用；无描述内容时显式设置空的 `aria-describedby`。
// 关闭时将焦点交回打开对话框的元素；若入口无法识别，则由 Radix 恢复焦点。
export function Modal(props: { title: string; className: string; onClose: () => void; children: ReactNode }) {
  const entry = useRef<HTMLElement | null>(null);
  return <Dialog.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content
        className={props.className}
        aria-describedby={undefined}
        onEscapeKeyDown={keepEscape}
        onOpenAutoFocus={() => { entry.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={(event) => {
          const node = entry.current;
          if (node === null) return;
          event.preventDefault();
          node.focus();
        }}
      >
        <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
        {props.children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

// 分区由标题、分隔线和内容行组成。
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="region-group">
    <h3>{title}</h3>
    {children}
  </section>;
}

// 设置页面、审批规则和模型服务共用的字段值与说明结构。
export function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="sheet-row">
    <span className="sheet-label">{label}</span>
    <span className="sheet-value">
      {children}
      {note !== undefined && note !== '' && <span className="sheet-hint">{note}</span>}
    </span>
  </div>;
}
