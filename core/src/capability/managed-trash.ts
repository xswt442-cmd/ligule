import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat, mkdir, open, readdir, readFile, realpath, rmdir, stat, unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { workspaceDataDirectory } from '../session/list.js';
import { isWindowsReparsePoint, renameNoReplace } from './rename-no-replace.js';

const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 128;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ObjectType = 'file' | 'directory';
type FileStat = Stats;

interface Fingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface Manifest {
  readonly version: 1;
  readonly id: string;
  readonly workspace: string;
  readonly relativePath: string;
  readonly objectType: ObjectType;
  readonly deletedAt: string;
  readonly fingerprint: Fingerprint;
}

export interface ManagedTrashEntry {
  readonly id: string;
  readonly workspace: string;
  readonly relativePath: string;
  readonly objectType: ObjectType;
  readonly deletedAt: string;
  readonly status: 'recoverable' | 'interrupted' | 'restored';
  readonly issue?: string;
}

export interface ManagedTrashAnomaly {
  readonly id: string;
  readonly workspace: string;
  readonly status: 'damaged';
  readonly issue: string;
}

export interface ManagedTrashPage {
  readonly entries: readonly (ManagedTrashEntry | ManagedTrashAnomaly)[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface ManagedTrash {
  trash(workspaceRoot: string, boundary: string, targetPath: string): Promise<ManagedTrashEntry>;
  list(workspaceRoot: string, boundary: string, options?: { offset?: number; limit?: number }): Promise<ManagedTrashPage>;
  restore(workspaceRoot: string, boundary: string, id: string): Promise<ManagedTrashEntry>;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function fail(code: string, detail?: string, cause?: unknown): never {
  throw new KernelError(code, { ...(detail === undefined ? {} : { detail }), ...(cause === undefined ? {} : { cause }) });
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function isReparsePoint(path: string, info: FileStat): Promise<boolean> {
  if (info.isSymbolicLink()) return true;
  try { return await isWindowsReparsePoint(path); }
  catch (error) { fail('managed_trash_reparse_check_failed', path, error); }
}

function fingerprint(info: FileStat): Fingerprint {
  return { dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtimeMs: info.mtimeMs };
}

function matchesFingerprint(info: FileStat, expected: Fingerprint): boolean {
  const actual = fingerprint(info);
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode
    && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function assertPrivatePermissions(path: string, info: FileStat): void {
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    fail('managed_trash_permissions_invalid', `${path} is accessible by group or other users`);
  }
}

async function ensureDirectory(path: string, privateDirectory = false): Promise<string> {
  try {
    await mkdir(path, { recursive: true, ...(privateDirectory ? { mode: 0o700 } : {}) });
    const info = await lstat(path);
    if (!info.isDirectory() || await isReparsePoint(path, info)) fail('managed_trash_path_invalid', path);
    if (privateDirectory) assertPrivatePermissions(path, info);
    return await realpath(path);
  } catch (error) {
    if (error instanceof KernelError) throw error;
    fail('managed_trash_storage_unavailable', path, error);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    fail('managed_trash_storage_sync_failed', path, error);
  } finally {
    await handle?.close();
  }
}

async function optionalDirectory(path: string, privateDirectory = false): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || await isReparsePoint(path, info)) fail('managed_trash_path_invalid', path);
    if (privateDirectory) assertPrivatePermissions(path, info);
    return await realpath(path);
  } catch (error) {
    if (error instanceof KernelError) throw error;
    if (codeOf(error) === 'ENOENT') return undefined;
    fail('managed_trash_storage_unavailable', path, error);
  }
}

async function workspaceOf(workspaceRoot: string, boundaryRoot: string): Promise<{ root: string; boundary: string; identity: string }> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '' || !isAbsolute(workspaceRoot)) {
    fail('managed_trash_workspace_invalid', 'workspaceRoot must be an absolute directory');
  }
  if (typeof boundaryRoot !== 'string' || boundaryRoot.trim() === '' || !isAbsolute(boundaryRoot)) {
    fail('managed_trash_boundary_invalid', 'boundary must be an absolute directory');
  }
  let root: string;
  try { root = await realpath(workspaceRoot); }
  catch (error) { fail('managed_trash_workspace_unavailable', workspaceRoot, error); }
  const info = await lstat(root);
  if (!info.isDirectory() || await isReparsePoint(root, info)) fail('managed_trash_workspace_invalid', root);
  let boundary: string;
  try { boundary = await realpath(boundaryRoot); }
  catch (error) { fail('managed_trash_boundary_unavailable', boundaryRoot, error); }
  const boundaryInfo = await lstat(boundary);
  if (!boundaryInfo.isDirectory() || await isReparsePoint(boundary, boundaryInfo)) fail('managed_trash_boundary_invalid', boundary);
  return { root, boundary, identity: workspaceIdentity(root) };
}

