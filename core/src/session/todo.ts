// A todo snapshot belongs to one user turn. Events from older turns remain in
// the session record, but they do not contribute to the active snapshot.
import type { SessionEvent } from './format.js';

export const TODO_MAX_ITEMS = 40;
export const TODO_MAX_ITEM_CHARACTERS = 400;
export const TODO_MAX_LIST_BYTES = 8_000;
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export type TodoStatus = typeof TODO_STATUSES[number];
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export type TodoItemsCheck =
  | { readonly ok: true; readonly items: TodoItem[] }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export interface TodoSnapshot {
  readonly userSeq: number | null;
  readonly items: TodoItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Normalize content once at the boundary so equality checks and persisted
// snapshots use the same exact string.
export function checkedTodoItems(value: unknown): TodoItemsCheck {
  if (!Array.isArray(value)) return { ok: false, code: 'todo_items_invalid', detail: 'items must be an array' };
  if (value.length > TODO_MAX_ITEMS) {
    return { ok: false, code: 'todo_list_too_large', detail: `items may contain at most ${TODO_MAX_ITEMS} entries` };
  }

  const items: TodoItem[] = [];
  const contents = new Set<string>();
  let totalBytes = 0;
  for (const [index, item] of value.entries()) {
    const at = `items[${index}]`;
    if (!isRecord(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'content') || !Object.hasOwn(item, 'status')) {
      return { ok: false, code: 'todo_item_invalid', detail: `${at} must contain only content and status` };
    }
    if (typeof item.content !== 'string') {
      return { ok: false, code: 'todo_item_content_invalid', detail: `${at}.content must be text` };
    }
    const content = item.content.trim();
    if (content === '' || Array.from(content).length > TODO_MAX_ITEM_CHARACTERS) {
      return {
        ok: false,
        code: 'todo_item_content_invalid',
        detail: `${at}.content must contain 1-${TODO_MAX_ITEM_CHARACTERS} non-blank characters`,
      };
    }
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') {
      return { ok: false, code: 'todo_item_status_invalid', detail: `${at}.status is not a supported status` };
    }
    if (contents.has(content)) {
      return { ok: false, code: 'todo_item_duplicate', detail: `${at}.content duplicates an earlier entry` };
    }
    contents.add(content);
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > TODO_MAX_LIST_BYTES) {
      return { ok: false, code: 'todo_list_content_too_large', detail: `combined content exceeds ${TODO_MAX_LIST_BYTES} UTF-8 bytes` };
    }
    items.push({ content, status: item.status });
  }
  return { ok: true, items };
}

export function isCanonicalTodoItems(value: unknown): value is TodoItem[] {
  const checked = checkedTodoItems(value);
  if (!checked.ok || !Array.isArray(value) || checked.items.length !== value.length) return false;
  return checked.items.every((item, index) => {
    const stored = value[index];
    return isRecord(stored) && stored.content === item.content && stored.status === item.status;
  });
}

export function currentTodoSnapshot(events: readonly SessionEvent[]): TodoSnapshot {
  const latestUser = events.findLast((event) => event.kind === 'user');
  if (latestUser === undefined) return { userSeq: null, items: [] };
  const terminalTurn = events.findLast((event) => event.kind === 'turn' && event.userSeq === latestUser.seq);
  if (terminalTurn !== undefined
    && (terminalTurn.status === 'completed' || terminalTurn.status === 'failed' || terminalTurn.status === 'cancelled')) {
    return { userSeq: null, items: [] };
  }
  const latestSnapshot = events.findLast((event) => event.kind === 'todoWrite' && event.userSeq === latestUser.seq);
  if (latestSnapshot === undefined || !isCanonicalTodoItems(latestSnapshot.items)) {
    return { userSeq: latestUser.seq, items: [] };
  }
  return { userSeq: latestUser.seq, items: latestSnapshot.items.map(({ content, status }) => ({ content, status })) };
}
