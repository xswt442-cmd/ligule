import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Dialog } from 'radix-ui';
import { isCapturing, isComposing } from '../hotkeys';

// Esc 落在输入法正在拼的那一段、或录一记新键的那一段里时属于它们自己，不替人收层（方案 5.1、6.1）。
// radix 那一张浮层在 document 的捕获阶段接 Esc，收层之后不中断传播，所以这一条要把按键交回去。
export function keepEscape(event: KeyboardEvent): void {
  if (isCapturing() || isComposing(event)) event.preventDefault();
}

// 弹窗外壳：焦点限制与收起交给 radix，样式与信息组织仍写在本项目这一侧（方案 4.2）。
// 界面上另有一处看得见的标题时，`title` 只给读屏器念。这一类对话框没有描述那一格，显式交出
// `aria-describedby` 空值，radix 才不报缺。
// 关闭后把焦点交回打开它的那一格（方案 4.1 详情区那一条验收）：进层前谁带着焦点就记在 `entry`，
// 收层时交回去。层内自己就带了焦点的那一种（命令面板的过滤框在进层时抢下焦点）记不到入口，这一条不接手，
// 交回 radix 自己那一份。
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

// 一个分区：一句标题 + 一条分隔 + 里面的行。屏幕上先看到分区名，再逐行看取值。
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="region-group">
    <h3>{title}</h3>
    {children}
  </section>;
}

// 一格里读到的值与它的说明：设置、审批规则、模型与端点三处共用同一种形状。
export function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="sheet-row">
    <span className="sheet-label">{label}</span>
    <span className="sheet-value">
      {children}
      {note !== undefined && note !== '' && <span className="sheet-hint">{note}</span>}
    </span>
  </div>;
}
