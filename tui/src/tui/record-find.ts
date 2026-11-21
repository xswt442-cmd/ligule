import type { TuiRecord } from './transcript.js';

// `/show` 使用稳定的事件序号，不使用可能随投影变化的屏幕行号。
export function findRecord(events: readonly TuiRecord[], argument: string): { readonly code: string } | { readonly record: TuiRecord | null } {
  const seq = Number(argument);
  if (!Number.isInteger(seq) || seq < 0) return { code: 'tui_show_needs_a_number' };
  return { record: events.find((event) => event.seq === seq) ?? null };
}
