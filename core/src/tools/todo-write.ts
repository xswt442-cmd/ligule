// The todo list is Session metadata, not a workspace file. Each call replaces
// the current turn's full snapshot while the ignorable event history remains.
import { KernelError } from '../kernel/error.js';
import {
  currentTodoSnapshot, checkedTodoItems, TODO_MAX_ITEM_CHARACTERS, TODO_MAX_ITEMS, TODO_STATUSES,
} from '../session/todo.js';
import type { SessionEvent } from '../session/format.js';

export interface TodoWriteSession {
  read(): Promise<SessionEvent[]>;
  append(event: Record<string, unknown>): Promise<unknown>;
}

export interface TodoWritePluginDeps {
  readonly session?: TodoWriteSession;
}

function countsOf(items: readonly { readonly status: string }[]) {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const item of items) counts[item.status as keyof typeof counts] += 1;
  return counts;
}

export function createTodoWritePlugin({ session }: TodoWritePluginDeps = {}) {
  return {
    name: 'ligule-todo-write',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'todo_write',
        access: 'read',
        execution: 'serial',
        description: 'Replace the complete todo list for the current user turn. Each item has a non-blank content string and status pending, in_progress, or completed. An empty list clears this turn\'s active list. The list is stored as Session metadata, not written to workspace files.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              maxItems: TODO_MAX_ITEMS,
              description: 'The complete list for this turn; sending a new list replaces the previous snapshot.',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', minLength: 1, maxLength: TODO_MAX_ITEM_CHARACTERS },
                  status: { type: 'string', enum: [...TODO_STATUSES] },
                },
                required: ['content', 'status'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
        async run(args: { items?: unknown }, { signal }: { signal?: AbortSignal } = {}) {
          if (session === undefined) throw new KernelError('todo_session_unavailable');
          if (signal?.aborted) throw new KernelError('loop_cancelled');
          const checked = checkedTodoItems(args.items);
          if (!checked.ok) throw new KernelError(checked.code, { detail: checked.detail });

          const snapshot = currentTodoSnapshot(await session.read());
          if (snapshot.userSeq === null) throw new KernelError('todo_turn_missing');
          if (signal?.aborted) throw new KernelError('loop_cancelled');

          await session.append({
            kind: 'todoWrite',
            ignorable: true,
            userSeq: snapshot.userSeq,
            items: checked.items,
          });
          return {
            items: checked.items,
            total: checked.items.length,
            counts: countsOf(checked.items),
          };
        },
      });
    },
  };
}
