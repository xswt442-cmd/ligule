// 客户端协议那一层的界面侧读法（D30、D31）。方法与事件名的定义在 src/host/protocol.js，
// 这里不复制那张表，只按帧的形状收发：请求带 id 与 method，答复带同一个 id，通报带 notify。
// 传输由外面注入（桌面壳走 Tauri 的命令与事件），这一层不认识载体。

export function createClient({ send }) {
  const pending = new Map();
  const notificationHandlers = [];
  const requestHandlers = [];
  let counter = 0;

  function nextId() {
    counter += 1;
    return String(counter);
  }

  function call(method, params) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(JSON.stringify({ id, method, params }));
    });
  }

  // 答复 Host 发出来的那一次请求（审批）。id 用它给的那个。
  function reply(id, result) {
    send(JSON.stringify({ id, result }));
  }

  function settle(id, message) {
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    pending.delete(id);
    if (message.error !== undefined) {
      const error = new Error(message.error.message ?? message.error.code);
      error.code = message.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
  }

  function receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return { kind: 'unparsed', text };
    }
    if (typeof message.notify === 'string') {
      for (const handle of notificationHandlers) handle(message);
      return { kind: 'notification', message };
    }
    if (typeof message.method === 'string') {
      for (const handle of requestHandlers) handle(message);
      return { kind: 'request', message };
    }
    if (typeof message.id === 'string') {
      settle(message.id, message);
      return { kind: 'response', message };
    }
    return { kind: 'unknown', message };
  }

  return {
    call,
    reply,
    receive,
    onNotification: (handle) => {
      notificationHandlers.push(handle);
      return () => notificationHandlers.splice(notificationHandlers.indexOf(handle), 1);
    },
    onRequest: (handle) => {
      requestHandlers.push(handle);
      return () => requestHandlers.splice(requestHandlers.indexOf(handle), 1);
    },
    // 还没答复的请求数：状态栏用它说「这一轮在等人」。
    waiting: () => pending.size,
  };
}
