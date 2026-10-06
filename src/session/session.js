// 会话记录：一条追加式 JSONL 事件日志是唯一事实源，恢复与重建都从它算出来（D11、I5）。
// 写失败时把长度退回写之前、崩溃留下的半行截掉，这两条做法与 dsh 相同：半行会让下一次重试用同一个序号写两遍。
// 新建的一份先写首行（会话元信息与格式版本），读的时候版本或事件种类读不懂就拒绝重建（D73）。
// 上下文压缩不改动这一份：摘要写进同目录下的另一份文件，投影前按那一段事件重算哈希，对不上就整份不读它（D75）。
// 读写失败都是内核自身的故障（KernelRuntimeError）：记录已经不可信，循环要停住，不当成工具没做成那一类。
import { mkdir, open, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError, KernelRuntimeError } from '../kernel/error.js';
import { loadCheckpoint } from './checkpoint.js';
import { createSessionHeader } from './format.js';
import { readSessionRecord } from './record.js';
import { acquireSessionLock } from './lock.js';

/**
 * @param {{ directory: string, id: string, meta?: { projectRoot?: string, mode?: { name: string, layer: string } } |
 *   (() => { projectRoot?: string, mode?: { name: string, layer: string } } | undefined) }} options
 *   `meta` 是首行那一份会话元信息的来源（D73）：它可以是一个函数，因为建会话的时候常常还没决定用哪份模式清单。
 */
