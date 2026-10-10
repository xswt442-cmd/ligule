// 退出前那一句「谁会受影响」由界面说：壳只把请求送过来，哪一份在跑、哪一张卡在等人、哪一份还排着句子
// 只有界面知道（方案 6.4、D24）。这里只算那张清单，不碰退出本身。

export type QuitInput = {
  /** 有轮次在跑的会话编号。 */
  running: string[];
  /** 有一张审批卡等人答的会话编号。 */
  approvals: string[];
  /** 有一道题等人答的会话编号。 */
  questions: string[];
  /** 每份会话自己排着的那几句：只有还没发出去的才算。 */
  queued: Record<string, { items: string[] }>;
};

export type QuitRow = { sessionId: string; reasons: string[] };

// 一份会话可以同时有几件事，那几条并在一行里说完，不占几行让人自己数（同一次退出里同一份会话只说一次）。
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
