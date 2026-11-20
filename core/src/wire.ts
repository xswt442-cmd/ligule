// Host 回复形状的唯一定义。只含类型，客户端按方法名取用同一份，避免各自复制字段表。
// 这里描述 Host 当前实际发送的字段；新增回复时先在此声明，再由 Host 与客户端共同引用。
import type { SessionEvent, SessionHeader } from './session/format.js';

export type { SubrunReference, SubrunStatus } from './tools/subagent.js';

/** `session.read` 的页；`session.observe` 在此基础上带 `writerActive`。 */
export type SessionReadPage = {
  readonly sessionId: string;
  readonly events: SessionEvent[];
  readonly header: SessionHeader | null;
  readonly provisionalOutput?: string | null;
  readonly provisionalOutputError?: string | null;
  readonly label: { readonly name: string; readonly archived: boolean };
  readonly endSeq: number | null;
  readonly hasMore: boolean;
  readonly writerActive?: boolean;
};

/** 控制事件在 wire 上只保证游标与种类，其余字段随事件类型。 */
export type ControlEvent = Readonly<Record<string, unknown> & { readonly cursor: number; readonly kind: string }>;

/** `session.control` 的状态快照；空闲会话只带 `state: 'idle'` 及其事件游标。 */
export type SessionControlSnapshot = {
  readonly sessionId: string;
  readonly state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly ownership?: 'human' | 'external';
  readonly operationId?: string;
  readonly source?: 'human' | 'controller';
  readonly code?: string;
  readonly diagnostics?: unknown;
  readonly summary?: string;
  readonly result?: unknown;
  readonly phase?: string | null;
  readonly waitingFor?: 'approval' | 'input' | null;
  readonly progress?: unknown;
  readonly updatedAt?: number;
  readonly pendingInteractions: readonly {
    readonly requestId: string;
    readonly sessionId: string;
    readonly operationId?: string;
    readonly type: 'approval' | 'question';
    readonly createdAt?: number;
    readonly details: Record<string, unknown>;
  }[];
  readonly events: readonly ControlEvent[];
  readonly nextCursor: number;
  readonly hasMoreEvents: boolean;
  readonly eventGap: boolean;
  readonly firstAvailableCursor: number;
  readonly queue: readonly {
    readonly queueItemId: string;
    readonly acceptedAt: number;
    readonly inputCharacters: number;
    readonly source: 'human' | 'controller';
  }[];
  readonly queuePaused: boolean;
  readonly currentOperationId?: string | null;
};
