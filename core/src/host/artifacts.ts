// 产物读模型：把会话记录中的文件产物整理成可列出、可核对、可预览、可解析的视图。
// 归属与可见性在这里判定一次：工作区身份、记录 owner、Run 作用域；预览/解析只读文件，不改写。
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { confirmedFileArtifacts, type IndexedFileArtifact } from '../session/artifact.js';
import type { SessionEvent } from '../session/format.js';
import { runReceipts } from '../session/run.js';
import type { SessionLog } from '../session/session.js';
import { previewFileArtifact, readFileArtifact } from '../capability/artifact.js';
import { boundaryOf, type CapabilityConfig } from '../capability/limits.js';
import { requireTrustedUi, type ControlTrust } from './capabilities.js';
import { withinRunWindows } from './run-records.js';

// 只描述产物读取需要的那部分项目环境：记录目录、项目根与边界配置。
export type ArtifactEnvironment = {
  readonly projectRoot: string;
  readonly directory: string;
  readonly config: CapabilityConfig;
};

export type ArtifactScope = {
  readonly sessionId: string;
  readonly env: ArtifactEnvironment;
  readonly recordPath: string;
  readonly openedRoot: string | undefined;
  readonly log: SessionLog;
  readonly runScopes: readonly string[] | undefined;
  readonly fillSpills: (events: SessionEvent[], env: ArtifactEnvironment) => Promise<SessionEvent[]>;
};

export type ArtifactFilters = { readonly runId?: string; readonly offset?: number; readonly limit?: number };

async function loadArtifacts(scope: ArtifactScope, filters: ArtifactFilters): Promise<readonly IndexedFileArtifact[]> {
  const { sessionId, env, recordPath, openedRoot, log, runScopes, fillSpills } = scope;
  try { await access(recordPath); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('session_not_found');
    throw cause;
  }
  const workspace = workspaceIdentity(env.projectRoot);
  if (openedRoot !== undefined && workspaceIdentity(openedRoot) !== workspace) throw new KernelError('artifact_owner_mismatch');
  const header = await log.header();
  const owner = header?.workspace ?? (header?.projectRoot ? workspaceIdentity(header.projectRoot) : undefined);
  if (owner !== workspace) throw new KernelError('artifact_owner_mismatch');
  const events = await log.read();
  const visibleRuns = runScopes === undefined
    ? runReceipts(events, sessionId)
    : runScopes.flatMap(scopeOrPath => runReceipts(events, sessionId, scopeOrPath));
  let artifactEvents = events;
  if (filters.runId !== undefined) {
    const receipt = visibleRuns.find(item => item.runId === filters.runId);
    if (receipt === undefined) throw new KernelError('run_not_found');
    artifactEvents = withinRunWindows(events, [receipt]);
  } else if (runScopes !== undefined) {
    // 无 Grant 或受限连接只列出自己可见 Run 产生的证据，不枚举其他调用者的产物。
    artifactEvents = withinRunWindows(events, visibleRuns);
  }
  const evidence = artifactEvents.filter(event => event.kind === 'tool' && (event.tool === 'present' || event.tool === 'subagent'));
  return confirmedFileArtifacts(await fillSpills(evidence, env), workspace);
}

export async function listArtifacts(scope: ArtifactScope, filters: ArtifactFilters): Promise<{
  readonly sessionId: string;
  readonly items: readonly IndexedFileArtifact[];
  readonly total: number;
  readonly nextOffset: number | null;
}> {
  const artifacts = await loadArtifacts(scope, filters);
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 20;
  return { sessionId: scope.sessionId, items: artifacts.slice(offset, offset + limit), total: artifacts.length,
    nextOffset: offset + limit < artifacts.length ? offset + limit : null };
}

async function pickArtifact(scope: ArtifactScope, filters: ArtifactFilters, artifactKey: string): Promise<IndexedFileArtifact> {
  const artifacts = await loadArtifacts(scope, filters);
  const chosen = artifacts.find(entry => entry.artifactKey === artifactKey);
  if (chosen === undefined) throw new KernelError('artifact_not_in_session');
  return chosen;
}

async function verifyArtifact(scope: ArtifactScope, chosen: IndexedFileArtifact): Promise<{ readonly modified: boolean; readonly relativePath: string }> {
  const current = await readFileArtifact({ path: chosen.artifact.path }, chosen.artifact.sessionId, scope.env.projectRoot, boundaryOf(scope.env.config));
  return { modified: !(current.artifact.sha256 === chosen.artifact.sha256 && current.size === chosen.artifact.bytes), relativePath: current.artifact.path };
}

// 文件变化、缺失与越界分别映射为状态，不把错误伪装成“可用”。
function statusOfFailure(cause: unknown): 'modified' | 'missing' | 'denied' | undefined {
  if (!(cause instanceof KernelError)) return undefined;
  const reason = cause.code;
  if (reason === 'artifact_modified' || reason === 'artifact_file_changed') return 'modified';
  if (reason === 'artifact_file_unavailable' && (cause.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing';
  if (['artifact_file_invalid', 'artifact_path_invalid', 'path_escapes_boundary', 'path_escapes_workspace'].includes(reason)) return 'denied';
  return undefined;
}

export async function previewArtifact(scope: ArtifactScope, filters: ArtifactFilters, artifactKey: string) {
  const chosen = await pickArtifact(scope, filters, artifactKey);
  try {
    const preview = await previewFileArtifact(chosen.artifact, scope.env.projectRoot, boundaryOf(scope.env.config));
    return { ...chosen, status: preview.type === 'unsupported_preview' ? 'unsupported_preview' : 'available', preview };
  } catch (cause) {
    // 预览期间的已知文件错误仍按状态返回，客户端据此显示“已修改/缺失/拒绝”，而不是通用错误。
    const status = statusOfFailure(cause);
    if (status === undefined) throw cause;
    return { ...chosen, status };
  }
}

export async function inspectArtifact(scope: ArtifactScope, filters: ArtifactFilters, artifactKey: string) {
  const chosen = await pickArtifact(scope, filters, artifactKey);
  try {
    const current = await verifyArtifact(scope, chosen);
    return { ...chosen, status: current.modified ? 'modified' : 'available' };
  } catch (cause) {
    const status = statusOfFailure(cause);
    if (status === undefined) throw cause;
    return { ...chosen, status };
  }
}

export async function resolveArtifact(scope: ArtifactScope, filters: ArtifactFilters, artifactKey: string, controlTrust: ControlTrust) {
  requireTrustedUi('artifact-native', controlTrust);
  const chosen = await pickArtifact(scope, filters, artifactKey);
  try {
    const current = await verifyArtifact(scope, chosen);
    // 文件已变化时保持既有合同：返回状态对象，由客户端提示而不是进入通用错误。
    if (current.modified) return { ...chosen, status: 'modified' };
    return { artifactKey: chosen.artifactKey, path: resolve(scope.env.projectRoot, current.relativePath) };
  } catch (cause) {
    const status = statusOfFailure(cause);
    if (status === undefined) throw cause;
    return { ...chosen, status };
  }
}
