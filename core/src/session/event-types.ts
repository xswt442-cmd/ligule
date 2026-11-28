export interface SessionEvent {
  seq: number;
  kind?: string;
  [key: string]: unknown;
}

// 追加前的事件不含序号；写入时由 Session 分配。
export type PendingSessionEvent = Omit<SessionEvent, 'seq'>;
