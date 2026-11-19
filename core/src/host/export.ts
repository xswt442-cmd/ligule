// 将会话记录导出为 Markdown。记录和溢出内容由 Host 读取，此模块负责排版和写文件。
// 用户界面负责选择目标路径。
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { checkedImageReferences, IMAGE_LIMITS, IMAGE_ID, isImageReference, type ImageReference } from '../media.js';
import type { SessionEvent } from '../session/format.js';
import { checkedFileChangeFact, type FileChangeFact } from '../session/file-changes.js';
import { checkedCheckEvent, type CheckEvent } from '../session/checks.js';
import { readExecutionLog, type ExecutionLogReference } from '../session/execution-log.js';

/** 导出结果中每个文件的状态，包括已写入、目标已存在和写入失败。 */
export interface Exported {
  readonly written: readonly string[];
  readonly skipped: readonly { id: string; path?: string; code: string }[];
  readonly failed: readonly { path: string; code: string }[];
}

export interface ExportRecord {
  readonly kind: string;
  readonly seq?: number;
  readonly raw?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args?: Record<string, unknown> }[];
  readonly result?: {
    readonly content?: unknown;
    readonly failed?: boolean;
    readonly code?: string;
    readonly spilled?: string;
    readonly images?: readonly ImageReference[];
  };
  readonly fileChanges?: readonly FileChangeFact[];
  readonly check?: CheckEvent;
  readonly execution?: ExportExecution;
  readonly name?: string;
  readonly layer?: string;
}

/**
 * 一条命令执行记录的可移植事实：身份、起止、退出或终止原因、日志引用及其完整度。
 * 只保留固定字段，日志正文由证据另行有界摘录，绝不整段内联。
 */
export interface ExportExecution {
  readonly executionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly state: 'accepted' | 'started' | 'exited' | 'cancelled' | 'failed';
  /** `startedAt`；尚未开始时回落到 `acceptedAt`。 */
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly timeoutMs: number;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly logsRef?: ExecutionLogReference;
  readonly logTotalBytes: number;
  readonly logFirstAvailableOffset: number;
  readonly logUnavailableReason?: string;
  readonly cancelRequested: boolean;
  readonly deadlineExceeded: boolean;
  readonly terminationPending: boolean;
  readonly cleanupPending: boolean;
  readonly recordFailure?: boolean;
}

/** 单个导出件的证据字节上限；超出部分只留引用和范围，不写正文。 */
export const EXPORT_EVIDENCE_MAX_BYTES = 4096;
/** 整份导出件的证据字节预算；用尽后仍逐项写明未包含的原因。 */
export const EXPORT_EVIDENCE_MAX_TOTAL_BYTES = 64 * 1024;

/** 有界正文摘录：`text` 已被限制在 {@link EXPORT_EVIDENCE_MAX_BYTES} 以内。 */
export interface ExportExcerpt {
  readonly text: string;
  readonly totalBytes: number;
  readonly includedBytes: number;
  /** 日志流中第一个可读字节的偏移；基线正文恒为 0。 */
  readonly firstAvailableOffset: number;
  readonly truncated: boolean;
}

/** 一项会话私有证据的读取结果：要么有界摘录，要么稳定原因码。 */
export type ExportEvidenceItem =
  | { readonly status: 'included'; readonly excerpt: ExportExcerpt }
  | { readonly status: 'unavailable'; readonly reason: string };

/** 调用者按同一访问规则读到的证据；缺项必须显示为未包含，不会静默省略。 */
export interface ExportEvidence {
  /** `executionId` → 命令日志正文。 */
  readonly logs?: ReadonlyMap<string, ExportEvidenceItem>;
  /** 基线快照文件名 → 基线正文。 */
  readonly baselines?: ReadonlyMap<string, ExportEvidenceItem>;
}

export interface ExportAsset {
  readonly reference: ImageReference;
  readonly data: Buffer;
}

export const MAX_EXPORT_ASSETS = 4096;
const fence = (value: string) => `\`\`\`\n${value.replace(/\n+$/, '')}\n\`\`\``;
const stemOf = (path: string) => path.replace(/\.(md|markdown|txt)$/i, '');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const EXECUTION_LOG_NAME = /^execution-[0-9a-f-]{36}\.log\.json$/u;
const EXECUTION_STATES = ['accepted', 'started', 'exited', 'cancelled', 'failed'] as const;
const TERMINAL_STATES: readonly string[] = ['exited', 'cancelled', 'failed'];