async function sourceOf(workspace: string, boundary: string, targetPath: string): Promise<{ path: string; relativePath: string; info: FileStat }> {
  if (typeof targetPath !== 'string' || targetPath.trim() === '' || !isAbsolute(targetPath)) {
    fail('managed_trash_target_invalid', 'targetPath must be an absolute path');
  }
  const asked = resolve(targetPath);
  let info: FileStat;
  try { info = await lstat(asked); }
  catch (error) {
    if (codeOf(error) === 'ENOENT') fail('managed_trash_target_missing', asked, error);
    fail('managed_trash_target_unavailable', asked, error);
  }
  if (await isReparsePoint(asked, info)) fail('managed_trash_link_unsupported', asked);
  if (!info.isFile() && !info.isDirectory()) fail('managed_trash_object_unsupported', asked);
  if (info.isFile() && info.nlink !== 1) fail('managed_trash_hard_link_unsupported', asked);
  let canonical: string;
  try { canonical = await realpath(asked); }
  catch (error) { fail('managed_trash_target_unavailable', asked, error); }
  if (!samePath(asked, canonical)) fail('managed_trash_link_unsupported', asked);
  if (!isWithin(workspace, canonical)) fail('managed_trash_target_outside_workspace', asked);
  if (!isWithin(boundary, canonical)) fail('managed_trash_target_outside_boundary', asked);
  return { path: canonical, relativePath: relative(workspace, canonical), info };
}

async function inspectTree(root: string, rootDevice: number): Promise<readonly string[]> {
  const seen: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const info = await lstat(current.path);
    if (await isReparsePoint(current.path, info)) fail('managed_trash_link_unsupported', current.path);
    if (info.dev !== rootDevice) fail('managed_trash_cross_device', current.path);
    if (!info.isDirectory() && !info.isFile()) fail('managed_trash_object_unsupported', current.path);
    if (info.isFile() && info.nlink !== 1) fail('managed_trash_hard_link_unsupported', current.path);
    seen.push(`${relative(root, current.path)}\0${info.dev}\0${info.ino}\0${info.mode}\0${info.size}\0${info.mtimeMs}`);
    if (seen.length > MAX_TREE_ENTRIES) fail('managed_trash_tree_too_large', root);
    if (!info.isDirectory()) continue;
    if (current.depth >= MAX_TREE_DEPTH) fail('managed_trash_tree_too_deep', current.path);
    let names: string[];
    try { names = await readdir(current.path); }
    catch (error) { fail('managed_trash_tree_unreadable', current.path, error); }
    for (const name of names) pending.push({ path: join(current.path, name), depth: current.depth + 1 });
  }
  seen.sort();
  return seen;
}

