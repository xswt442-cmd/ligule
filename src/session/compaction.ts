// 上下文压缩（D75、实现顺序第 37 步）：把投影里靠前的那一段交给模型写一份摘要，摘要与它顶掉的范围写进检查点。
// 两条触发分开走：压力那条在请求拼好之后本地量一次（本地估算要用端点上一次交回的真实用量修正，低估会让它永远不响），
// 超长那条只在端点报回之后走，并且整个运行只允许一次压缩加一次重试。事件日志一条都不动（D75）。
import { writeFile } from 'node:fs/promises';
import { checkpointPath, createCheckpoint, loadCheckpoint } from './checkpoint.js';
import { spillContent } from '../kernel/result.js';
import { KernelError } from '../kernel/error.js';
import type { SessionEvent } from './format.js';
import { estimateRequest, estimateTokens, usageEvent } from './usage.js';
export { estimateRequest, estimateTokens } from './usage.js';

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
  + 'Keep every decision, still-open question, tool outcome, path, command, code fragment and identifier that matters; write each of them exactly as it appeared. '
  + 'Write the prose in the language the conversation is written in, or the language it asks for. Plain prose, no preamble.\n\n';

// 摘要那一次的输入本身也可能长过窗口：过长的话留后段（近处的事更要紧），前段丢掉的部位留一句话。
// 上一次的摘要不在这段里截：第二次压缩要把它当输入带进去，截掉了就等于把边界之前的事整段丢了。
function fitExcerpt(text: string, budgetTokens: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const limit = budgetTokens * 4;
  if (bytes.length <= limit) return text;
  // 按字节切可能把多字节字符切成一半，那半个字符在下一句里以替换符出现，内容本身没有丢。
  return `[earlier turns dropped from this excerpt]\n${bytes.subarray(bytes.length - limit).toString('utf8')}`;
}

