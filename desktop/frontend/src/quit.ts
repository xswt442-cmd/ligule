// 界面负责列出退出会影响的活动会话；Electron 壳只负责转发退出请求。
// 此函数只汇总会话状态，不执行退出操作。

export type QuitInput = {
  /** 当前有轮次运行的会话编号。 */
  running: string[];
  /** 存在待答审批的会话编号。 */
  approvals: string[];
  /** 存在待答问题的会话编号。 */
  questions: string[];
  /** 各会话中尚未发送的队列条数。 */
  queued: Record<string, { items: string[] }>;
};

export type QuitRow = { sessionId: string; reasons: string[] };

// 同一会话可能同时有多个待处理状态；将它们合并为一项退出影响说明。
export function blockedSessions(input: QuitInput): QuitRow[] {
  const rows = new Map<string, string[]>();
  const add = (id: string, reason: string) => {
    if (id === '') return;
    rows.set(id, [...(rows.get(id) ?? []), reason]);
  };
  for (const id of input.running) add(id, '一轮在跑');
  for (const id of input.approvals) add(id, '等一次批准');
  for (const id of input.questions) add(id, '等你回答一道题');
  for (const [id, queue] of Object.entries(input.queued)) {
    if (queue.items.length > 0) add(id, `排着 ${queue.items.length} 句没发出去`);
  }
  return [...rows].map(([sessionId, reasons]) => ({ sessionId, reasons }));
}
