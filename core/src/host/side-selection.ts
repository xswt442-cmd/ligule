// Side chat 的选择校验：把 event / file / diff 三种来源的“引用有效且确实包含所选文字”核对一次。
// 只读校验：不创建会话、不写记录；任何无法核对的引用都明确报错，不猜测来源。
import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { boundaryOf, type CapabilityConfig } from '../capability/limits.js';
import { readProjectFileText } from './project-files.js';
import { readProjectGitDiff } from './project-git.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a string` });
  return value;
}

export type SideSelectionKind = 'event' | 'file' | 'diff';

export type SideSelectionParams = {
  readonly sourceEventSeq?: unknown;
  readonly sourcePath?: unknown;
  readonly sourceVersion?: unknown;
};

export type SideSelection = {
  readonly sourceEventSeq?: number;
  readonly sourcePath?: string;
  readonly sourceVersion?: string;
  /** event 来源命中的记录；供调用方据此推断来源 Run。 */
  readonly sourceEvent?: Record<string, unknown>;
};

export type SideSelectionDeps = {
  readonly sourceId: string;
  readonly projectRoot: string;
  readonly config: CapabilityConfig;
  readonly readEvent: (seq: number) => Promise<{ events?: Record<string, unknown>[] }>;
  /** 项目文件读取前的实时权限核验（由调用方持有会话与策略状态）。 */
  readonly requireProjectFileAccess: () => Promise<void>;
};

export async function verifySideSelection(
  kind: SideSelectionKind,
  selection: string,
  params: SideSelectionParams,
  deps: SideSelectionDeps,
): Promise<SideSelection> {
  if (kind === 'event') {
    if (!Number.isSafeInteger(params.sourceEventSeq) || Number(params.sourceEventSeq) < 0
      || params.sourcePath !== undefined || params.sourceVersion !== undefined) {
      throw new KernelError('side_context_reference_invalid');
    }
    const sourceEventSeq = Number(params.sourceEventSeq);
    const selectedRecord = await deps.readEvent(sourceEventSeq);
    const sourceEvent = selectedRecord.events?.[0];
    if (sourceEvent === undefined) throw new KernelError('side_context_event_not_found');
    const visibleText: string[] = [];
    for (const key of ['text', 'raw', 'reason']) if (typeof sourceEvent[key] === 'string') visibleText.push(sourceEvent[key] as string);
    if (isRecord(sourceEvent.args)) visibleText.push(JSON.stringify(sourceEvent.args));
    if (isRecord(sourceEvent.result)) {
      const result = sourceEvent.result;
      if (typeof result.reason === 'string') visibleText.push(result.reason);
      if (typeof result.content === 'string') visibleText.push(result.content);
      if (isRecord(result.content)) {
        for (const key of ['text', 'summary']) if (typeof result.content[key] === 'string') visibleText.push(result.content[key] as string);
      }
    }
    if (sourceEvent.kind === 'check' && isRecord(sourceEvent.declaration)) {
      const declaration = sourceEvent.declaration;
      visibleText.push(`检查结果：${String(declaration.name ?? 'unknown')} · 命令 ${String(sourceEvent.commandStatus ?? 'unknown')}`
        + ` · 报告 ${String(sourceEvent.reportStatus ?? 'unknown')} · 范围 ${String(sourceEvent.scopeStatus ?? 'unknown')}`);
    }
    if (!visibleText.some(text => text.includes(selection))) throw new KernelError('side_context_unverified');
    return { sourceEventSeq, sourceEvent };
  }

  const sourcePath = requiredString(params.sourcePath, 'sourcePath');
  if (params.sourceEventSeq !== undefined) throw new KernelError('side_context_reference_invalid');
  await deps.requireProjectFileAccess();
  if (kind === 'file') {
    const sourceVersion = requiredString(params.sourceVersion, 'sourceVersion');
    if (!/^[a-f0-9]{16}$/iu.test(sourceVersion)) throw new KernelError('side_context_reference_invalid');
    const snapshot = await readProjectFileText(deps.config, deps.sourceId, sourcePath, sourceVersion);
    if (snapshot.kind === 'stale') throw new KernelError('side_context_version_stale');
    if (snapshot.kind !== 'text' || !snapshot.text.includes(selection)) {
      throw new KernelError('side_context_unverified');
    }
    return { sourcePath, sourceVersion };
  }
  if (params.sourceVersion !== undefined) throw new KernelError('side_context_reference_invalid');
  const diff = await readProjectGitDiff(deps.projectRoot, boundaryOf(deps.config), sourcePath);
  const diffText = diff.state === 'ready' ? [diff.staged, diff.unstaged].filter((value): value is string => value !== null).join('\n') : '';
  if (diffText === '' || !diffText.includes(selection)) throw new KernelError('side_context_unverified');
  const sourceVersion = createHash('sha256').update(JSON.stringify([diff.path, diff.staged, diff.unstaged])).digest('hex');
  return { sourcePath, sourceVersion };
}
