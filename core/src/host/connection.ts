// 通过两条流传输 JSONL 消息，每行一个 JSON 对象。
// 传输层只识别带 method 的请求、带相同 id 的答复，以及带 notify 的通知，不解释具体方法。
// 请求 ID 按方向分别分配，避免客户端请求和 Host 审批请求冲突。
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { KernelError } from '../kernel/error.js';
import type { ProviderDiagnostic } from '../kernel/error.js';

export interface HostRequest extends Record<string, unknown> {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ConnectionOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly onFault?: (error: Error) => void;
  readonly onClose?: () => void;
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

export function createConnection({ input, output, onFault, onClose }: ConnectionOptions): Connection {
  const responders = new Map<string, Responder>();
  const origin = randomUUID().slice(0, 8);
  let counter = 0;
  let handler: ((message: HostRequest) => unknown | Promise<unknown>) | undefined;
  let notificationHandler: ((message: Record<string, unknown>) => void) | undefined;
  let closed = false;
  let buffer = '';

  function closeConnection(): void {
    if (closed) return;
    closed = true;
    buffer = '';
    input.off('data', onData);
    input.pause();
    // 任一传输流关闭后结束连接并停止接收请求，即使另一方向仍打开。
    for (const settleWith of responders.values()) settleWith.reject(new KernelError('connection_closed'));
    responders.clear();
    onClose?.();
  }

  function fault(error: Error): void {
    // 输入出错时尝试发送错误通知后关闭连接；即使通知失败也必须释放资源。
    try { onFault?.(error); } catch { /* the fault channel may be broken too */ }
    finally { closeConnection(); }
  }

  function write(message: Record<string, unknown>): void {
    // 对端已断开时无需再发送消息；会话记录仍是持久事实来源。
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
      const diagnostics = error.diagnostics;
      try {
        settleWith.reject(new KernelError(code, {
          detail,
          ...(diagnostics === undefined ? {} : { diagnostics: diagnostics as ProviderDiagnostic }),
        }));
      } catch (cause) {
        settleWith.reject(new KernelError('protocol_provider_diagnostics_invalid', { cause }));
      }
    }
    else settleWith.resolve(message.result);
  }

  function handleLine(line: string): void {
    if (closed) return;
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
    // 通知不需要答复，因此只包含通知名称，不包含请求 ID。
    if (typeof message?.notify === 'string' && message.id === undefined) {
      notificationHandler?.(message);
      return;
    }
    if (typeof message?.id !== 'string') {
      onFault?.(new KernelError('protocol_message_unaddressed'));
      return;
    }
    if (typeof message.method === 'string') {
      // 请求交给注入的分发器；错误也以响应帧返回，确保每个请求都有答复。
      const request: HostRequest = { ...message, id: message.id, method: message.method };
      Promise.resolve()
        .then(() => {
          // 关闭期间可能仍有输入行排队，不能再调用有副作用的 Host 方法。
          if (closed) return;
          return handler?.(request);
        })
        .then(
          // 分发器返回 undefined 表示响应由 Host 后续发送，例如等待用户审批。
          // 不能在这里自动响应，否则会把待审批请求误判为拒绝。
          (result) => {
            if (result !== undefined) write({ id: message.id, result });
          },
          // 响应保留稳定错误码、用户可读说明和底层 cause，供客户端区分和诊断。
          (error: unknown) => {
            const fields = isRecord(error) ? error : {};
            const cause = isRecord(fields.cause) ? fields.cause : {};
            const diagnostics = error instanceof KernelError ? error.diagnostics : undefined;
            write({
              id: request.id,
              error: {
                code: messageText(fields.code) ?? 'connection_handler_failed',
                message: messageText(fields.detail) ?? messageText(cause.message) ?? messageText(fields.message),
                ...(diagnostics === undefined ? {} : { diagnostics }),
              },
            });
          },
        );
      return;
    }
    settle(message.id, message);
  }

  function onData(chunk: string | Buffer): void {
    if (closed) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let end = buffer.indexOf('\n');
    while (end >= 0 && !closed) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line !== '') handleLine(line);
      end = buffer.indexOf('\n');
    }
  }

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', () => {
    closeConnection();
  });
  input.on('close', closeConnection);
  input.on('error', fault);
  output.on('close', closeConnection);
  output.on('error', fault);

  return {
    // 请求分发器处理入站请求；通知发送器处理不需要答复的消息。
    onRequest(next) {
      handler = next;
    },

    onNotification(next) {
      notificationHandler = next;
    },

    notify(message) {
      write(message);
    },

    // 响应复用原请求 ID，且不含 method；与通知帧分别编码。
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