// 会话记录里 execution 事件宽泛地落成 SessionEvent；导出前收敛成固定字段，
// 避免把任意形状写进导出件，也避免因为多余字段泄露授权范围以外的内容。
export function checkedExecution(event: SessionEvent): ExportExecution | undefined {
  const state = String(event.state);
  if (!(EXECUTION_STATES as readonly string[]).includes(state)) return undefined;
  if (typeof event.executionId !== 'string' || !EXECUTION_ID.test(event.executionId)) return undefined;
  if (typeof event.runId !== 'string' || !EXECUTION_ID.test(event.runId)) return undefined;
  if (typeof event.callId !== 'string' || !EXECUTION_ID.test(event.callId)) return undefined;
  const startedAt = typeof event.startedAt === 'string' ? event.startedAt : event.acceptedAt;
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) return undefined;
  const terminal = TERMINAL_STATES.includes(state);
  const finishedAt = event.finishedAt;
  if (terminal && (typeof finishedAt !== 'string' || !Number.isFinite(Date.parse(finishedAt)))) return undefined;
  if (!Number.isSafeInteger(event.timeoutMs) || Number(event.timeoutMs) < 1 || Number(event.timeoutMs) > 600_000) return undefined;
  if (event.exitCode !== undefined && !Number.isSafeInteger(event.exitCode)) return undefined;
  if (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !ERROR_CODE.test(event.errorCode))) return undefined;
  if (!Number.isSafeInteger(event.logTotalBytes) || Number(event.logTotalBytes) < 0) return undefined;
  if (!Number.isSafeInteger(event.logFirstAvailableOffset) || Number(event.logFirstAvailableOffset) < 0
    || Number(event.logFirstAvailableOffset) > Number(event.logTotalBytes)) return undefined;
  let logsRef: ExecutionLogReference | undefined;
  if (event.logsRef !== undefined) {
    const ref = event.logsRef;
    if (!isRecord(ref) || typeof ref.name !== 'string' || !EXECUTION_LOG_NAME.test(ref.name)
      || !Number.isSafeInteger(ref.bytes) || Number(ref.bytes) < 1 || Number(ref.bytes) > 1024 * 1024
      || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.sha256)) return undefined;
    logsRef = { name: ref.name, bytes: Number(ref.bytes), sha256: ref.sha256 };
  }
  if (event.logUnavailableReason !== undefined
    && (typeof event.logUnavailableReason !== 'string' || !ERROR_CODE.test(event.logUnavailableReason))) return undefined;
  for (const key of ['cancelRequested', 'deadlineExceeded', 'terminationPending', 'cleanupPending'] as const) {
    if (typeof event[key] !== 'boolean') return undefined;
  }
  if (event.recordFailure !== undefined && typeof event.recordFailure !== 'boolean') return undefined;
  return {
    executionId: event.executionId, runId: event.runId, callId: event.callId,
    state: state as ExportExecution['state'], startedAt,
    ...(typeof finishedAt === 'string' ? { finishedAt } : {}),
    timeoutMs: Number(event.timeoutMs),
    ...(event.exitCode === undefined ? {} : { exitCode: Number(event.exitCode) }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode as string }),
    ...(logsRef === undefined ? {} : { logsRef }),
    logTotalBytes: Number(event.logTotalBytes),
    logFirstAvailableOffset: Number(event.logFirstAvailableOffset),
    ...(event.logUnavailableReason === undefined ? {} : { logUnavailableReason: event.logUnavailableReason as string }),
    cancelRequested: event.cancelRequested as boolean,
    deadlineExceeded: event.deadlineExceeded as boolean,
    terminationPending: event.terminationPending as boolean,
    cleanupPending: event.cleanupPending as boolean,
    ...(event.recordFailure === undefined ? {} : { recordFailure: event.recordFailure as boolean }),
  };
}

