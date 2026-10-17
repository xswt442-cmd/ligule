// 界面扩展通过类型化槽位注册，Host 不需要写死插件名称。
// 每个槽位由 Host 声明数据类型，插件只能向已声明槽位添加内容。
// Desktop 前端运行在另一个进程，因此维护对应的槽位定义；Host 尚未将槽位内容传给客户端。
import { KernelError } from './error.js';

export interface SlotDefinition {
  readonly name: string;
  accepts(payload: unknown): boolean;
}

export interface SlotRegistry {
  names(): string[];
  register(slotName: string, payload: unknown): () => void;
  list(slotName: string): unknown[];
}

export function createSlotRegistry(slots: readonly SlotDefinition[]): SlotRegistry {
  const declared = new Map<string, (payload: unknown) => boolean>();
  for (const slot of slots) {
    if (typeof slot?.name !== 'string' || slot.name === '') throw new KernelError('slot_name_required');
    if (typeof slot.accepts !== 'function') throw new KernelError('slot_accepts_required');
    declared.set(slot.name, slot.accepts);
  }
  const filled = new Map<string, { payload: unknown }[]>();

  return {
    // 返回 Host 声明的槽位名称，而不是从插件注册项推断。
    names() {
      return [...declared.keys()].sort();
    },

    // 注册返回撤销函数；插件卸载时调用该函数移除自身内容。
    register(slotName: string, payload: unknown) {
      const accepts = declared.get(slotName);
      if (accepts === undefined) throw new KernelError('slot_unknown');
      if (!accepts(payload)) throw new KernelError('slot_payload_rejected');
      const entries = filled.get(slotName) ?? [];
      const entry = { payload };
      entries.push(entry);
      filled.set(slotName, entries);
      return () => {
        const remaining = filled.get(slotName);
        if (!remaining) return;
        const index = remaining.indexOf(entry);
        if (index >= 0) remaining.splice(index, 1);
        if (remaining.length === 0) filled.delete(slotName);
      };
    },

    // Host 按槽位读取内容；未注册内容时返回空数组。
    list(slotName: string) {
      if (!declared.has(slotName)) throw new KernelError('slot_unknown');
      return (filled.get(slotName) ?? []).map((entry) => entry.payload);
    },
  };
}
