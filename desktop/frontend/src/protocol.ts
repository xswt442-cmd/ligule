// 客户端协议这一层的界面侧读法（D30、D33）。方法与参数模式的定义在后端（`src/host/protocol.js`），
// 这里不复制那张表，只按帧的形状收发：请求带 id 与 method，答复带同一个 id，通报带 notify。
// 传输由外面交进来（桌面壳走 Tauri 的命令与事件），这一层不认识载体。

export type Frame = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: string; message?: string };
  notify?: string;
  sessionId?: string;
  event?: Record<string, unknown>;
  code?: string;
  detail?: string;
};

export type Transport = {
  send: (frame: string) => void;
  onFrame: (handle: (text: string) => void) => void;
  onLog: (handle: (text: string) => void) => void;
  // 载体自己报的故障：帧发不出去了。协议帧里没有这一类，所以它从载体那一侧进来。
  onFault?: (handle: (reason: string) => void) => void;
};

export type Client = {
  // timeoutMs 只给那一个调用用：一轮模型跑几分钟是正常事，不能拿一个全局上限去砍它。
  // 交回来的是帧里那一格 result，这一层不认识它的形状，所以每个调用方自己说明读成什么。
  call: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  reply: (id: string, result: unknown) => void;
  receive: (text: string) => { kind: string; message?: Frame };
  onNotification: (handle: (message: Frame) => void) => void;
  onRequest: (handle: (message: Frame) => void) => void;
  waiting: () => number;
  counts: () => { sent: number; received: number };
};

// 界面上要说得出的是那一个稳定码（D93）。宿主回的错误带码，客户端自己造的错误（超时、载体断了）只有 message，
// 再外面一层可能什么都不是；这一处把三种形状收敛成一个码。
export function code(error: unknown): string {
  const shaped = error as { code?: string; message?: string };
  return shaped.code ?? shaped.message ?? String(error);
}

export function createClient(transport: Transport): Client {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  const notifications: Array<(message: Frame) => void> = [];
  const requests: Array<(message: Frame) => void> = [];
  let counter = 0;
  const counts = { sent: 0, received: 0 };

  function send(frame: Frame): void {
    counts.sent += 1;
    transport.send(JSON.stringify(frame));
  }

  function settle(id: string, message: Frame): void {
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    pending.delete(id);
    if (message.error !== undefined) {
      const error = new Error(message.error.message ?? message.error.code ?? 'failed');
      (error as Error & { code?: string }).code = message.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
  }

  function receive(text: string): { kind: string; message?: Frame } {
    counts.received += 1;
    let message: Frame;
    try {
      message = JSON.parse(text) as Frame;
    } catch {
      return { kind: 'unparsed' };
    }
    if (typeof message.notify === 'string') {
      for (const handle of notifications) handle(message);
      return { kind: 'notification', message };
    }
    if (typeof message.method === 'string') {
      for (const handle of requests) handle(message);
      return { kind: 'request', message };
    }
    if (typeof message.id === 'string') {
      settle(message.id, message);
      return { kind: 'response', message };
    }
    return { kind: 'unknown', message };
  }

  transport.onFrame((text) => receive(text));

  return {
    call(method, params, timeoutMs = 0) {
      counter += 1;
      const id = String(counter);
      return new Promise((resolve, reject) => {
        const waiter: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
        if (timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            if (pending.delete(id)) reject(Object.assign(new Error('host_unanswered'), { code: 'host_unanswered' }));
          }, timeoutMs);
        }
        pending.set(id, waiter);
        send({ id, method, params });
      });
    },
    reply(id, result) {
      send({ id, result });
    },
    receive,
    onNotification: (handle) => {
      notifications.push(handle);
    },
    onRequest: (handle) => {
      requests.push(handle);
    },
    waiting: () => pending.size,
    counts: () => ({ ...counts }),
  };
}