export function exportRecordOf(event: SessionEvent): ExportRecord | undefined {
  if (typeof event.kind !== 'string') return undefined;
  const record: {
    kind: string;
    seq?: number;
    raw?: string;
    text?: string;
    tool?: string;
    toolCalls?: { id: string; name: string; args?: Record<string, unknown> }[];
    result?: { content?: unknown; failed?: boolean; code?: string; spilled?: string; images?: readonly ImageReference[] };
    fileChanges?: FileChangeFact[];
    check?: CheckEvent;
    execution?: ExportExecution;
    name?: string;
    layer?: string;
  } = { kind: event.kind };
  if (typeof event.seq === 'number') record.seq = event.seq;
  if (typeof event.raw === 'string') record.raw = event.raw;
  if (typeof event.text === 'string') record.text = event.text;
  if (typeof event.tool === 'string') record.tool = event.tool;
  if (typeof event.name === 'string') record.name = event.name;
  if (typeof event.layer === 'string') record.layer = event.layer;
  if (Array.isArray(event.toolCalls)) {
    record.toolCalls = event.toolCalls.flatMap((call) => isRecord(call) && typeof call.id === 'string' && typeof call.name === 'string'
      ? [{ id: call.id, name: call.name, ...(isRecord(call.args) ? { args: call.args } : {}) }]
      : []);
  }
  if (isRecord(event.result)) {
    record.result = {
      ...(Object.hasOwn(event.result, 'content') ? { content: event.result.content } : {}),
      ...(typeof event.result.failed === 'boolean' ? { failed: event.result.failed } : {}),
      ...(typeof event.result.code === 'string' ? { code: event.result.code } : {}),
      ...(typeof event.result.spilled === 'string' ? { spilled: event.result.spilled } : {}),
      ...(event.result.images === undefined ? {} : { images: checkedImageReferences(event.result.images) }),
    };
  }
  if (Array.isArray(event.fileChanges)) {
    record.fileChanges = event.fileChanges.map(checkedFileChangeFact)
      .filter((change): change is FileChangeFact => change !== undefined);
  }
  if (event.kind === 'check') {
    const check = checkedCheckEvent(event);
    if (check !== undefined) record.check = check;
  }
  // execution 事件此前被整类丢掉，导出件因此拿不到命令日志的任何线索。
  if (event.kind === 'execution') {
    const execution = checkedExecution(event);
    if (execution !== undefined) record.execution = execution;
  }
  return record;
}

// 优先显示结构化结果中的 `text` 字段；其他结果序列化为文本，失败时附带稳定错误码。
function resultBody(record: ExportRecord): string {
  const content = record.result?.content;
  if (typeof content === 'string') return content;
  if (content !== null && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return JSON.stringify({ content, code: record.result?.code, spilled: record.result?.spilled }, null, 2);
}

// 派生结果可能将支线 ID 存在溢出文件中，需在读取完整结果后提取。
export function branchSessionId(record: ExportRecord): string | undefined {
  if (record.kind !== 'tool' || (record.tool !== 'subagent' && record.tool !== 'subagent_start')) return undefined;
  const content = record.result?.content;
  if (!isRecord(content)) return undefined;
  const id = record.tool === 'subagent_start' ? content.sessionId ?? content.subrunId : content.sessionId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function relativeUrl(path: string): string {
  return path.split(/[\\/]/u).map((part) => encodeURIComponent(part)).join('/');
}

/** 返回相对于 Markdown 文件的受控图片路径。 */
export function exportImageUrl(path: string, id: string): string {
  if (!IMAGE_ID.test(id)) throw new TypeError('export image id is invalid');
  const directory = `${basename(stemOf(path))}.assets`;
  return relativeUrl(join(directory, `${id}.png`));
}

function imageMarkdown(image: ImageReference, imageUrls?: ReadonlyMap<string, string>): string[] {
  const url = imageUrls?.get(image.id);
  return [
    url === undefined ? `- 图片文件未随导出包含：${image.id}` : `![图片 ${image.id}](${url})`,
    `- 图片引用：${image.id}`,
    `- 尺寸：${image.width} × ${image.height}`,
    `- 来源：${image.source}`,
    `- 类型与大小：${image.mimeType}，${image.bytes} 字节`,
    `- 创建时间：${image.createdAt}`,
    `- SHA-256：${image.sha256}`,
    '',
  ];
}

// 正文摘录的围栏至少比内容里最长的反引号串长一位，日志正文因此无法提前闭合代码块。
function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}text\n${text.replace(/\n+$/, '')}\n${marker}`;
}

/** 一条执行记录的命令引用、时段、结果、日志引用和完整度；正文另行有界摘录。 */
function executionLines(execution: ExportExecution, label: string, body: readonly string[]): string[] {
  const lines = [`### ${label} · 命令 ${execution.callId}`, ''];
  lines.push(`- 命令引用：call ${execution.callId}；run ${execution.runId}；execution ${execution.executionId}`);
  lines.push(`- 时段：${execution.startedAt} → ${execution.finishedAt ?? '尚未结束'}`);
  lines.push(`- 命令结果：${execution.state}${execution.exitCode === undefined ? '' : `（退出码 ${execution.exitCode}）`}`);
  if (execution.errorCode !== undefined) lines.push(`- 终止原因：${execution.errorCode}`);
  const marks = [
    execution.cancelRequested ? 'cancelRequested' : undefined,
    execution.deadlineExceeded ? 'deadlineExceeded' : undefined,
    execution.terminationPending ? 'terminationPending' : undefined,
    execution.cleanupPending ? 'cleanupPending' : undefined,
    execution.recordFailure === true ? 'recordFailure' : undefined,
  ].filter((mark): mark is string => mark !== undefined);
  if (marks.length > 0) lines.push(`- 标记：${marks.join('；')}`);
  lines.push(`- 超时上限：${execution.timeoutMs} 毫秒`);
  lines.push(execution.logsRef === undefined
    ? `- 日志引用：无（${execution.logUnavailableReason ?? 'unknown'}）`
    : `- 日志引用：${execution.logsRef.name}（${execution.logsRef.bytes} 字节，SHA-256 ${execution.logsRef.sha256}）`);
  // 完整度描述记录下来的日志本身：缺引用时 unavailable/unknown，可从非零偏移读起时是部分。
  const completeness = execution.logsRef === undefined
    ? (execution.logUnavailableReason === undefined ? 'unknown' : 'unavailable')
    : (execution.logFirstAvailableOffset > 0 ? 'partial' : 'complete');
  lines.push(`- 日志完整度：${completeness}（共 ${execution.logTotalBytes} 字节，最早可读偏移 ${execution.logFirstAvailableOffset}）`);
  lines.push(...body);
  return lines;
}

