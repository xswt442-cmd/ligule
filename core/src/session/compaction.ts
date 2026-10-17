// 压缩时将较早的模型上下文交给模型总结，并在检查点中记录摘要和被替换的事件范围。
// 压力触发在请求发送前根据本地估算判断，估算值会用服务端报告的用量校准。
// 超长触发只在服务端报告上下文超限后执行；一次运行最多压缩并重试一次。原始事件日志保持不变。
import { writeFile } from 'node:fs/promises';
import { checkpointPath, createCheckpoint, loadCheckpoint, PROJECTED_KINDS } from './checkpoint.js';
import { spillContent } from '../kernel/result.js';
import { KernelError } from '../kernel/error.js';
import type { SessionEvent } from './format.js';
import { estimateRequest, estimateTokens, usageEvent } from './usage.js';
import type { LoopCompactionRequest, ModelProvider, ModelRequest, ModelTool, ProviderEvent } from '../kernel/loop.js';
export { estimateRequest, estimateTokens } from './usage.js';

// 从记录末尾向前累计 Token；超过保留预算后，选择最近的 user 或 assistant 事件作为切点。
// 不在工具结果上切分，以免丢失与它配对的助手工具调用，破坏模型请求结构。
// 如果预算连一条消息都容不下，至少保留最后一条 user 或 assistant 消息，避免生成空上下文。
export function cutPoint(events: SessionEvent[], budgetTokens: number, measure: (event: SessionEvent) => number = estimateTokens): number | null {
  // 切点仅计算模型上下文投影；推理、模式、用量和轮次标记不进入投影，也不占保留预算。
  const list = events.filter((event) => PROJECTED_KINDS.includes(String(event.kind)));
  let total = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    total += measure(list[index]);
    if (total <= budgetTokens) continue;
    for (let cut = index + 1; cut < list.length; cut += 1) {
      const kind = list[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(list[cut].seq);
    }
    for (let cut = index; cut >= 0; cut -= 1) {
      const kind = list[cut].kind;
      if (kind === 'user' || kind === 'assistant') return Number(list[cut].seq);
    }
    return null;
  }
  return null;
}

// 摘要请求使用扁平消息记录：普通消息包含角色和文本，工具消息保留名称与结果。
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

// 摘要输入也可能超过模型窗口；超限时保留较新的内容，并说明已省略更早部分。
// 保留先前生成的摘要，避免后续压缩丢失它总结的早期上下文。
function fitExcerpt(text: string, budgetTokens: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const limit = budgetTokens * 4;
  if (bytes.length <= limit) return text;
  // 字节截断可能切开多字节字符；使用解码后的文本继续处理，避免返回无效编码。
  return `[earlier turns dropped from this excerpt]\n${bytes.subarray(bytes.length - limit).toString('utf8')}`;
}

