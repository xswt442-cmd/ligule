// 上下文压缩（D75、实现顺序第 37 步）：把投影里靠前的那一段交给模型写一份摘要，摘要与它顶掉的范围写进检查点。
// 两条触发分开走：压力那条在请求拼好之后本地量一次（本地估算要用端点上一次交回的真实用量修正，低估会让它永远不响），
// 超长那条只在端点报回之后走，并且整个运行只允许一次压缩加一次重试。事件日志一条都不动（D75）。
import { writeFile } from 'node:fs/promises';
import { checkpointPath, createCheckpoint, loadCheckpoint } from './checkpoint.js';
import { spillContent } from '../kernel/result.js';
import type { SessionEvent } from './format.js';

// 本地估算：按字节的四分之一算 token 数。
// ponytail: 这是一个不认语言的粗算法（中文与代码的字节/词比例差得远），升级路径是接一个真分词器；
// 之所以还能用，是因为它只用来比一个线，而那条线由端点交回的真实用量修正过。
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8') / 4);
}

// 切点：从后往前累加，越过保留预算之后那一条之后的第一个 user 或 assistant 就是切点。
// 切在工具结果上会把上一条助手消息里的那次调用留下没人回答，请求体就不合法了（I5 的投影要能拼出请求）。
// 连一条都放不下的时候（预算比最后一条还小）只能留下最后那一条 user 或 assistant：
// 一个空的投影拼不出请求，而压过头比压不动更可查。
export function cutPoint(events: SessionEvent[], budgetTokens: number, measure: (event: SessionEvent) => number = estimateTokens): number | null {
  let total = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    total += measure(events[index]);
    if (total <= budgetTokens) continue;
    for (let cut = index + 1; cut < events.length; cut += 1) {
      const kind = events[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(events[cut].seq);
    }
    for (let cut = index; cut >= 0; cut -= 1) {
      const kind = events[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(events[cut].seq);
    }
    return null;
  }
  return null;
}

// 交给写摘要那一次的内容是这一段的扁平日志：角色前缀加文本，工具那几条留名字与结果。
function flatten(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind === 'user') lines.push(`user: ${String(event.text ?? '')}`);
    else if (event.kind === 'assistant') {
      const calls = (event.toolCalls as { name?: unknown }[] | undefined) ?? [];
      lines.push(`assistant: ${String(event.text ?? '')}${calls.length === 0 ? '' : ` [called ${calls.map((call) => String(call?.name)).join(', ')}]`}`);
    } else if (event.kind === 'tool') {
      const result = event.result as { content?: unknown; failed?: boolean; code?: string } | undefined;
      const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? null);
      lines.push(`tool ${String(event.tool ?? '')}${result?.failed === true ? ` (${result.code})` : ''}: ${content}`);
    }
  }
  return lines.join('\n\n');
}

const INSTRUCTION = 'Write a summary of the transcript excerpt below so a later agent can continue the work. '
  + 'Keep every path, command, identifier, decision, still-open question and tool outcome that matters. Plain prose, no preamble.\n\n';

// 摘要那一次的输入本身也可能长过窗口：过长的话留后段（近处的事更要紧），前段丢掉的部位留一句话。
// 上一次的摘要不在这段里截：第二次压缩要把它当输入带进去，截掉了就等于把边界之前的事整段丢了。
function fitExcerpt(text: string, budgetTokens: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const limit = budgetTokens * 4;
  if (bytes.length <= limit) return text;
  // 按字节切可能把多字节字符切成一半，那半个字符在下一句里以替换符出现，内容本身没有丢。
  return `[earlier turns dropped from this excerpt]\n${bytes.subarray(bytes.length - limit).toString('utf8')}`;
}