/** 将会话记录写为 Markdown；工具调用及其结果分别成段，并保留事件序号供 `/show` 定位。 */
export function exportMarkdown(
  events: readonly ExportRecord[],
  meta: { id: string; projectRoot?: string; createdAt?: string | null; unfinished?: boolean },
  imageUrls?: ReadonlyMap<string, string>,
  evidence?: ExportEvidence,
): string {
  const lines: string[] = [`# ligule 会话 ${meta.id}`, ''];
  let evidenceBudget = EXPORT_EVIDENCE_MAX_TOTAL_BYTES;
  // 同一条命令会落多条 execution 事件（accepted/started/终止）：正文只在第一次出现处展开。
  const excerptedAt = new Map<string, number | undefined>();
  // 会话私有正文（命令日志、基线）按字节计预算：单件上限在读取端裁剪，整份导出再拦一次总量。
  // 任何一项没有正文都写出稳定原因，导出件因此不会看起来“本来就没有”。
  const missing = (label: string, reason: string): string =>
    `- ${label}未随这份导出包含（${reason}）：导出只保留引用、范围和完整度，正文请按引用在会话目录中查阅。`;
  const excerptLines = (label: string, kind: 'log' | 'baseline', item: ExportEvidenceItem | undefined): string[] => {
    if (item === undefined) return [missing(label, 'export_evidence_not_provided')];
    if (item.status === 'unavailable') return [missing(label, item.reason)];
    const { excerpt } = item;
    // 有内容却一个字节都读不出来（保留策略清光了）与本来就是空文件要分开写。
    if (excerpt.includedBytes === 0 && excerpt.totalBytes > 0) return [missing(label, 'export_evidence_empty')];
    if (excerpt.includedBytes > evidenceBudget) return [missing(label, 'export_evidence_budget_exhausted')];
    evidenceBudget -= excerpt.includedBytes;
    const scope = excerpt.truncated
      ? `有界摘录：共 ${excerpt.totalBytes} 字节，仅包含${kind === 'log' ? '最后' : '开头'} ${excerpt.includedBytes} 字节`
      : `完整正文：共 ${excerpt.totalBytes} 字节`;
    return [`- ${label}（${scope}）：`, '', fenceFor(excerpt.text), ''];
  };
  if (meta.projectRoot !== undefined && meta.projectRoot !== '') lines.push(`- 项目根：${meta.projectRoot}`, '');
  if (meta.createdAt !== undefined && meta.createdAt !== null) lines.push(`- 开始：${meta.createdAt}`, '');
  // 导出末尾序号表示本次读取的快照边界，不表示会话轮次已结束。
  if (meta.unfinished === true) lines.push('> 导出这一刻这一份会话还在跑：这份文件到记录落到那一条为止，后面写进来的不在这份里。', '');
  for (const record of events) {
    if (record.kind === 'user') lines.push(`## 第 ${record.seq} 条 · 你说`, '', record.raw ?? record.text ?? '', '');
    else if (record.kind === 'reasoning') lines.push(`## 第 ${record.seq} 条 · 推理`, '', record.text ?? '', '');
    else if (record.kind === 'assistant') {
      lines.push(`## 第 ${record.seq} 条 · 模型`, '');
      if (record.text !== undefined && record.text !== '') lines.push(record.text, '');
      for (const call of record.toolCalls ?? []) {
        lines.push(`### 第 ${record.seq} 条的一次调用 · ${call.name}`, '', fence(JSON.stringify(call.args ?? {}, null, 2)), '');
      }
    } else if (record.kind === 'tool') {
      lines.push(`### 第 ${record.seq} 条 · ${record.tool} 的结果`);
      if (record.result?.failed === true) lines.push(`（这一次没做成）${record.result.code === undefined ? '' : ` ${record.result.code}`}`);
      lines.push('', resultBody(record), '');
      for (const change of record.fileChanges ?? []) {
        lines.push(`- 文件变化：${change.operation} ${change.path}（${change.outcome}）`);
        lines.push(`- 前版本：${change.beforeVersion ?? '未知'}；预期后版本：${change.expectedAfterVersion ?? '未知'}；采样后版本：${change.observedAfterVersion ?? '未知'}`);
        lines.push(`- 基线：${change.baselineStatus}${change.baselineReason === undefined ? '' : `（${change.baselineReason}）`}`
          + `；写后采样：${change.observedStatus}${change.observedReason === undefined ? '' : `（${change.observedReason}）`}`);
        lines.push(`- 相对基线变化：${change.changedFromBaseline === null ? '未知' : change.changedFromBaseline ? '有变化' : '未变化'}`);
        if (change.baselineRef !== undefined) {
          if (evidence === undefined) {
            lines.push(`- Session 私有基线引用：${change.baselineRef.bytes} 字节，SHA-256 ${change.baselineRef.sha256}；内容未嵌入这份导出。`);
          } else {
            // 有证据通道时按同一访问规则给出有界正文，读不到就写明原因，不再统一写成“未嵌入”。
            lines.push(`- Session 私有基线引用：${change.baselineRef.bytes} 字节，SHA-256 ${change.baselineRef.sha256}。`);
            lines.push(...excerptLines('基线正文', 'baseline', evidence.baselines?.get(change.baselineRef.name)));
          }
        } else if (change.baselineStatus !== 'available') {
          lines.push('- 基线正文未保存；本项仅包含可观察的版本和状态。');
        }
        lines.push('');
      }
      for (const image of record.result?.images ?? []) lines.push(...imageMarkdown(image, imageUrls));
    } else if (record.kind === 'execution') {
      // 记录损坏或形状不认识时同样留一段说明，绝不静默丢掉一条执行事实。
      if (record.execution === undefined) {
        lines.push(`### 第 ${record.seq} 条 · 命令`, '', '> 这一条执行记录无法识别，未导出任何字段（export_execution_invalid）。', '');
      } else {
        const execution = record.execution;
        // 没有日志引用就没有正文可谈：上面那行引用已经写明原因，不再重复一条“未包含”。
        let body: string[] = [];
        if (execution.logsRef !== undefined) {
          if (excerptedAt.has(execution.executionId)) {
            body = [`- 日志正文：见第 ${excerptedAt.get(execution.executionId)} 条，这里不重复展开。`];
          } else {
            excerptedAt.set(execution.executionId, record.seq);
            body = excerptLines('日志正文', 'log', evidence?.logs?.get(execution.executionId));
          }
        }
        lines.push(...executionLines(execution, `第 ${record.seq} 条`, body), '');
      }
    } else if (record.kind === 'check' && record.check !== undefined) {
      const check = record.check;
      lines.push(`### 第 ${record.seq} 条 · 检查 ${check.declaration.name}`, '');
      lines.push(`- 命令结果：${check.commandStatus}（${check.executionState}${check.exitCode === null ? '' : `，退出码 ${check.exitCode}`}）`);
      if (check.startedAt !== undefined || check.endedAt !== undefined) {
        lines.push(`- 时段：${check.startedAt ?? '开始时刻未知'} → ${check.endedAt ?? '结束时刻未知'}`);
      }
      lines.push(check.logsRef === undefined
        ? `- 日志引用：无（这条检查记录没有携带日志引用）`
        : `- 日志引用：${check.logsRef.name}（${check.logsRef.bytes} 字节，SHA-256 ${check.logsRef.sha256}）`);
      if (check.errorCode !== undefined) lines.push(`- 终止原因：${check.errorCode}`);
      lines.push(`- 结构化报告：${check.reportStatus}`
        + (check.report === undefined ? '' : `（通过 ${check.report.passed}、失败 ${check.report.failed}、跳过 ${check.report.skipped}、待办 ${check.report.todo}）`));
      lines.push(`- 文件范围：${check.scopeStatus}；日志：${check.logStatus}；覆盖范围仅为 Session 中记录的起止采样。`);
      if (check.reportReason !== undefined) lines.push(`- 报告说明：${check.reportReason}`);
      for (const sample of check.scopeEnd) {
        lines.push(`- 范围采样：${sample.path}（${sample.status}${sample.exists === false ? '，不存在' : ''}${sample.version === null ? '' : `，版本 ${sample.version}`}${sample.reason === undefined ? '' : `，${sample.reason}`}）`);
      }
      lines.push('');
    } else if (record.kind === 'mode') {
      lines.push(`> 第 ${record.seq} 条：模式 ${record.name}（${record.layer ?? ''}）生效`, '');
    }
    // `session` 首行和 `usage` 事件是元数据，不作为会话内容段落导出。
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 一项证据最多读取这么多条；超出的项照样写明原因，不会悄悄消失。 */
const EXPORT_EVIDENCE_MAX_ITEMS = 256;

/** 基线快照引用；与 `FileChangeFact.baselineRef` 同形。 */
interface SnapshotReference {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

// 文件系统错误码不进导出件，映射成稳定短码；其他已经合规的短码原样保留。
const EVIDENCE_REASONS: Record<string, string> = {
  ENOENT: 'export_evidence_missing',
  EACCES: 'export_evidence_denied',
  EPERM: 'export_evidence_denied',
};

function evidenceReason(cause: unknown, fallback: string): string {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return fallback;
  return EVIDENCE_REASONS[code] ?? (ERROR_CODE.test(code) ? code : fallback);
}

// 尾部窗口的起点可能落在半行或多字节字符中间：丢掉第一行残片，导出件里只留可读文本。
function trimTailWindow(bytes: Buffer, cut: boolean): string {
  const text = bytes.toString('utf8');
  if (!cut) return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? text.replace(/^\uFFFD+/u, '') : text.slice(newline + 1);
}

// 头部窗口在最后一个完整行处截断，避免正文停在半个字符或半行上。
function trimHeadWindow(text: string, cut: boolean): string {
  if (!cut) return text;
  const newline = text.lastIndexOf('\n');
  return newline === -1 ? text.replace(/\uFFFD+$/u, '') : text.slice(0, newline);
}

/** 读取一条命令的日志正文；只摘录尾部 {@link EXPORT_EVIDENCE_MAX_BYTES} 字节。 */
async function readExportLog(directory: string, execution: ExportExecution): Promise<ExportEvidenceItem> {
  const reference = execution.logsRef;
  if (reference === undefined) return { status: 'unavailable', reason: 'export_log_reference_missing' };
  try {
    const snapshot = await readExecutionLog(directory, execution.executionId, reference);
    const start = Math.max(snapshot.firstAvailableOffset, snapshot.totalBytes - EXPORT_EVIDENCE_MAX_BYTES);
    const window: Buffer[] = [];
    for (const chunk of snapshot.chunks) {
      const from = Math.max(start, chunk.offset);
      const to = chunk.offset + chunk.data.length;
      if (to > from) window.push(chunk.data.subarray(from - chunk.offset));
    }
    const cut = start > snapshot.firstAvailableOffset;
    const text = window.length === 0 ? '' : trimTailWindow(Buffer.concat(window), cut);
    const includedBytes = Buffer.byteLength(text);
    return {
      status: 'included',
      excerpt: {
        text,
        totalBytes: snapshot.totalBytes,
        includedBytes,
        firstAvailableOffset: snapshot.firstAvailableOffset,
        truncated: cut || includedBytes < snapshot.totalBytes,
      },
    };
  } catch (cause) {
    return { status: 'unavailable', reason: evidenceReason(cause, 'export_log_unreadable') };
  }
}

/** 读取一个基线快照；校验规则与 Session 回读基线时一致，只摘录开头一段。 */
async function readExportBaseline(directory: string, reference: SnapshotReference): Promise<ExportEvidenceItem> {
  try {
    const root = await realpath(directory);
    const resolved = await realpath(join(root, reference.name));
    const inside = relative(root, resolved);
    if (isAbsolute(inside) || inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) {
      return { status: 'unavailable', reason: 'export_baseline_outside_session' };
    }
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== reference.bytes) {
      return { status: 'unavailable', reason: 'export_baseline_mismatch' };
    }
    const bytes = await readFile(resolved);
    if (bytes.length !== reference.bytes || digest(bytes) !== reference.sha256) {
      return { status: 'unavailable', reason: 'export_baseline_digest_mismatch' };
    }
    if (!isUtf8(bytes)) return { status: 'unavailable', reason: 'export_baseline_not_utf8' };
    const cut = bytes.length > EXPORT_EVIDENCE_MAX_BYTES;
    const text = trimHeadWindow(bytes.subarray(0, EXPORT_EVIDENCE_MAX_BYTES).toString('utf8'), cut);
    return {
      status: 'included',
      excerpt: {
        text,
        totalBytes: reference.bytes,
        includedBytes: Buffer.byteLength(text),
        firstAvailableOffset: 0,
        truncated: cut,
      },
    };
  } catch (cause) {
    return { status: 'unavailable', reason: evidenceReason(cause, 'export_baseline_unreadable') };
  }
}

/**
 * 按会话目录读取导出的可用证据：命令日志和基线正文都走与 Session 相同的校验。
 * 读不到或不允许读时返回稳定原因，导出件据此写明“没有包含及为什么”，而不是静默省略。
 * 只会读取传入记录中已列出的引用，不会扫描目录中的其他内容。
 */
export async function readExportEvidence(
  directory: string,
  records: readonly ExportRecord[],
): Promise<ExportEvidence> {
  const logs = new Map<string, ExportEvidenceItem>();
  const baselines = new Map<string, ExportEvidenceItem>();
  for (const record of records) {
    const execution = record.execution;
    if (execution !== undefined && execution.logsRef !== undefined && !logs.has(execution.executionId)) {
      logs.set(execution.executionId, logs.size >= EXPORT_EVIDENCE_MAX_ITEMS
        ? { status: 'unavailable', reason: 'export_evidence_limit_exceeded' }
        : await readExportLog(directory, execution));
    }
    for (const change of record.fileChanges ?? []) {
      const reference = change.baselineRef;
      if (reference === undefined || baselines.has(reference.name)) continue;
      baselines.set(reference.name, baselines.size >= EXPORT_EVIDENCE_MAX_ITEMS
        ? { status: 'unavailable', reason: 'export_evidence_limit_exceeded' }
        : await readExportBaseline(directory, reference));
    }
  }
  return { logs, baselines };
}

function errorCode(cause: unknown, fallback = 'write_failed'): string {
  return String((cause as { code?: string } | null)?.code ?? fallback);
}

interface PreparedAsset extends ExportAsset {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function safeAssetDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function matchesExistingAsset(path: string, data: Buffer, sha256: string): Promise<boolean> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== data.length) return false;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== data.length) return false;
    const bytes = Buffer.alloc(data.length + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, Math.min(bytes.length - length, 64 * 1024), null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return length === data.length && digest(bytes.subarray(0, length)) === sha256;
  } finally {
    await file.close();
  }
}