export function createCompaction({ provider, session, directory, id, limits, logger, requestPrefix = () => ({ system: '', tools: [] }) }: {
  provider: ModelProvider;
  session: {
    read: () => Promise<SessionEvent[]>;
    modelView: () => Promise<unknown[]>;
    // 只有可写会话才记录 Token 用量；列表和检查等只读路径不写入事件。
    append?: (event: Record<string, unknown>) => Promise<unknown>;
  };
  directory: string;
  id: string;
  limits: { contextTokens: number; compactThresholdRatio: number; compactRetainRatio: number; resultBytes: number };
  logger?: { log?: (message: string, fields?: Record<string, unknown>) => void };
  requestPrefix?: () => { system: string; tools: readonly ModelTool[] };
}) {
  if (!(limits.compactRetainRatio < limits.compactThresholdRatio)) {
    throw new Error('compaction_retain_must_be_below_threshold');
  }
  // 压力阈值和保留预算以同一个上下文窗口计算。
  const threshold = Math.floor(limits.contextTokens * limits.compactThresholdRatio);
  const retained = Math.floor(limits.contextTokens * limits.compactRetainRatio);
  // 本地估算与服务端用量的校准系数；尚无服务端用量时使用 1。
  let factor = 1;
  let overflowTried = false;

  // 从最近的 `usage` 事件恢复校准系数，让会话重开后继续使用先前的校准结果。
  // 事件同时保存本地估算和服务端用量，因此无需依赖上一个进程的内存状态。
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
    // 摘要请求本身也计入窗口预算，并使用校准后的估算，避免请求自身超出模型限制。
    const excerpt = `${previous === undefined ? '' : `Earlier summary:\n${previous}\n\n`}${fitExcerpt(flatten(events), Math.max(1, Math.floor((threshold - 1024) / factor)))}`;
    const parts: string[] = [];
    let finish: ProviderEvent | undefined;
    const request: ModelRequest = {
      system: '',
      tools: [],
      messages: [{ role: 'user', text: `${INSTRUCTION}${excerpt}` }],
    };
    for await (const event of provider.stream(
      request,
      { signal },
    )) {
      if (event.type === 'text') parts.push(event.text);
      if (event.type === 'finish') finish = event;
      if (event.type === 'tool-call') throw new KernelError('provider_tool_call_invalid', { detail: 'a compaction summary cannot call tools' });
    }
    if (signal?.aborted) throw new KernelError('provider_cancelled');
    if (provider.requiresCompletion === true && finish === undefined) throw new KernelError('provider_stream_incomplete');
    if (finish?.type === 'finish' && (finish.reason === 'length' || finish.reason === 'max_tokens')) {
      throw new KernelError('provider_output_exhausted');
    }
    const text = parts.join('').trim();
    if (text === '') throw new KernelError('provider_empty_response');
    return text;
  }

  // 计算切点、请求摘要并写入检查点。无法压缩时返回具体原因和 null 结果。
  async function compact(signal?: AbortSignal): Promise<{ fromSeq: number; toSeq: number; tokensBefore: number; tokensAfter: number } | null> {
    await seedFromRecord();
    const events = await session.read();
    const { checkpoint } = await loadCheckpoint({ directory, id, events });
    const fromSeq = checkpoint?.fromSeq ?? 0;
    const tail = events.filter((event) => event.seq >= fromSeq);
    // 被排除在模型投影之外的事件不占用保留预算，也不计入压缩后的 Token 数。
    const projected = tail.filter((event) => PROJECTED_KINDS.includes(String(event.kind)));
    // 使用校准后的估算计算切点，确保压缩后按同一口径检查压力阈值。
    const cut = cutPoint(tail, retained, (event) => estimateTokens(event) * factor);
    if (cut === null) return null;
    // 检查点保存连续的事件序号范围；范围不依赖事件是否进入模型投影。
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
    // 摘要受工具结果字节上限约束；超限时保存到溢出文件，并在检查点中记录读取引用。
    const kept = await spillContent(text, {
      limit: limits.resultBytes,
      directory,
      name: `summary-${fromSeq}-${cut}.txt`,
    });
    // 压缩结果必须小于原投影，否则检查点只增加文件和验证成本，却让原有历史无法再进入模型上下文。
    // 手动压缩时返回明确的“无法缩短”结果。
    const remaining = projected.filter((event) => event.seq >= cut);
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
    // 保存本地估算和校准系数，使读取记录的一方可以还原触发压缩时的计算依据。
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

  // 识别服务端明确报告的上下文超限错误，通常是 HTTP 400 响应。
  function isOverflow(error: unknown): boolean {
    const value = error as { code?: string; detail?: string };
    if (value?.code !== 'provider_http_error' || typeof value.detail !== 'string') return false;
    return /context|token|too long|too many|maximum|length/i.test(value.detail);
  }

  return {
    tokens: () => ({ threshold, retained, factor }),

    // 为状态和命令行提供上下文窗口、压力阈值、当前估算和最近一次服务端用量。
    async context(): Promise<{
      window: number;
      threshold: number;
      retained: number;
      estimated: number;
      factor: number;
      // 返回本地估算使用的算法标识，供界面显示。
      measurement: string;
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
        measurement: 'request-v1',
        reported: usage === null || !Number.isFinite(input)
          ? null
          : { seq: Number(usage.seq), input, output },
      };
    },

    // 手动压缩只能在没有活动轮次时执行；无法缩短时返回明确结果。
    compactNow: (signal?: AbortSignal) => compact(signal),

    // 在构造请求后检查上下文压力；超出阈值时先压缩，再使用新投影发送请求。
    async prepare(request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[]> {
      await seedFromRecord();
      if (estimateRequest(request) * factor <= threshold) return request.messages;
      const done = await compact(signal);
      if (done === null) return request.messages;
      return await session.modelView();
    },

    // 超长错误每次运行最多处理一次。其他错误、已重试过或无法压缩时返回 null，让原错误继续传递。
    async recover(error: unknown, request: LoopCompactionRequest, signal?: AbortSignal): Promise<unknown[] | null> {
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

    // 服务端报告用量后校准本地估算并写入会话记录，避免持续低估导致压力触发失效。
    // 服务端和本地估算都包含系统提示、工具定义与消息，因此固定前缀不会被误判为历史增长。
    async observe(request: LoopCompactionRequest, events: ProviderEvent[]): Promise<void> {
      const usage = usageEvent(request, events);
      if (usage === null) return;
      // 使用当前响应中的最新用量，无需再从历史记录查找。
      seeded = true;
      factor = usage.input / usage.estimated;
      if (typeof session.append !== 'function') return;
      // 同时保存本地估算，以便从记录恢复校准系数；用量事件不参与检查点哈希。
      await session.append(usage);
    },
  };
}
