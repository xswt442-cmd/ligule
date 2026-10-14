// 传输边界的一种实现（D30）：一条消息一行 JSON，读两端各一条流。
// 这一层不认识协议里的方法名，只认识三种消息：带 method 的请求、带同一 id 而没有 method 的答复、带 notify 的通报。
// 两个方向各自数 id，所以同一时刻客户端的请求与 Host 的审批请求不会撞到同一个号。
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { KernelError } from '../kernel/error.js';

export interface HostRequest extends Record<string, unknown> {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ConnectionOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly onFault?: (error: Error) => void;
}

export interface Connection {
  onRequest(handler: (message: HostRequest) => unknown | Promise<unknown>): void;
  onNotification(handler: (message: Record<string, unknown>) => void): void;
  notify(message: Record<string, unknown>): void;
  reply(id: string, result: unknown): void;
  request(method: string, params?: unknown): Promise<unknown>;
}

interface Responder {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function createConnection({ input, output, onFault }: ConnectionOptions): Connection {
  const responders = new Map<string, Responder>();
  const origin = randomUUID().slice(0, 8);
  let counter = 0;
  let handler: ((message: HostRequest) => unknown | Promise<unknown>) | undefined;
  let notificationHandler: ((message: Record<string, unknown>) => void) | undefined;
  let closed = false;

  function write(message: Record<string, unknown>): void {
    // 对端已经不在了：这一条送出去也没人收，丢掉不是故障，会话记录才是事实源（I5）。
    if (closed) return;
    const encoded = JSON.stringify(message);
    if (encoded !== undefined) output.write(`${encoded}\n`);
  }

  function settle(id: string, message: Record<string, unknown>): void {
    const settleWith = responders.get(id);
    if (settleWith === undefined) return;
    responders.delete(id);
    if (message.error) {
      const error = isRecord(message.error) ? message.error : {};
      const code = messageText(error.code) ?? 'protocol_error';
      const detail = messageText(error.message);
      settleWith.reject(new KernelError(code, { detail }));
    }
    else settleWith.resolve(message.result);
  }

  function handleLine(line: string): void {
    let message;
    try {
      const parsed: unknown = JSON.parse(line);
      message = parsed;
    } catch (error) {
      onFault?.(new KernelError('protocol_line_invalid', { cause: error }));
      return;
    }
    if (!isRecord(message)) {
      onFault?.(new KernelError('protocol_message_unaddressed'));
      return;
    }
    // 通报没有人答复，所以它带着名字而没有 id。
    if (typeof message?.notify === 'string' && message.id === undefined) {
      notificationHandler?.(message);
      return;
    }
    if (typeof message?.id !== 'string') {
      onFault?.(new KernelError('protocol_message_unaddressed'));
      return;
    }
    if (typeof message.method === 'string') {
      // 交给装进来的分发器；它报的错误按同一行送回去，请求方永远有一条答复顶着。
      const request: HostRequest = { ...message, id: message.id, method: message.method };
      Promise.resolve()
        .then(() => handler?.(request))
        .then(
          // 分发器交出 undefined 是「这一条我自己答复」：客户端收到审批就是这样，要等人按键之后才回。
          // 在这里自动答一个 undefined 会把对面那一次等待变成一次拒绝。
          (result) => {
            if (result !== undefined) write({ id: message.id, result });
          },
          // 对面按码分支，看得见的解释在 detail 里；底层原因（一个 fetch 失败）在 cause 里，不带上就只剩一个码。
          (error: unknown) => {
            const fields = isRecord(error) ? error : {};
            const cause = isRecord(fields.cause) ? fields.cause : {};
            write({
              id: request.id,
              error: {
                code: messageText(fields.code) ?? 'connection_handler_failed',
                message: messageText(fields.detail) ?? messageText(cause.message) ?? messageText(fields.message),
              },
            });
          },
        );
      return;
    }
    settle(message.id, message);
  }

  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') handleLine(line);
      end = buffer.indexOf('\n');
    }
  });
  input.on('end', () => {
    closed = true;
    // 对端退出后不会再答复：已经发出去、还没答复的那些请求要有明确的收尾，否则等它的调用一直挂着。
    for (const settleWith of responders.values()) settleWith.reject(new KernelError('connection_closed'));
    responders.clear();
  });

  return {
    // 装进来的分发器负责这一侧收到的请求；通报另装一个，它没有答复可交。
    onRequest(next) {
      handler = next;
    },

    onNotification(next) {
      notificationHandler = next;
    },

    notify(message) {
      write(message);
    },

    // 答复对端发出来的那一次请求：带同一个 id 而没有 method，与通报分开写，读的人不用记形状。
    reply(id, result) {
      write({ id, result });
    },

    request(method: string, params?: unknown): Promise<unknown> {
      if (closed) return Promise.reject(new KernelError('connection_closed'));
      const id = `${origin}${counter}`;
      counter += 1;
      return new Promise<unknown>((resolve, reject) => {
        responders.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (error) {
          responders.delete(id);
          reject(error);
        }
      });
    },
  };
}
