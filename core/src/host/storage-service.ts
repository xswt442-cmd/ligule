// 工作区存储盘点与媒体清理：散列目录字节、分页扫描会话引用、预览计划与确认执行。
// 扫描游标与清理计划都绑定工作区身份并带有效期；预览与执行之间的记录变化会让计划失效。
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { workspaceDataDirectory } from '../session/list.js';
import type { SessionDirectoryConfig } from '../session/list.js';
import type { SessionMediaScan } from '../capability/media.js';
import { createMediaStore } from '../session/media-store.js';
import { applyStorageGarbage, previewStorageGarbage, type StorageGcCandidate } from '../capability/storage-gc.js';

export type StorageEnvironment = {
  readonly projectRoot: string;
  readonly directory: string;
  readonly config: SessionDirectoryConfig;
};

export type StorageScanState = { workspace: string; createdAt: number; scan: SessionMediaScan; busy: boolean };
export type StoragePlanState = {
  workspace: string;
  createdAt: number;
  ids: string[];
  fingerprints: Readonly<Record<string, string>>;
  sessionScan: SessionMediaScan;
  garbage: StorageGcCandidate[];
};

export type StorageState = {
  readonly scans: Map<string, StorageScanState>;
  readonly plans: Map<string, StoragePlanState>;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a string` });
  return value;
}

async function assertWorkspaceAvailable(env: StorageEnvironment): Promise<void> {
  try {
    const info = await stat(await realpath(env.projectRoot));
    if (!info.isDirectory()) throw new KernelError('storage_workspace_unavailable');
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('storage_workspace_unavailable', { cause });
  }
}

function mediaOf(env: StorageEnvironment) {
  return createMediaStore({ ...env.config, workspaceRoot: env.projectRoot }, 'workspace-storage');
}

function rootOf(env: StorageEnvironment): string {
  return workspaceDataDirectory({ ...env.config, workspaceRoot: env.projectRoot });
}

export async function inspectStorage(env: StorageEnvironment) {
  await assertWorkspaceAvailable(env);
  const workspace = workspaceIdentity(env.projectRoot);
  const root = rootOf(env);
  const folders: { kind: string; bytes: number; entries: number; complete: boolean }[] = [];
  for (const kind of ['sessions', 'screenshots', 'browser', 'cache', 'tmp']) {
    // Session records may use an explicit host.sessionDirectory override.
    const path = kind === 'sessions' ? env.directory : join(root, kind);
    let entries = 0;
    let bytes = 0;
    let complete = true;
    let rootInfo;
    try { rootInfo = await lstat(path); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      folders.push({ kind, bytes, entries, complete });
      continue;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new KernelError('storage_path_invalid');
    const pending = [{ path, depth: 0 }];
    while (pending.length > 0 && complete) {
      const current = pending.pop()!;
      let listing;
      try { listing = await opendir(current.path); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        complete = false;
        break;
      }
      for await (const entry of listing) {
        if (entries >= 1000) { complete = false; break; }
        entries += 1;
        let info;
        try { info = await lstat(join(current.path, entry.name)); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          complete = false;
          break;
        }
        if (info.isSymbolicLink()) throw new KernelError('storage_path_invalid');
        if (info.isFile()) bytes += info.size;
        else if (info.isDirectory()) {
          if (current.depth >= 16) { complete = false; break; }
          pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        }
      }
    }
    folders.push({ kind, bytes, entries, complete });
  }
  return { projectRoot: env.projectRoot, workspace, folders };
}

export async function previewStorageCleanup(env: StorageEnvironment, params: { limit?: number; cursor?: string }, state: StorageState) {
  await assertWorkspaceAvailable(env);
  const workspace = workspaceIdentity(env.projectRoot);
  const root = rootOf(env);
  const media = mediaOf(env);
  const limit = params.limit ?? 100;
  const now = Date.now();
  for (const [id, saved] of state.scans) {
    if (now - saved.createdAt > 300_000 || state.scans.size > 8) state.scans.delete(id);
  }
  const providedCursor = params.cursor;
  const cursor = providedCursor === undefined ? randomUUID() : requiredString(providedCursor, 'cursor');
  let scan: SessionMediaScan;
  let saved = state.scans.get(cursor);
  if (providedCursor !== undefined) {
    if (saved === undefined || saved.workspace !== workspace || now - saved.createdAt > 300_000) {
      throw new KernelError('image_cleanup_cursor_invalid');
    }
    scan = saved.scan;
  } else {
    scan = await media.beginSessionScan();
    saved = { workspace, createdAt: now, scan, busy: false };
    state.scans.set(cursor, saved);
  }
  if (saved.busy) throw new KernelError('image_cleanup_cursor_busy');
  saved.busy = true;
  let progress: Awaited<ReturnType<typeof media.advanceSessionScan>>;
  try { progress = await media.advanceSessionScan(scan); }
  catch (cause) {
    state.scans.delete(cursor);
    throw cause;
  } finally { saved.busy = false; }
  if (!progress.complete) return { complete: false, nextCursor: cursor,
    scannedSessions: scan.position, totalSessions: progress.totalSessions, scannedThisPage: progress.scannedSessions,
    readBytesThisPage: progress.readBytes, ids: [], candidates: 0, removed: 0, bytesFreed: 0 };
  state.scans.delete(cursor);
  await media.verifySessionScan(scan);
  let candidates: Awaited<ReturnType<typeof media.cleanup>>;
  try { candidates = await media.cleanup({ dryRun: true, limit, withFingerprints: true, sessionScan: scan }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    candidates = { scanned: 0, referenced: 0, candidates: 0, removed: 0, bytesFreed: 0, ids: [], truncated: false };
  }
  for (const [id, plan] of state.plans) {
    if (Date.now() - plan.createdAt > 300_000 || state.plans.size >= 64) state.plans.delete(id);
  }
  const reclaim = await previewStorageGarbage(root, workspace, scan.sessions);
  const garbage = reclaim.candidates.slice(0, Math.max(0, limit - candidates.ids.length));
  const planId = randomUUID();
  const { fingerprints, ...visible } = candidates;
  state.plans.set(planId, { workspace, createdAt: Date.now(), ids: candidates.ids,
    fingerprints: fingerprints ?? {}, sessionScan: scan, garbage });
  return { planId, expiresInMs: 300_000, ...visible, complete: true,
    scannedSessions: scan.position, totalSessions: progress.totalSessions, nextCursor: null,
    garbage: garbage.map(({ id, kind, bytes }) => ({ id, kind, bytes })),
    garbageScanned: reclaim.scannedEntries };
}

export async function applyStorageCleanup(env: StorageEnvironment, params: { confirm?: boolean; planId?: string }, state: StorageState) {
  await assertWorkspaceAvailable(env);
  const workspace = workspaceIdentity(env.projectRoot);
  const root = rootOf(env);
  const media = mediaOf(env);
  if (params.confirm !== true) throw new KernelError('storage_cleanup_confirmation_required');
  const planId = requiredString(params.planId, 'planId');
  const plan = state.plans.get(planId);
  if (plan === undefined || plan.workspace !== workspace || Date.now() - plan.createdAt > 300_000) {
    throw new KernelError('storage_cleanup_plan_invalid');
  }
  state.plans.delete(planId);
  // Small histories can be re-read completely at apply time, preserving per-item skipped
  // reasons when a new Session reference appears after preview. Multi-page proofs instead
  // fail closed on any record change and require a new cursor scan.
  let checkedScan = plan.sessionScan;
  if (checkedScan.entries.length <= 100) {
    checkedScan = await media.beginSessionScan();
    const fresh = await media.advanceSessionScan(checkedScan);
    if (!fresh.complete) throw new KernelError('image_cleanup_scan_incomplete');
  }
  await media.verifySessionScan(checkedScan);
  const cleaned = plan.ids.length === 0
    ? { removed: 0, bytesFreed: 0, ids: [] as string[], skipped: [] as { id: string; reason: string }[] }
    : await media.cleanup({ dryRun: false, limit: plan.ids.length,
      allowedIds: plan.ids, expectedFingerprints: plan.fingerprints, sessionScan: checkedScan });
  const garbage = await applyStorageGarbage(root, workspace, checkedScan.sessions, plan.garbage,
    () => media.verifySessionScan(checkedScan));
  return { planId, ...cleaned,
    removed: cleaned.removed + garbage.removed, bytesFreed: cleaned.bytesFreed + garbage.bytesFreed,
    ids: [...cleaned.ids, ...garbage.ids], skipped: [...(cleaned.skipped ?? []), ...garbage.skipped],
    garbageRemoved: garbage.removed };
}