export function createCompaction({ provider, session, directory, id, limits, logger }: {
  provider: { stream: (request: unknown, options?: { signal?: AbortSignal }) => AsyncIterable<unknown> };
  session: { read: () => Promise<SessionEvent[]>; modelView: () => Promise<unknown[]> };
  directory: string;
  id: string;
  limits: { contextTokens: number; compactThresholdRatio: number; compactRetainRatio: number; resultBytes: number };
  logger?: { log?: (message: string, fields?: Record<string, unknown>) => void };
}) {
  if (!(limits.compactRetainRatio < limits.compactThresholdRatio)) {
    throw new Error('compaction_retain_must_be_below_threshold');
  }
  // 压力线与被顶掉那一段的预算都算在窗口上（dsh 那两个比例的形状，`reference-read/dsh.md` 第 5 节）。
  const threshold = Math.floor(limits.contextTokens * limits.compactThresholdRatio);
  const retained = Math.floor(limits.contextTokens * limits.compactRetainRatio);
  // 本地估算与端点真实用量之间的修正系数：一次都没报回来时是 1（那就是压力那条不响的另一种说法）。
  let factor = 1;
  let overflowTried = false;

  async function summarise(events: SessionEvent[], previous: string | undefined, signal?: AbortSignal): Promise<string> {
    // 那一次的请求自己也要放进窗口：预算按修正后的量法算，否则系数大的那一份会把摘要请求本身顶超长。
    const excerpt = `${previous === undefined ? '' : `Earlier summary:\n${previous}\n\n`}${fitExcerpt(flatten(events), Math.max(1, Math.floor((threshold - 1024) / factor)))}`;
    const parts: string[] = [];
    for await (const event of provider.stream(
      { system: '', tools: [], messages: [{ role: 'user', text: `${INSTRUCTION}${excerpt}` }] },
      { signal },
    )) {
      const piece = event as { type?: string; text?: string };
      if (piece?.type === 'text') parts.push(piece.text ?? '');
    }
    return parts.join('').trim();
  }

  // 一次压缩：算切点、请模型写摘要、把摘要与它顶掉的范围写成检查点。做不成时说清是哪一条，交回 null。
  async function compact(signal?: AbortSignal): Promise<{ fromSeq: number; toSeq: number; tokensBefore: number; tokensAfter: number } | null> {
    const events = await session.read();
    const { checkpoint } = await loadCheckpoint({ directory, id, events });
    const fromSeq = checkpoint?.fromSeq ?? 0;
    const tail = events.filter((event) => event.seq >= fromSeq);
    // 切点用的也是修正过的那一份量法：不然压力线按真实用量响，切点按本地字节切，压完还是越线。
    const cut = cutPoint(tail, retained, (event) => estimateTokens(event) * factor);
    if (cut === null) return null;
    const covered = tail.filter((event) => event.seq < cut);
    if (covered.length === 0) return null;
    const tokensBefore = estimateTokens(await session.modelView());
    let text: string;
    try {
      text = await summarise(covered, checkpoint?.text, signal);
    } catch (error) {
      logger?.log?.('compaction summary call failed', { sessionId: id, code: (error as { code?: string }).code });
      return null;
    }
    if (text === '') {
      logger?.log?.('compaction summary came back empty', { sessionId: id });
      return null;
    }
    // 摘要文本受注入那一层的上限约束（I6）：超了整份溢出到文件，检查点里留可取回的引用。
    const kept = await spillContent(text, {
      limit: limits.resultBytes,
      directory,
      name: `summary-${fromSeq}-${cut}.txt`,
    });
    await writeFile(checkpointPath(directory, id), JSON.stringify(
      createCheckpoint({ id, events: covered, text: kept, fromSeq, toSeq: Number(covered[covered.length - 1].seq) }),
    ), 'utf8');
    const after = estimateTokens(await session.modelView());
    // 那两个数是按本地量法算的，比较用的是修正后的那一份：系数一起记出去，读的人才对得上为什么这次会响。
    logger?.log?.('session compacted', {
      sessionId: id,
      fromSeq,
      toSeq: Number(covered[covered.length - 1].seq),
      tokensBefore,
      tokensAfter: after,
      factor: Math.round(factor * 100) / 100,
    });
    return { fromSeq, toSeq: Number(covered[covered.length - 1].seq), tokensBefore, tokensAfter: after };
  }

  // 端点报回超长的那一种：状态码 400 一类里那些说得清是窗口不够的写法。
  function isOverflow(error: unknown): boolean {
    const value = error as { code?: string; detail?: string };
    if (value?.code !== 'provider_http_error' || typeof value.detail !== 'string') return false;
    return /context|token|too long|too many|maximum|length/i.test(value.detail);
  }

  return {
    tokens: () => ({ threshold, retained, factor }),

    // 请求拼好之后量一次压力：越线就先压一次，压完了用新投影。
    async prepare(request: { system: string; tools: unknown; messages: unknown[] }): Promise<unknown[]> {
      if (estimateTokens(request.messages) * factor <= threshold) return request.messages;
      const done = await compact();
      if (done === null) return request.messages;
      return await session.modelView();
    },

    // 超长那条：整个运行只试一次；不是超长、压过一次的、或压不成的都交回 null，让原来那个错误说话。
    async recover(error: unknown, request: { system: string; tools: unknown; messages: unknown[] }, signal?: AbortSignal): Promise<unknown[] | null> {
      if (overflowTried || !isOverflow(error)) return null;
      overflowTried = true;
      logger?.log?.('context reported overflow, compacting once', {
        sessionId: id,
        detail: (error as { detail?: string }).detail?.slice(0, 200),
        estimated: Math.round(estimateTokens(request.messages) * factor),
      });
      const done = await compact(signal);
      if (done === null) {
        logger?.log?.('the one allowed compaction did not happen, the round is abandoned', { sessionId: id });
        return null;
      }
      return await session.modelView();
    },

    // 端点交回真实用量时用它修正本地估算（低估会让压力那条永远不响）。
    // 真实那一份算的是整份请求（系统前缀与工具清单都在内），本地这一份只算消息，所以这一个系数把那两段也带进来了。
    observe(request: { messages: unknown[] }, events: unknown[]): void {
      const usage = (events as { type?: string; input?: unknown }[]).find((event) => event?.type === 'usage');
      const input = Number(usage?.input);
      if (!Number.isFinite(input) || input <= 0) return;
      const local = estimateTokens(request.messages);
      if (local > 0) factor = Math.max(factor, input / local);
    },
  };
}
