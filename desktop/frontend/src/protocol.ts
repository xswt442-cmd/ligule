// 桌面客户端按 Host 协议收发请求和通知。方法及参数定义由 `core/src/host/protocol.ts` 维护。
// 请求包含 id 和 method，答复使用相同 id，通知使用 notify 字段。
// Transport 由桌面桥注入，协议客户端不依赖 Electron。
import type {
  HostMethodName,
  HostMethodParamsOf,
  HostMethodResultOf,
} from '@ligule/core';
import type { NotificationBridge } from './notifications';

export type { HostMethodName, HostMethodParamsOf, HostMethodResultOf };

export type Frame = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: string; message?: string };
  notify?: string;
  sessionId?: string;
  requestId?: string;
  progress?: unknown;
  event?: Record<string, unknown>;
  code?: string;
  detail?: string;
};

export type Transport = {
  notifications?: NotificationBridge;
  send: (frame: string) => void;
  onFrame: (handle: (text: string) => void) => void;
  onLog: (handle: (text: string) => void) => void;
  // 传输层错误，例如无法发送协议帧；这类错误不属于协议响应。
  onFault?: (handle: (reason: string) => void) => void | (() => void);
  // 重启后端进程；生产环境由 Electron 壳处理，开发测试传输可自行实现。
  restart?: () => Promise<void>;
  // 首次使用时由 Electron 壳返回默认工作区，必要时创建该目录。
  // 无法获取默认目录时要求用户自行选择，不使用 Host 继承的当前工作目录。
  defaultWorkspace?: () => Promise<string>;
  // 托盘退出、macOS Cmd+Q 和关闭最后一个窗口都会触发此请求。
  // 界面列出受影响的会话并等待用户确认，再调用 `quit` 完成退出；不支持确认的传输不会自行退出。
  onQuit?: (handle: () => void) => void | (() => void);
  quit?: () => Promise<void>;
};

export type Client = {
  // `timeoutMs` 仅限制当前请求，避免全局超时中断长时间模型轮次。
  // 返回按 `HostMethodMap` 推导的协议结果；外部传输仍需在边界做结构校验。
  call: <M extends HostMethodName>(method: M, params: HostMethodParamsOf<M>, timeoutMs?: number) => Promise<HostMethodResultOf<M>>;
  reply: (id: string, result: unknown) => void;
  receive: (text: string) => { kind: string; message?: Frame };
  // 退订函数让界面在重建订阅时能摘掉旧回调，避免同一条通知被处理两次。
  onNotification: (handle: (message: Frame) => void) => () => void;
  onRequest: (handle: (message: Frame) => void) => () => void;
  waiting: () => number;
  counts: () => { sent: number; received: number };
  // Host 进程重启后无法答复旧请求；以稳定错误码结束这些等待，并返回已结束请求数量。
  discard: (reason: string) => number;
};

// 将 Host 错误、客户端生成的超时或传输错误统一为稳定错误码，供界面显示和判断。
export function code(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const shaped = error as { code?: unknown; message?: unknown };
    if (typeof shaped.code === 'string' && shaped.code !== '') return shaped.code;
    if (typeof shaped.message === 'string' && shaped.message !== '') return shaped.message;
  }
  return String(error);
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
      for (const handle of [...notifications]) handle(message);
      return { kind: 'notification', message };
    }
    if (typeof message.method === 'string') {
      for (const handle of [...requests]) handle(message);
      return { kind: 'request', message };
    }
    if (typeof message.id === 'string') {
      settle(message.id, message);
      return { kind: 'response', message };
    }
    return { kind: 'unknown', message };
  }

  transport.onFrame((text) => receive(text));
  transport.onFault?.((reason) => discard(reason || 'host_closed'));

  function discard(reason: string): number {
    let dropped = 0;
    for (const [id, waiter] of [...pending]) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(Object.assign(new Error(reason), { code: reason }));
      dropped += 1;
    }
    return dropped;
  }

  return {
    call<M extends HostMethodName>(method: M, params: HostMethodParamsOf<M>, timeoutMs = 0): Promise<HostMethodResultOf<M>> {
      counter += 1;
      const id = String(counter);
      return new Promise<HostMethodResultOf<M>>((resolve, reject) => {
        const waiter: { resolve: (value: HostMethodResultOf<M>) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
        if (timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            if (pending.delete(id)) reject(Object.assign(new Error('host_unanswered'), { code: 'host_unanswered' }));
          }, timeoutMs);
        }
        pending.set(id, waiter as { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> });
        send({ id, method, params: params as Record<string, unknown> });
      });
    },
    reply(id, result) {
      send({ id, result });
    },
    receive,
    onNotification: (handle) => {
      notifications.push(handle);
      return () => {
        const index = notifications.indexOf(handle);
        if (index >= 0) notifications.splice(index, 1);
      };
    },
    onRequest: (handle) => {
      requests.push(handle);
      return () => {
        const index = requests.indexOf(handle);
        if (index >= 0) requests.splice(index, 1);
      };
    },
    waiting: () => pending.size,
    counts: () => ({ ...counts }),
    discard,
  };
}