export function createSessionLog({ directory, id, meta }) {
  if (typeof directory !== 'string' || directory === '') throw new KernelError('session_directory_required');
  if (typeof id !== 'string' || id === '') throw new KernelError('session_id_required');
  const path = join(directory, `${id}.jsonl`);
  let nextSeq = 0;
  // 首行只在该写的那一次写：读一遍与写一条都要先知道文件末尾是什么样（D73）。
  // 这里记住两件事——最后一个序号，以及这份文件是不是还空着（没首行也没事件）。
  // 只用一次「先读后写」的顺序就把 needsHeader 关掉是错的：宿主打开一份会话时总是先读一遍记录。
  let needsHeader = false;
  let writableProbed = false;
  let ownership;
  let retained = false;
  let stopped = false;

  async function takeOwnership() {
    if (stopped) throw new KernelRuntimeError('session_closed', { detail: path });
    if (ownership === undefined) {
      ownership = await acquireSessionLock(path);
      writableProbed = false;
    }
    ownership.assertOwned();
  }

  async function loadEvents(repair = false) {
    const record = await readSessionRecord(path);
    if (repair && record.truncatedBytes > 0) await truncate(path, record.completeBytes);
    return record;
  }

  // 第一次动这一份文件之前先看清它的尾部：序号要接在最后一条之后，否则一次恢复后的第一条会与已有的一条同号；
  // 一份空文件（没有首行也没有事件）才是新建，那种才写首行（D73）。
  async function probe() {
    if (writableProbed) return needsHeader;
    const { events, header, lastSeq } = await loadEvents(true);
    nextSeq = lastSeq + 1;
    needsHeader = header === undefined && events.length === 0;
    writableProbed = true;
    return needsHeader;
  }

  async function appendOnce(event) {
    const writeHeader = await probe();
    const written = { seq: nextSeq, ...event };
    const lines = [];
    if (writeHeader) {
      lines.push(JSON.stringify(createSessionHeader({
        id,
        ...(typeof meta === 'function' ? meta() ?? {} : meta ?? {}),
        createdAt: new Date().toISOString(),
      })));
      // 首行占了文件的第一行，但它不占事件的序号：下一条事件仍然从 0 号数起。
      needsHeader = false;
    }
    lines.push(JSON.stringify(written));
    const line = `${lines.join('\n')}\n`;
    let handle;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(path, 'a');
    } catch (error) {
      writableProbed = false;
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
      writableProbed = false;
      // 半行留在文件里会让下一次重试用同一个序号写两遍，所以先把长度退回写入之前，再报原错误。
      await close();
      // stat 自己就失败时长度是不知道的，这时什么都不截：截到 0 是把整份记录丢了，
      // 留下的半行由下一次持有锁的写入检查修复，同样不会重复用号。
      try {
        if (size !== undefined) await truncate(path, size);
      } catch (rollbackError) {
        throw new KernelRuntimeError('session_rollback_failed', { cause: rollbackError });
      }
      throw new KernelRuntimeError('session_write_failed', { cause: error });
    }
    await close();
    nextSeq += 1;
    return written;
  }

  // 并发执行的那一组工具调用会同时往这一份记录里写（D29），序号与退回长度都要按顺序算：
  // 两次写互相插进来，轻则两个事件同一个号，重则一次失败的回滚把另一条已经写好的记录截掉。
  // 同一实例的读取也排队，避免读取尚未写完的追加与更新序号。
  let pending = Promise.resolve();

  // 前一次的结果不决定这一次做不做，所以上一个失败也往下走；失败仍然交回给它自己的调用方。
  function serialize(action) {
    pending = pending.then(action, action);
    return pending;
  }

  function append(event) {
    return serialize(async () => {
      await takeOwnership();
      try {
        return await appendOnce(event);
      } finally {
        if (!retained) {
          const lease = ownership;
          ownership = undefined;
          await lease.release();
        }
      }
    });
  }

  // 读回全部事件。首行那份会话元信息不算事件，它由 header() 单独交出去（D73）。
  // 读也顺手刷新那两个记号：先读后写是宿主的常态（模式去重要先读一遍），不能让一次读把该写的首行挡掉。
  async function readOnce() {
    const { events, header, lastSeq, truncatedBytes } = await loadEvents();
    if (truncatedBytes > 0) writableProbed = false;
    nextSeq = lastSeq + 1;
    needsHeader = header === undefined && events.length === 0;
    return events;
  }

  return {
    directory,
    path,
    append,
    acquire: () => serialize(async () => {
      await takeOwnership();
      retained = true;
    }),
    close: () => serialize(async () => {
      stopped = true;
      retained = false;
      const lease = ownership;
      ownership = undefined;
      if (lease !== undefined) await lease.release();
    }),
    read: () => serialize(readOnce),
    // 没有首行的现存记录读出来是 undefined：那一份按 legacy-v0 读，不被就地补一个头。
    header: () => serialize(async () => (await loadEvents()).header),

    // 模型上一轮看见的那一份，从记录算出来（I5）。助手那一轮与工具结果都要投影：
    // 请求体里的工具结果要按调用 id 挂在助手那一轮的调用上，只投影工具结果拼不出合法的请求。
    // 推理段那一种事件不在这里出现（D32）：它进了记录是为了界面与重开时能看见，不是要回传给模型。
    // 同目录下有一份对得上的检查点时，它顶掉的那一段换成摘要那一条，之后的照原样投（D75）：日志一条都没动。
    async modelView() {
      const events = await this.read();
      const { checkpoint } = await loadCheckpoint({ directory, id, events });
      const view = [];
      let summarized = false;
      for (const event of events) {
        const covered = checkpoint !== null && event.seq >= checkpoint.fromSeq && event.seq <= checkpoint.toSeq;
        if (covered) {
          if (!summarized) {
            view.push({ role: 'user', text: checkpoint.text });
            summarized = true;
          }
          continue;
        }
        if (event.kind === 'user') {
          view.push({ role: 'user', text: event.text });
        } else if (event.kind === 'assistant') {
          view.push({ role: 'assistant', text: event.text, toolCalls: event.toolCalls });
        } else if (event.kind === 'tool') {
          // 拒绝那一条的 reason 是给人的，content 是给模型的：留空字符串，模型只会以为工具通道坏了，
          // 于是把同一件事再问七轮（本机 2026-10-02 实测）。失败时把码与理由拼成一句给模型看。
          const result = event.result;
          const content = result.content === '' && result.failed ? `${result.code}: ${result.reason ?? 'no output'}` : result.content;
          view.push({
            role: 'tool',
            id: event.callId,
            tool: event.tool,
            content,
            failed: result.failed,
            code: result.code,
          });
        }
      }
      return view;
    },
  };
}