async function writeAsset(path: string, data: Buffer, sha256: string): Promise<'written' | 'reused' | 'conflict'> {
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    return 'written';
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return await matchesExistingAsset(path, data, sha256) ? 'reused' : 'conflict';
  }
}

function disableImageLinks(markdown: string, ids: ReadonlySet<string>): string {
  let result = markdown;
  for (const id of ids) result = result.replace(new RegExp(`!\\[图片 ${id}\\]\\([^\\n)]*\\)`, 'gu'), `- 图片文件未导出：${id}`);
  return result;
}

function prepareAssets(path: string, assets: readonly ExportAsset[], failed: { path: string; code: string }[]): PreparedAsset[] {
  const stem = stemOf(path);
  const assetDirectory = `${stem}.assets`;
  const unique = new Map<string, PreparedAsset>();
  const invalidIds = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const validReference = isImageReference(asset?.reference);
    const id = validReference ? asset.reference.id : `invalid-${index}`;
    const assetPath = join(assetDirectory, `${id}.png`);
    if (!validReference || !Buffer.isBuffer(asset.data) || asset.data.length !== asset.reference.bytes
      || digest(asset.data) !== asset.reference.sha256) {
      failed.push({ path: assetPath, code: 'export_asset_invalid' });
      if (validReference) invalidIds.add(id);
      continue;
    }
    const previous = unique.get(id);
    if (previous !== undefined) {
      if (previous.sha256 !== asset.reference.sha256) {
        failed.push({ path: assetPath, code: 'export_asset_conflict' });
        unique.delete(id);
        invalidIds.add(id);
      }
      continue;
    }
    unique.set(id, { ...asset, id, path: assetPath, sha256: asset.reference.sha256 });
  }
  const prepared: PreparedAsset[] = [];
  let totalBytes = 0;
  for (const asset of unique.values()) {
    if (invalidIds.has(asset.id)) continue;
    if (prepared.length >= MAX_EXPORT_ASSETS || totalBytes + asset.data.length > IMAGE_LIMITS.storageBytes) {
      failed.push({ path: asset.path, code: 'export_asset_limit_exceeded' });
      invalidIds.add(asset.id);
      continue;
    }
    prepared.push(asset);
    totalBytes += asset.data.length;
  }
  for (const id of invalidIds) unique.delete(id);
  return prepared;
}

