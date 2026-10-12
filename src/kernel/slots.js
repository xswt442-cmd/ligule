// 类型化槽位注册表（I7）：界面内容全部经注册表挂载，宿主不硬编码任何插件的名字。
// 槽位里放的是不透明载荷：宿主声明每个槽位收什么形状，插件只往已声明的槽位挂东西。
// 界面在另一个进程里，读不到这一张表（D30），所以桌面壳的前端自己声明了一份同形状的（`desktop/frontend/slots.js`）；
// 把这一张表里的内容交回客户端还没有做，等的是宿主侧真的有东西可挂。
import { KernelError } from './error.js';

export function createSlotRegistry(slots) {
  const declared = new Map();
  for (const slot of slots) {
    if (typeof slot?.name !== 'string' || slot.name === '') throw new KernelError('slot_name_required');
    if (typeof slot.accepts !== 'function') throw new KernelError('slot_accepts_required');
    declared.set(slot.name, slot.accepts);
  }
  const filled = new Map();

  return {
    // 宿主声明过的槽位名，从这里读，不是从插件的注册动作里推断。
    names() {
      return [...declared.keys()].sort();
    },

    // 注册返回反注册动作；插件卸载时走这一个动作，槽位表里不残留它的东西。
    register(slotName, payload) {
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

    // 宿主渲染时按槽位取内容；没有内容时返回空数组。
    list(slotName) {
      if (!declared.has(slotName)) throw new KernelError('slot_unknown');
      return (filled.get(slotName) ?? []).map((entry) => entry.payload);
    },
  };
}