function validateManifest(value: unknown, workspace: string, id: string): Manifest {
  if (typeof value !== 'object' || value === null) fail('managed_trash_entry_invalid', id);
  const candidate = value as Partial<Manifest>;
  const fp = candidate.fingerprint as Partial<Fingerprint> | undefined;
  if (candidate.version !== 1 || candidate.id !== id || candidate.workspace !== workspace
    || typeof candidate.relativePath !== 'string' || candidate.relativePath === '' || isAbsolute(candidate.relativePath)
    || candidate.relativePath.split(/[\\/]/u).some(part => part === '..' || part === '')
    || (candidate.objectType !== 'file' && candidate.objectType !== 'directory')
    || typeof candidate.deletedAt !== 'string' || !Number.isFinite(Date.parse(candidate.deletedAt))
    || fp === undefined || ![fp.dev, fp.ino, fp.mode, fp.size, fp.mtimeMs].every(Number.isFinite)) {
    fail('managed_trash_entry_invalid', id);
  }
  return candidate as Manifest;
}

async function readManifest(entryDirectory: string, workspace: string, id: string): Promise<Manifest> {
  const manifestPath = join(entryDirectory, 'manifest.json');
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || await isReparsePoint(manifestPath, info)) fail('managed_trash_entry_invalid', id);
    return validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown, workspace, id);
  } catch (error) {
    if (error instanceof KernelError) throw error;
    fail('managed_trash_entry_invalid', id, error);
  }
}

