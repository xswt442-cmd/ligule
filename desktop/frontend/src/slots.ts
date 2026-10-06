// 界面这一侧的槽位注册表，与内核那份同一形状（I7、`src/kernel/slots.js`）：
// 宿主先声明槽位收什么，内容再挂进来；卸载走注册返回的那个动作，表里不留残迹。
// 加一个面板、一枚状态标记就是多注册一项描述，渲染主干不动。
import type { ReactNode } from 'react';

export type Panel<P> = {
  id: string;
  title: string;
  /** 还没有实现的面板：菜单里看得见，点开说的是缺的那一件在哪。 */
  pending?: boolean;
  view: (props: P) => ReactNode;
};

export type Slot = { name: string; accepts: (payload: unknown) => boolean };

export const isPanel = (payload: unknown): boolean => {  const value = payload as { id?: unknown; title?: unknown; view?: unknown };
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
