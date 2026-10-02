// 界面这一侧的槽位注册表，与内核那份同一形状（I7、`src/kernel/slots.js`）：
// 宿主先声明槽位收什么，内容再挂进来；卸载走注册返回的那个动作，表里不留残迹。
// app.js 把自己实现的行、标记与面板注册进来；以后往桌面版加功能就是多注册一项，渲染主干不动。

export const PANEL = (payload) => typeof payload?.id === 'string'
  && typeof payload?.title === 'string'
  && typeof payload?.render === 'function';

export const ROW = (payload) => typeof payload?.kind === 'string' && typeof payload?.render === 'function';

export function createSlotRegistry(slots) {
  const declared = new Map();
  for (const slot of slots) {
    if (typeof slot?.name !== 'string' || slot.name === '') throw new Error('slot_name_required');
    if (typeof slot.accepts !== 'function') throw new Error('slot_accepts_required');
    declared.set(slot.name, slot.accepts);
  }
  const filled = new Map();

  return {
    names() {
      return [...declared.keys()].sort();
    },

    register(slotName, payload) {
      const accepts = declared.get(slotName);
      if (accepts === undefined) throw new Error(`slot_unknown: ${slotName}`);
      if (!accepts(payload)) throw new Error(`slot_payload_rejected: ${slotName}`);
      const entries = filled.get(slotName) ?? [];
      const entry = { payload };
      entries.push(entry);
      filled.set(slotName, entries);
      return () => {
        const remaining = filled.get(slotName);
        if (remaining === undefined) return;
        const index = remaining.indexOf(entry);
        if (index >= 0) remaining.splice(index, 1);
        if (remaining.length === 0) filled.delete(slotName);
      };
    },

    list(slotName) {
      if (!declared.has(slotName)) throw new Error(`slot_unknown: ${slotName}`);
      return (filled.get(slotName) ?? []).map((entry) => entry.payload);
    },
  };
}

// 宿主声明的槽位。名字按 dsh 的那一套读法（`conversation.composer`、`conversation.approval.detail`），
// 以后往桌面版加功能就是往这里挂东西，不改渲染主干。
export const SLOTS = [
  { name: 'rail.sessions', accepts: PANEL },
  { name: 'rail.menu', accepts: PANEL },
  { name: 'conversation.composer', accepts: PANEL },
  { name: 'conversation.approval.detail', accepts: PANEL },
  { name: 'conversation.rows', accepts: ROW },
  { name: 'header.status', accepts: PANEL },
  { name: 'dock.panels', accepts: PANEL },
];