async function writeManifest(entryDirectory: string, manifest: Manifest): Promise<void> {
  const manifestPath = join(entryDirectory, 'manifest.json');
  const temporaryPath = join(entryDirectory, `.manifest-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    fail('managed_trash_manifest_write_failed', manifest.id, error);
  } finally {
    await handle?.close();
  }
  const temporaryInfo = await lstat(temporaryPath);
  try {
    await renameNoReplace(temporaryPath, manifestPath, {
      sourceRoot: entryDirectory,
      destinationRoot: entryDirectory,
      expectedSource: fingerprint(temporaryInfo),
    });
  }
  catch (error) {
    if (error instanceof KernelError) throw error;
    fail('managed_trash_manifest_commit_failed', manifest.id, error);
  }
  await syncDirectory(entryDirectory);
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || await isReparsePoint(manifestPath, info)) fail('managed_trash_entry_invalid', manifest.id);
    assertPrivatePermissions(manifestPath, info);
  } catch (error) {
    if (error instanceof KernelError) throw error;
    fail('managed_trash_manifest_commit_failed', manifest.id, error);
  }
}

function publicEntry(manifest: Manifest, status: ManagedTrashEntry['status'], issue?: string): ManagedTrashEntry {
  return {
    id: manifest.id,
    workspace: manifest.workspace,
    relativePath: manifest.relativePath,
    objectType: manifest.objectType,
    deletedAt: manifest.deletedAt,
    status,
    ...(issue === undefined ? {} : { issue }),
  };
}

function publicAnomaly(id: string, workspace: string, issue: string): ManagedTrashAnomaly {
  return { id, workspace, status: 'damaged', issue };
}

function entryIssue(error: unknown): string {
  return codeOf(error) ?? 'managed_trash_entry_invalid';
}

async function targetFor(workspace: string, boundary: string, manifest: Manifest): Promise<string> {
  const target = resolve(workspace, manifest.relativePath);
  if (!isWithin(workspace, target)) fail('managed_trash_entry_invalid', manifest.id);
  if (!isWithin(boundary, target)) fail('managed_trash_target_outside_boundary', manifest.relativePath);
  const parent = await realpath(resolve(target, '..')).catch(error => {
    if (codeOf(error) === 'ENOENT') fail('managed_trash_restore_parent_missing', manifest.relativePath, error);
    fail('managed_trash_restore_target_unavailable', manifest.relativePath, error);
  });
  if (!samePath(parent, resolve(target, '..'))) fail('managed_trash_link_unsupported', parent);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || await isReparsePoint(parent, parentInfo)) fail('managed_trash_restore_parent_invalid', parent);
  return target;
}

async function targetExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    fail('managed_trash_restore_target_unavailable', path, error);
  }
}

async function removeRestoredEntry(entryDirectory: string): Promise<void> {
  try {
    const names = await readdir(entryDirectory);
    if (names.length !== 1 || names[0] !== 'manifest.json') {
      fail('managed_trash_restore_metadata_cleanup_failed', entryDirectory);
    }
    await unlink(join(entryDirectory, 'manifest.json'));
    await rmdir(entryDirectory);
    await syncDirectory(dirname(entryDirectory));
  } catch (error) {
    fail('managed_trash_restore_metadata_cleanup_failed', entryDirectory, error);
  }
}

export function createManagedTrash(options: { userHome?: string } = {}): ManagedTrash {
  async function bucketFor(workspaceRoot: string, create: boolean): Promise<string | undefined> {
    const dataDirectory = workspaceDataDirectory({
      boundary: workspaceRoot,
      workspaceRoot,
      ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    });
    let canonicalData: string;
    if (create) canonicalData = await ensureDirectory(dataDirectory);
    else canonicalData = await optionalDirectory(dataDirectory) ?? '';
    if (canonicalData === '') return undefined;
    const trashRoot = join(canonicalData, 'managed-trash');
    if (!create) return optionalDirectory(trashRoot, true);
    const bucket = await ensureDirectory(trashRoot, true);
    await syncDirectory(canonicalData);
    return bucket;
  }

  return {
    async trash(workspaceRoot, boundaryRoot, targetPath) {
      const workspace = await workspaceOf(workspaceRoot, boundaryRoot);
      const source = await sourceOf(workspace.root, workspace.boundary, targetPath);
      const before = fingerprint(source.info);
      const treeBefore = await inspectTree(source.path, source.info.dev);
      const bucket = await bucketFor(workspace.root, true);
      if (bucket === undefined) fail('managed_trash_storage_unavailable');
      const bucketInfo = await stat(bucket);
      if (bucketInfo.dev !== source.info.dev) fail('managed_trash_cross_device', `${source.path} and ${bucket} are on different filesystems`);
      const treeImmediatelyBefore = await inspectTree(source.path, source.info.dev);
      if (treeBefore.length !== treeImmediatelyBefore.length
        || treeBefore.some((entry, index) => entry !== treeImmediatelyBefore[index])) {
        fail('managed_trash_source_changed', source.path);
      }
      const currentSource = await lstat(source.path);
      if (!matchesFingerprint(currentSource, before)) fail('managed_trash_source_changed', source.path);

      const id = randomUUID();
      const entryDirectory = join(bucket, id);
      try { await mkdir(entryDirectory, { mode: 0o700 }); }
      catch (error) { fail('managed_trash_entry_create_failed', id, error); }
      const entryDirectoryInfo = await lstat(entryDirectory);
      assertPrivatePermissions(entryDirectory, entryDirectoryInfo);
      await syncDirectory(bucket);
      const manifest: Manifest = {
        version: 1,
        id,
        workspace: workspace.identity,
        relativePath: source.relativePath,
        objectType: source.info.isDirectory() ? 'directory' : 'file',
        deletedAt: new Date().toISOString(),
        fingerprint: before,
      };
      try {
        await writeManifest(entryDirectory, manifest);
      } catch (error) {
        if (error instanceof KernelError) throw error;
        fail('managed_trash_manifest_write_failed', id, error);
      }
      try {
        await renameNoReplace(source.path, join(entryDirectory, 'payload'), {
          sourceRoot: workspace.boundary,
          destinationRoot: entryDirectory,
          expectedSource: before,
        });
      }
      catch (error) {
        if (['managed_trash_cross_device', 'managed_trash_source_changed', 'managed_trash_move_recovery_required', 'managed_trash_noreplace_unsupported'].includes(codeOf(error) ?? '')) throw error;
        fail('managed_trash_move_failed', source.path, error);
      }
      await syncDirectory(dirname(source.path));
      await syncDirectory(entryDirectory);

      const payload = join(entryDirectory, 'payload');
      let moved: Awaited<ReturnType<typeof lstat>>;
      try { moved = await lstat(payload); }
      catch (error) { fail('managed_trash_verification_failed', id, error); }
      if (!matchesFingerprint(moved, before)) fail('managed_trash_verification_failed', id);
      const treeAfter = await inspectTree(payload, source.info.dev);
      if (treeImmediatelyBefore.length !== treeAfter.length
        || treeImmediatelyBefore.some((entry, index) => {
          const stored = treeAfter[index];
          return stored === undefined || stored.slice(stored.indexOf('\0') + 1) !== entry.slice(entry.indexOf('\0') + 1);
        })) fail('managed_trash_verification_failed', id);
      return publicEntry(manifest, 'recoverable');
    },

    async list(workspaceRoot, boundaryRoot, options = {}) {
      const workspace = await workspaceOf(workspaceRoot, boundaryRoot);
      const offset = options.offset ?? 0;
      const limit = options.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        fail('managed_trash_pagination_invalid');
      }
      const bucket = await bucketFor(workspace.root, false);
      if (bucket === undefined) return { entries: [], total: 0, hasMore: false, nextOffset: null };
      let names: string[];
      try { names = await readdir(bucket); }
      catch (error) { fail('managed_trash_list_failed', bucket, error); }
      if (names.length > MAX_TREE_ENTRIES) fail('managed_trash_tree_too_large', bucket);
      const entries: Array<ManagedTrashEntry | ManagedTrashAnomaly> = [];
      for (const id of names) {
        if (!ENTRY_ID.test(id)) {
          entries.push(publicAnomaly(id, workspace.identity, 'managed_trash_entry_id_invalid'));
          continue;
        }
        try {
          const entryDirectory = join(bucket, id);
          const directoryInfo = await lstat(entryDirectory);
          if (!directoryInfo.isDirectory() || await isReparsePoint(entryDirectory, directoryInfo)) fail('managed_trash_entry_invalid', id);
          assertPrivatePermissions(entryDirectory, directoryInfo);
          const children = await readdir(entryDirectory);
          if (!children.includes('manifest.json')) fail('managed_trash_manifest_missing', id);
          if (children.some(name => name !== 'manifest.json' && name !== 'payload')) fail('managed_trash_entry_invalid', id);
          const manifest = await readManifest(entryDirectory, workspace.identity, id);
          const target = resolve(workspace.root, manifest.relativePath);
          if (!isWithin(workspace.root, target)) fail('managed_trash_entry_invalid', id);
          // A workspace-level trash listing must not disclose entries outside the caller's current boundary.
          if (!isWithin(workspace.boundary, target)) continue;
          const payload = join(entryDirectory, 'payload');
          let payloadInfo: FileStat | undefined;
          try { payloadInfo = await lstat(payload); }
          catch (error) {
            if (codeOf(error) !== 'ENOENT') fail('managed_trash_entry_invalid', id, error);
          }
          if (payloadInfo !== undefined) {
            if (await isReparsePoint(payload, payloadInfo) || !matchesFingerprint(payloadInfo, manifest.fingerprint)) {
              fail('managed_trash_entry_invalid', id);
            }
            entries.push(publicEntry(manifest, 'recoverable'));
            continue;
          }
          let targetInfo: FileStat | undefined;
          try { targetInfo = await lstat(target); }
          catch (error) {
            if (codeOf(error) !== 'ENOENT') fail('managed_trash_entry_invalid', id, error);
          }
          const issue = targetInfo === undefined ? 'managed_trash_payload_missing'
            : matchesFingerprint(targetInfo, manifest.fingerprint) ? 'managed_trash_source_present'
              : 'managed_trash_restore_conflict';
          entries.push(publicEntry(manifest, 'interrupted', issue));
        } catch (error) {
          entries.push(publicAnomaly(id, workspace.identity, entryIssue(error)));
        }
      }
      entries.sort((left, right) => {
        const leftDate = 'deletedAt' in left ? left.deletedAt : '';
        const rightDate = 'deletedAt' in right ? right.deletedAt : '';
        return rightDate.localeCompare(leftDate) || left.id.localeCompare(right.id);
      });
      const page = entries.slice(offset, offset + limit);
      const hasMore = offset + page.length < entries.length;
      return { entries: page, total: entries.length, hasMore, nextOffset: hasMore ? offset + page.length : null };
    },

    async restore(workspaceRoot, boundaryRoot, id) {
      if (!ENTRY_ID.test(id)) fail('managed_trash_entry_invalid', id);
      const workspace = await workspaceOf(workspaceRoot, boundaryRoot);
      const bucket = await bucketFor(workspace.root, false);
      if (bucket === undefined) fail('managed_trash_entry_not_found', id);
      const entryDirectory = join(bucket, id);
      let entryInfo: FileStat;
      try { entryInfo = await lstat(entryDirectory); }
      catch (error) {
        if (codeOf(error) === 'ENOENT') fail('managed_trash_entry_not_found', id, error);
        fail('managed_trash_entry_unavailable', id, error);
      }
      if (!entryInfo.isDirectory() || await isReparsePoint(entryDirectory, entryInfo)) fail('managed_trash_entry_invalid', id);
      assertPrivatePermissions(entryDirectory, entryInfo);
      const manifest = await readManifest(entryDirectory, workspace.identity, id);
      const payload = join(entryDirectory, 'payload');
      let payloadInfo: FileStat | undefined;
      try { payloadInfo = await lstat(payload); }
      catch (error) {
        if (codeOf(error) !== 'ENOENT') fail('managed_trash_entry_unavailable', id, error);
      }
      const target = await targetFor(workspace.root, workspace.boundary, manifest);
      if (payloadInfo === undefined) {
        if (await targetExists(target)) {
          const restoredInfo = await lstat(target);
          if (matchesFingerprint(restoredInfo, manifest.fingerprint)) {
            await removeRestoredEntry(entryDirectory);
            return publicEntry(manifest, 'restored');
          }
          fail('managed_trash_restore_conflict', manifest.relativePath);
        }
        fail('managed_trash_entry_not_recoverable', id);
      }
      if (await isReparsePoint(payload, payloadInfo) || !matchesFingerprint(payloadInfo, manifest.fingerprint)
        || (manifest.objectType === 'file' && !payloadInfo.isFile())
        || (manifest.objectType === 'directory' && !payloadInfo.isDirectory())) {
        fail('managed_trash_entry_invalid', id);
      }
      const alreadyAtTarget = await targetExists(target);
      if (alreadyAtTarget) {
        fail('managed_trash_restore_conflict', manifest.relativePath);
      }
      await inspectTree(payload, payloadInfo.dev);
      const targetParentInfo = await stat(resolve(target, '..'));
      if (targetParentInfo.dev !== payloadInfo.dev) fail('managed_trash_cross_device', manifest.relativePath);
      try {
        await renameNoReplace(payload, target, {
          sourceRoot: entryDirectory,
          destinationRoot: workspace.boundary,
          expectedSource: manifest.fingerprint,
        });
      }
      catch (error) {
        const payloadStillExists = await targetExists(payload);
        const targetNowExists = await targetExists(target);
        if (!payloadStillExists && targetNowExists) {
          const movedInfo = await lstat(target);
          if (matchesFingerprint(movedInfo, manifest.fingerprint)) {
            await removeRestoredEntry(entryDirectory);
            return publicEntry(manifest, 'restored');
          }
        }
        if (targetNowExists || codeOf(error) === 'managed_trash_target_exists') {
          fail('managed_trash_restore_conflict', manifest.relativePath, error);
        }
        throw error;
      }
      const restoredInfo = await lstat(target);
      if (!matchesFingerprint(restoredInfo, manifest.fingerprint)
        || (manifest.objectType === 'file' && !restoredInfo.isFile())
        || (manifest.objectType === 'directory' && !restoredInfo.isDirectory())) {
        fail('managed_trash_restore_verification_failed', manifest.relativePath);
      }
      await syncDirectory(resolve(target, '..'));
      await syncDirectory(entryDirectory);
      await removeRestoredEntry(entryDirectory);
      return publicEntry(manifest, 'restored');
    },
  };
}
