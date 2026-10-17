// Desktop 前端的槽位定义与 `core/src/kernel/slots.ts` 保持一致。
// Host 声明槽位数据类型，插件注册内容；卸载时执行注册返回的清理函数。
// 新增面板或状态项只需添加槽位描述，不需修改主渲染流程。
import type { ReactNode } from 'react';

export type Panel<P> = {
  id: string;
  title: string;
  /** 尚未实现的面板，用于显示功能占位说明。 */
  pending?: boolean;
  view: (props: P) => ReactNode;
};

export type Slot = { name: string; accepts: (payload: unknown) => boolean };

export const isPanel = (payload: unknown): boolean => {
  const value = payload as { id?: unknown; title?: unknown; view?: unknown };
  return typeof value?.id === 'string' && typeof value?.title === 'string' && typeof value?.view === 'function';
};

export function createSlotRegistry<P>(slots: Slot[]) {
  const declared = new Map<string, (payload: unknown) => boolean>();
  for (const slot of slots) {
    if (typeof slot?.name !== 'string' || slot.name === '') throw new Error('slot_name_required');
    if (typeof slot.accepts !== 'function') throw new Error('slot_accepts_required');
    declared.set(slot.name, slot.accepts);
  }
  const filled = new Map<string, Panel<P>[]>();

  return {
    names: (): string[] => [...declared.keys()].sort(),

    register(slotName: string, panel: Panel<P>): () => void {
      const accepts = declared.get(slotName);
      if (accepts === undefined) throw new Error(`slot_unknown: ${slotName}`);
      if (!accepts(panel)) throw new Error(`slot_payload_rejected: ${slotName}`);
      const entries = filled.get(slotName) ?? [];
      entries.push(panel);
      filled.set(slotName, entries);
      return () => {
        const remaining = filled.get(slotName);
        if (remaining === undefined) return;
        const index = remaining.indexOf(panel);
        if (index >= 0) remaining.splice(index, 1);
        if (remaining.length === 0) filled.delete(slotName);
      };
    },

    list(slotName: string): Panel<P>[] {
      if (!declared.has(slotName)) throw new Error(`slot_unknown: ${slotName}`);
      return [...(filled.get(slotName) ?? [])];
    },
  };
}

export const SLOTS: Slot[] = [
  { name: 'rail.sessions', accepts: isPanel },
  { name: 'rail.menu', accepts: isPanel },
  { name: 'conversation.composer', accepts: isPanel },
  { name: 'conversation.approval.detail', accepts: isPanel },
  { name: 'header.status', accepts: isPanel },
  { name: 'dock.panels', accepts: isPanel },
];
