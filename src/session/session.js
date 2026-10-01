// 会话记录：一条追加式 JSONL 事件日志是唯一事实源，恢复与重建都从它算出来（D11、I5）。
// 写失败时把长度退回写之前、崩溃留下的半行截掉，这两条照 dsh 的做法，理由与出处记在 todo.md 第 10 步。
// 读写失败都是内核自身的故障（KernelRuntimeError）：记录已经不可信，循环要停住，不当成工具没做成那一类。
import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';

export function createSessionLog({ directory, id }) {
  if (typeof directory !== 'string' || directory === '') throw new KernelError('session_directory_required');
  if (typeof id !== 'string' || id === '') throw new KernelError('session_id_required');
  const path = join(directory, `${id}.jsonl`);
  let nextSeq = 0;

  async function appendOnce(event) {
    const line = `${JSON.stringify({ seq: nextSeq, ...event })}\n`;
    let handle;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(path, 'a');
    } catch (error) {
      throw new KernelRuntimeError('session_write_failed', { cause: error });
    }
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    let size;
    try {
      ({ size } = await handle.stat());
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } catch (error) {
      // 半行留在文件里会让下一次重试用同一个序号写两遍，所以先把长度退回写入之前，再报原错误。
      await close();
      // stat 自己就失败时长度是不知道的，这时什么都不截：截到 0 是把整份记录丢了，
      // 而留下的半行没有换行结尾，read 那一条按崩溃尾截掉，同样不会重复用号。
      try {
        if (size !== undefined) await truncate(path, size);
      } catch (rollbackError) {
        throw new KernelRuntimeError('session_rollback_failed', { cause: rollbackError });
      }
      throw new KernelRuntimeError('session_write_failed', { cause: error });
    }
    await close();
    nextSeq += 1;
    return JSON.parse(line);
  }

  // 并发执行的那一组工具调用会同时往这一份记录里写（D29），序号与退回长度都要按顺序算：
  // 两次写互相插进来，轻则两个事件同一个号，重则一次失败的回滚把另一条已经写好的记录截掉。
  // 读也要排队，它按崩溃尾截长度，与一次在写的追加同时发生就会截掉刚写好的那一行。
  let pending = Promise.resolve();

  // 前一次的结果不决定这一次做不做，所以上一个失败也往下走；失败仍然交回给它自己的调用方。
  function serialize(action) {
    pending = pending.then(action, action);
    return pending;
  }

  function append(event) {
    return serialize(() => appendOnce(event));
  }

  // 读回全部事件。最后一行没有换行结尾时按崩溃留下的半行处理：截掉，不去猜它原本是什么。
  async function readOnce() {
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        nextSeq = 0;
        return [];
      }
      throw new KernelRuntimeError('session_read_failed', { cause: error });
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      // 半行按字节截：崩溃留下的那半截可能是一个不完整的 UTF-8 序列，
      // 先解码成字符串再算字节数就会切错位置。
      bytes = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
      await truncate(path, bytes.length);
    }
    const events = bytes.toString('utf8').split('\n').filter((line) => line !== '').map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new KernelRuntimeError('session_line_invalid', { cause: error });
      }
    });
    nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 0;
    return events;
  }

  return {
    directory,
    path,
    append,
    read: () => serialize(readOnce),

    // 模型上一轮看见的那一份，从记录算出来（I5）。助手那一轮与工具结果都要投影：
    // 请求体里的工具结果要按调用 id 挂在助手那一轮的调用上，只投影工具结果拼不出合法的请求。
    async modelView() {
      const view = [];
      for (const event of await this.read()) {
        if (event.kind === 'user') {
          view.push({ role: 'user', text: event.text });
        } else if (event.kind === 'assistant') {
          view.push({ role: 'assistant', text: event.text, toolCalls: event.toolCalls });
        } else if (event.kind === 'tool') {
          view.push({
            role: 'tool',
            id: event.callId,
            tool: event.tool,
            content: event.result.content,
            failed: event.result.failed,
            code: event.result.code,
          });
        }
      }
      return view;
    },
  };
}