export function createCompaction({ provider, session, directory, id, limits, logger, requestPrefix = () => ({ system: '', tools: [] }) }: {
  provider: { stream: (request: unknown, options?: { signal?: AbortSignal }) => AsyncIterable<unknown> };
  session: {
    read: () => Promise<SessionEvent[]>;
    modelView: () => Promise<unknown[]>;
    // 用量落进记录要有这一件（D82）；只读的那几处（列表、检查）建出来的压缩件不写。
    append?: (event: Record<string, unknown>) => Promise<unknown>;
  };
  directory: string;
  id: string;
  limits: { contextTokens: number; compactThresholdRatio: number; compactRetainRatio: number; resultBytes: number };
  logger?: { log?: (message: string, fields?: Record<string, unknown>) => void };
  requestPrefix?: () => { system: string; tools: unknown };
}) {
  if (!(limits.compactRetainRatio < limits.compactThresholdRatio)) {
    throw new Error('compaction_retain_must_be_below_threshold');
  }
  // 压力线与保留预算使用同一个窗口（D75）。
  const threshold = Math.floor(limits.contextTokens * limits.compactThresholdRatio);
  const retained = Math.floor(limits.contextTokens * limits.compactRetainRatio);
  // 本地估算与端点真实用量之间的修正系数：一次都没报回来时是 1（那就是压力那条不响的另一种说法）。
  let factor = 1;
  let overflowTried = false;

  // 记录里最后一条 `usage` 事件算出系数（D82）：重开一份会话不该从「从没校准过」重新开始。
  // 那一条同时留着当时那次本地估算，所以系数能从记录本身算回来，不需要上一次进程还在内存里的东西。
  let seeded = false;
  async function lastUsage(): Promise<SessionEvent | null> {
    const events = await session.read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === 'usage') return events[index];
    }
    return null;
  }

  async function seedFromRecord(): Promise<void> {
    if (seeded) return;
    seeded = true;
    const usage = await lastUsage();
    if (usage === null || usage.measurement !== 'request-v1') return;
    const input = Number(usage.input);
    const estimated = Number(usage.estimated);
    if (Number.isFinite(input) && input > 0 && Number.isFinite(estimated) && estimated > 0) {
      factor = input / estimated;
    }
  }

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
    await seedFromRecord();
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
      if (signal?.aborted) throw new KernelError('loop_cancelled', { cause: error });
      throw error;
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
    // 压完不比压之前小就不要压：一份把 25 token 换成 144 token 的检查点只是多一个要校验的文件，
    // 而它顶着的那一段历史再也不会被模型读到。手动那一条尤其要说清「压不动」。
    const remaining = tail.filter((event) => event.seq >= cut);
    const tokensAfter = estimateTokens(kept) + remaining.reduce((sum, event) => sum + estimateTokens(event), 0);
    if (tokensAfter >= tokensBefore) {
      logger?.log?.('compaction would not shrink the projection, skipping', {
        sessionId: id, tokensBefore, tokensAfter, covered: covered.length,
      });
      return null;
    }
    await writeFile(checkpointPath(directory, id), JSON.stringify(
      createCheckpoint({ id, events: covered, text: kept, fromSeq, toSeq: Number(covered[covered.length - 1].seq) }),
    ), 'utf8');
    // 那两个数是按本地量法算的，比较用的是修正后的那一份：系数一起记出去，读的人才对得上为什么这次会响。
    logger?.log?.('session compacted', {
      sessionId: id,
      fromSeq,
      toSeq: Number(covered[covered.length - 1].seq),
      tokensBefore,
      tokensAfter,
      factor: Math.round(factor * 100) / 100,
    });
    return { fromSeq, toSeq: Number(covered[covered.length - 1].seq), tokensBefore, tokensAfter };
  }

  // 端点报回超长的那一种：状态码 400 一类里那些说得清是窗口不够的写法。
  function isOverflow(error: unknown): boolean {
    const value = error as { code?: string; detail?: string };
    if (value?.code !== 'provider_http_error' || typeof value.detail !== 'string') return false;
    return /context|token|too long|too many|maximum|length/i.test(value.detail);
  }

  return {
    tokens: () => ({ threshold, retained, factor }),

    // 状态行与命令行读的那一份：窗口、压力线、当前投影的估算，加上记录里最后一次报回的用量（D82）。
    async context(): Promise<{
      window: number;
      threshold: number;
      retained: number;
      estimated: number;
      factor: number;
      reported: { seq: number; input: number; output: number | null } | null;
    }> {
      await seedFromRecord();
      const usage = await lastUsage();
      const input = usage === null ? Number.NaN : Number(usage.input);
      const output = usage === null || !Number.isFinite(Number(usage.output)) ? null : Number(usage.output);
      const view = await session.modelView();
      return {
        window: limits.contextTokens,
        threshold,
        retained,
        estimated: Math.round(estimateRequest({ ...requestPrefix(), messages: view }) * factor),
        factor: Math.round(factor * 100) / 100,
        reported: usage === null || !Number.isFinite(input)
          ? null
          : { seq: Number(usage.seq), input, output },
      };
    },

    // 手动那一条（D83）：轮没在跑的时候压一次，压不动就说清压不动。
    compactNow: (signal?: AbortSignal) => compact(signal),

    // 请求拼好之后量一次压力：越线就先压一次，压完了用新投影。
    async prepare(request: { system: string; tools: unknown; messages: unknown[] }, signal?: AbortSignal): Promise<unknown[]> {
      await seedFromRecord();
      if (estimateRequest(request) * factor <= threshold) return request.messages;
      const done = await compact(signal);
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
        estimated: Math.round(estimateRequest(request) * factor),
      });
      const done = await compact(signal);
      if (done === null) {
        logger?.log?.('the one allowed compaction did not happen, the round is abandoned', { sessionId: id });
        return null;
      }
      return await session.modelView();
    },

    // 端点交回真实用量时用它修正本地估算（低估会让压力那条永远不响），并把这一格落进记录（D82）。
    // 端点读数与本地估算都包含系统提示、工具定义与消息，固定前缀不会被当作历史的增长比例。
    async observe(request: { system?: string; tools?: unknown; messages: unknown[] }, events: unknown[]): Promise<void> {
      const usage = usageEvent(request, events);
      if (usage === null) return;
      // 这一次报回的比记录里那一条更近，不必再从历史算。
      seeded = true;
      factor = usage.input / usage.estimated;
      if (typeof session.append !== 'function') return;
      // 本地那一份估算一起留：系数要能从记录算回来，而这一格不进检查点的哈希输入（D75 的白名单只认三种）。
      await session.append(usage);
    },
  };
}