/** 导出主会话、派生会话和 Host 已验证的图片字节；资产目标冲突不会覆盖已有文件。 */
export async function writeExport(
  path: string,
  main: string,
  branches: readonly { id: string; text: string }[],
  assets: readonly ExportAsset[] = [],
): Promise<Exported> {
  await mkdir(dirname(path), { recursive: true });
  const written: string[] = [];
  const skipped: { id: string; path?: string; code: string }[] = [];
  const failed: { path: string; code: string }[] = [];
  const assetErrorsStart = failed.length;
  const readyAssets = assets.length === 0 ? [] : prepareAssets(path, assets, failed);
  const unavailableImageIds = new Set(failed.slice(assetErrorsStart).flatMap((entry) => {
    const id = /([0-9a-f-]{36})\.png$/u.exec(entry.path)?.[1];
    return id === undefined ? [] : [id];
  }));
  if (readyAssets.length > 0) {
    const assetDirectory = `${stemOf(path)}.assets`;
    let available = false;
    let directoryError: string | undefined;
    try { available = await safeAssetDirectory(assetDirectory); }
    catch (cause) { directoryError = errorCode(cause); }
    if (!available) {
      const code = directoryError ?? 'export_asset_directory_invalid';
      for (const asset of readyAssets) {
        failed.push({ path: asset.path, code });
        unavailableImageIds.add(asset.id);
      }
    } else if (available) {
      for (const asset of readyAssets) {
        try {
          if (!(await safeAssetDirectory(assetDirectory))) {
            failed.push({ path: asset.path, code: 'export_asset_directory_invalid' });
            unavailableImageIds.add(asset.id);
            continue;
          }
          const result = await writeAsset(asset.path, asset.data, asset.sha256);
          if (result === 'conflict') {
            failed.push({ path: asset.path, code: 'export_asset_conflict' });
            unavailableImageIds.add(asset.id);
          } else written.push(asset.path);
        } catch (cause) {
          failed.push({ path: asset.path, code: errorCode(cause) });
          unavailableImageIds.add(asset.id);
        }
      }
    }
  }
  const mainText = disableImageLinks(main, unavailableImageIds);
  try {
    await writeFile(path, mainText);
    written.push(path);
  } catch (cause) {
    failed.push({ path, code: errorCode(cause) });
  }
  const stem = stemOf(path);
  for (const branch of branches) {
    const branchPath = `${stem}.${branch.id}.md`;
    try {
      // 使用独占创建，避免检查路径和写入之间的竞态覆盖已有文件。
      await writeFile(branchPath, disableImageLinks(branch.text, unavailableImageIds), { flag: 'wx' });
      written.push(branchPath);
    } catch (cause) {
      const code = errorCode(cause);
      // 目标文件已存在时不覆盖其内容。
      if (code === 'EEXIST') skipped.push({ id: branch.id, path: branchPath, code: 'export_target_exists' });
      else failed.push({ path: branchPath, code });
    }
  }
  return { written, skipped, failed };
}
