// 传输边界的一种实现（D30）：一条消息一行 JSON，读两端各一条流。
// 参照实现在标准输入输出上就是这么读的（`codex/codex-rs/app-server-transport/src/transport/stdio.rs:73` 按行取 stdin）。
// 这一层不认识协议里的方法名，只认识三种消息：带 method 的请求、带同一 id 而没有 method 的答复、带 notify 的通报。
// 两个方向各自数 id，所以同一时刻客户端的请求与 Host 的审批请求不会撞到同一个号。
import { randomUUID } from 'node:crypto';
import { KernelError } from '../kernel/error.js';

export function createConnection({ input, output, onFault }) {
  const responders = new Map();
  const origin = randomUUID().slice(0, 8);
  let counter = 0;
  let handler = null;
  let notificationHandler = null;
  let closed = false;

  function write(message) {
    // 对端已经不在了：这一条送出去也没人收，丢掉不是故障，会话记录才是事实源（I5）。
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  function settle(id, message) {
    const settleWith = responders.get(id);
    if (settleWith === undefined) return;
    responders.delete(id);
    if (message.error) settleWith.reject(new KernelError(message.error.code, { detail: message.error.message }));
    else settleWith.resolve(message.result);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      onFault?.(new KernelError('protocol_line_invalid', { cause: error }));
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
      Promise.resolve()
        .then(() => handler?.(message))
        .then(
          (result) => write({ id: message.id, result }),
          // 对面按码分支，看得见的解释在 detail 里；底层原因（一个 fetch 失败）在 cause 里，不带上就只剩一个码。
          (error) => write({
            id: message.id,
            error: { code: error.code ?? 'connection_handler_failed', message: error.detail ?? error.cause?.message ?? error.message },
          }),
        );
      return;
    }
    settle(message.id, message);
  }

  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
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
    // 对端不再答复，还没有答复的那些请求要有人接住，否则等它的调用永远悬着。
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

    request(method, params) {
      const id = `${origin}${counter}`;
      counter += 1;
      write({ id, method, params });
      return new Promise((resolve, reject) => responders.set(id, { resolve, reject }));
    },
  };
}
