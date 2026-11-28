import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { FileWriteQueue } from '../kernel/file-write-queue.js';
import { FILE_CHANGE_MAX_FILE_BYTES } from '../session/file-changes.js';
import { previewFileArtifact, readFileArtifact } from '../capability/artifact.js';
import { boundaryOf, limitsOf, skippedDirectories, workingDirectoryOf, type CapabilityConfig } from '../capability/limits.js';
import { isWithin, resolveWithin } from '../capability/paths.js';
import { versionOf } from '../kernel/observe.js';

export type ProjectFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'link' | 'other';
};

export type ProjectDirectoryPage = {
  readonly path: string;
  readonly entries: readonly ProjectFileEntry[];
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly incomplete: boolean;
};

export type ProjectFileSearchPage = {
  readonly query: string;
  readonly matches: readonly { readonly path: string }[];
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly incomplete: boolean;
};

export type ProjectFilePreview = {
  readonly path: string;
  readonly size: number;
  readonly version: string | null;
  readonly encoding: 'utf8' | 'image' | 'binary' | 'invalid_utf8' | 'too_large';
  readonly mimeType?: string;
  readonly imagePreview?: { readonly mimeType: 'image/webp'; readonly base64: string };
  readonly text?: string;
  readonly offsetBytes: number;
  readonly nextOffsetBytes: number | null;
};

const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_DIRECTORY_PAGE_SIZE = 200;
const MAX_DIRECTORY_SCAN_MS = 5_000;
const MAX_FILE_SEARCH_RESULTS = 4_000;
const MAX_FILE_SEARCH_PAGE_SIZE = 200;
const MAX_FILE_SEARCH_MS = 5_000;
const MAX_FILE_PAGE_BYTES = 64_000;
const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 128;

function textPath(value: unknown, { allowDot = false } = {}): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new KernelError('project_file_path_invalid');
  }
  const normalized = value.replaceAll('\\', '/');
  if (allowDot && (normalized === '.' || normalized === './')) return '.';
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized) || normalized.startsWith('//')
    || normalized.split('/').some(part => part === '..')) {
    throw new KernelError('project_file_path_invalid');
  }
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.');
  if (parts.length === 0) {
    if (allowDot) return '.';
    throw new KernelError('project_file_path_invalid');
  }
  return parts.join('/');
}

function safeResolutionError(error: unknown): never {
  const code = error instanceof KernelError ? error.code : undefined;
  if (code === 'path_escapes_boundary' || code === 'path_escapes_through_link' || code === 'path_escapes_workspace') {
    throw new KernelError(code, { cause: error });
  }
  if (code === 'path_hard_linked') throw new KernelError(code, { cause: error });
  if (code === 'boundary_missing' || code === 'boundary_required') throw new KernelError('project_boundary_unavailable', { cause: error });
  if (code === 'path_parent_missing' || code === 'path_not_found') throw new KernelError('project_file_not_found', { cause: error });
  throw new KernelError('project_file_path_unavailable', { cause: error });
}

function relativeFromCanonicalWorkingDirectory(workingDirectory: string, target: string): string {
  const path = relative(workingDirectory, target).split(sep).join('/');
  return path === '' ? '.' : path;
}

function boundaryPath(config: CapabilityConfig): string {
  const root = workingDirectoryOf(config);
  const relativeBoundary = relative(root, boundaryOf(config));
  const boundaryWithinProject = relativeBoundary === ''
    || (relativeBoundary !== '..' && !relativeBoundary.startsWith(`..${sep}`) && !isAbsolute(relativeBoundary));
  return !boundaryWithinProject || relativeBoundary === '' ? '.' : relativeBoundary.split(sep).join('/');
}

async function resolveProjectPath(config: CapabilityConfig, pathValue: unknown, allowDot: boolean, forWrite = false): Promise<string> {
  const requested = textPath(pathValue, { allowDot });
  const path = allowDot && requested === '.' ? boundaryPath(config) : requested;
  try {
    const target = await resolveWithin(boundaryOf(config), path.split('/').join(sep), { cwd: workingDirectoryOf(config), forWrite });
    const workspaceRoot = await realpath(workingDirectoryOf(config));
    if (!isWithin(workspaceRoot, target)) throw new KernelError('path_escapes_workspace');
    return target;
  } catch (error) {
    return safeResolutionError(error);
  }
}

function pageBounds(offsetValue: unknown, limitValue: unknown, defaultLimit: number, maxLimit: number,
  maxOffset = MAX_FILE_SEARCH_RESULTS): { offset: number; limit: number } {
  const offset = offsetValue ?? 0;
  const limit = limitValue ?? defaultLimit;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > maxOffset
    || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maxLimit) {
    throw new KernelError('project_file_page_invalid');
  }
  return { offset: Number(offset), limit: Number(limit) };
}

function entryKind(entry: import('node:fs').Dirent): ProjectFileEntry['kind'] {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'link';
  return 'other';
}

function compareEntries(left: ProjectFileEntry, right: ProjectFileEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  const leftKey = left.isDirectory() ? `${left.name}/` : left.name;
  const rightKey = right.isDirectory() ? `${right.name}/` : right.name;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

type FileScan = { readonly maxEntries: number; readonly deadline: number; visited: number; incomplete: boolean; stopped: boolean };

async function* walkProjectFiles(root: string, skipped: ReadonlySet<string>, state: FileScan, directory = root,
  depth = 0): AsyncGenerator<string> {
  if (state.stopped) return;
  if (depth > 128) { state.incomplete = true; return; }
  if (Date.now() >= state.deadline) { state.incomplete = true; state.stopped = true; return; }
  let handle;
  try { handle = await opendir(directory); }
  catch (error) {
    if (depth === 0) throw error;
    state.incomplete = true;
    return;
  }
  const entries: Dirent[] = [];
  let scanLimitReached = false;
  try {
    while (true) {
      if (Date.now() >= state.deadline || state.visited >= state.maxEntries) {
        state.incomplete = true;
        scanLimitReached = true;
        break;
      }
      const entry = await handle.read();
      if (entry === null) break;
      state.visited += 1;
      entries.push(entry);
    }
  } catch {
    state.incomplete = true;
    scanLimitReached = true;
  } finally {
    await handle.close().catch(() => undefined);
  }
  entries.sort(compareDirectoryEntries);
  for (const entry of entries) {
    if (state.stopped) return;
    if (Date.now() >= state.deadline) { state.incomplete = true; state.stopped = true; return; }
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) yield* walkProjectFiles(root, skipped, state, join(directory, entry.name), depth + 1);
    } else if (entry.isFile()) {
      const path = relative(root, join(directory, entry.name)).split(sep).join('/');
      if (!/[\u0000-\u001f\u007f]/u.test(path)) yield path;
      else state.incomplete = true;
    }
  }
  if (scanLimitReached) state.stopped = true;
}

export async function listProjectDirectory(config: CapabilityConfig, pathValue: unknown, offsetValue: unknown, limitValue: unknown): Promise<ProjectDirectoryPage> {
  const limits = limitsOf(config);
  const { offset, limit } = pageBounds(offsetValue, limitValue, 100, Math.min(MAX_DIRECTORY_PAGE_SIZE, limits.resultCount),
    MAX_DIRECTORY_ENTRIES);
  const requestedPath = pathValue === undefined ? boundaryPath(config) : pathValue;
  const target = await resolveProjectPath(config, requestedPath, true);
  const workingRoot = await realpath(workingDirectoryOf(config));
  let info;
  try { info = await stat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('project_directory_not_found', { cause: error });
    throw new KernelError('project_directory_unreadable', { cause: error });
  }
  if (!info.isDirectory()) throw new KernelError('project_path_not_directory');

  const skipped = new Set(skippedDirectories(config));
  const entries: ProjectFileEntry[] = [];
  const deadline = Date.now() + MAX_DIRECTORY_SCAN_MS;
  let incomplete = false;
  let scannedEntries = 0;
  const parent = relativeFromCanonicalWorkingDirectory(workingRoot, target);
  let directory;
  try { directory = await opendir(target); }
  catch (error) { throw new KernelError('project_directory_unreadable', { cause: error }); }
  try {
    for await (const entry of directory) {
      scannedEntries += 1;
      if (Date.now() >= deadline || scannedEntries > MAX_DIRECTORY_ENTRIES) {
        incomplete = true;
        break;
      }
      const kind = entryKind(entry);
      if (kind === 'directory' && skipped.has(entry.name)) continue;
      if (/[\u0000-\u001f\u007f/\\]/u.test(entry.name)) {
        incomplete = true;
        continue;
      }
      const path = parent === '.' ? entry.name : `${parent}/${entry.name}`;
      entries.push({ name: entry.name, path, kind });
    }
  } catch (error) {
    throw new KernelError('project_directory_unreadable', { cause: error });
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort(compareEntries);
  const page = entries.slice(offset, offset + limit);
  const hasMore = offset + page.length < entries.length;
  return {
    path: parent,
    entries: page,
    offset,
    nextOffset: hasMore ? offset + page.length : null,
    incomplete,
  };
}

export async function searchProjectFiles(config: CapabilityConfig, queryValue: unknown, pathValue: unknown,
  offsetValue: unknown, limitValue: unknown): Promise<ProjectFileSearchPage> {
  if (typeof queryValue !== 'string' || queryValue.trim() === '' || queryValue.length > MAX_QUERY_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(queryValue)) throw new KernelError('project_file_query_invalid');
  const query = queryValue.trim();
  const limits = limitsOf(config);
  const { offset, limit } = pageBounds(offsetValue, limitValue, 50, Math.min(MAX_FILE_SEARCH_PAGE_SIZE, limits.resultCount));
  const requestedPath = pathValue === undefined ? boundaryPath(config) : pathValue;
  const searchRoot = await resolveProjectPath(config, requestedPath, true);
  const workingRoot = await realpath(workingDirectoryOf(config));
  let info;
  try { info = await stat(searchRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('project_directory_not_found', { cause: error });
    throw new KernelError('project_directory_unreadable', { cause: error });
  }
  if (!info.isDirectory()) throw new KernelError('project_path_not_directory');

  const scan: FileScan = { visited: 0, maxEntries: Math.min(Math.max(1, limits.scanFiles), MAX_DIRECTORY_ENTRIES),
    deadline: Date.now() + MAX_FILE_SEARCH_MS, incomplete: false, stopped: false };
  const skipped = new Set(skippedDirectories(config));
  const paths: string[] = [];
  const requiredMatches = Math.min(MAX_FILE_SEARCH_RESULTS + 1, offset + limit + 1);
  try {
    for await (const path of walkProjectFiles(searchRoot, skipped, scan)) {
      if (!path.toLowerCase().includes(query.toLowerCase())) continue;
      paths.push(path);
      if (paths.length >= requiredMatches) break;
    }
  } catch (error) {
    throw new KernelError('project_file_search_unavailable', { cause: error });
  }
  const incomplete = scan.incomplete;
  const prefix = relativeFromCanonicalWorkingDirectory(workingRoot, searchRoot);
  const matches = paths.slice(offset, offset + limit).map(path => ({ path: prefix === '.' ? path : `${prefix}/${path}` }));
  const hasMore = offset + matches.length < paths.length;
  return {
    query,
    matches,
    offset,
    nextOffset: hasMore ? offset + matches.length : null,
    incomplete,
  };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}

/** 来源校验使用的文本窗口上限：与 Desktop 合并分页的上限一致，超过就按不可验证处理。 */
export const PROJECT_FILE_TEXT_WINDOW_BYTES = 256 * 1024;

export type ProjectFileTextSnapshot =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unavailable' };

/**
 * 读取一份有界、版本一致的文本快照，供 Side Chat 等来源校验使用。
 * 逐页读取并核对 version；页面间版本变化按 stale 返回，非 UTF-8、超限或读取失败返回 unavailable。
 * 选择可能跨页，因此必须把同一版本的页面拼起来再做包含判断，不能只读 offset=0 的第一页。
 */
export async function readProjectFileText(config: CapabilityConfig, sessionId: string, pathValue: unknown,
  expectedVersion: string): Promise<ProjectFileTextSnapshot> {
  const pages: string[] = [];
  let offset = 0;
  let total = 0;
  let version: string | undefined;
  while (total < PROJECT_FILE_TEXT_WINDOW_BYTES) {
    const page = await readProjectFile(config, sessionId, pathValue, offset, MAX_FILE_PAGE_BYTES);
    if (page.encoding !== 'utf8' || typeof page.text !== 'string' || page.version === null) return { kind: 'unavailable' };
    version ??= page.version;
    if (page.version !== version) return { kind: 'stale' };
    if (page.version !== expectedVersion) return { kind: 'stale' };
    pages.push(page.text);
    total += Buffer.byteLength(page.text, 'utf8');
    if (page.nextOffsetBytes === null || total >= PROJECT_FILE_TEXT_WINDOW_BYTES) break;
    offset = page.nextOffsetBytes;
  }
  return { kind: 'text', text: pages.join('') };
}

export async function readProjectFile(config: CapabilityConfig, sessionId: string, pathValue: unknown, offsetValue: unknown,
  limitValue: unknown): Promise<ProjectFilePreview> {
  const path = textPath(pathValue);
  const limits = limitsOf(config);
  const offset = offsetValue ?? 0;
  const requestedLimit = limitValue ?? Math.min(limits.readBytes, MAX_FILE_PAGE_BYTES);
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new KernelError('project_file_offset_invalid');
  if (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 4 || Number(requestedLimit) > MAX_FILE_PAGE_BYTES) {
    throw new KernelError('project_file_read_limit_invalid');
  }
  const limit = Math.min(Number(requestedLimit), limits.readBytes, MAX_FILE_PAGE_BYTES);
  if (limit < 4) throw new KernelError('project_file_read_limit_unavailable');
  const target = await resolveProjectPath(config, path, false);
  const workingRoot = await realpath(workingDirectoryOf(config));
  let info;
  try { info = await stat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('project_file_not_found', { cause: error });
    throw new KernelError('project_file_unreadable', { cause: error });
  }
  if (!info.isFile()) throw new KernelError('project_file_not_regular');
  const displayPath = relativeFromCanonicalWorkingDirectory(workingRoot, target);
  if (info.size > FILE_CHANGE_MAX_FILE_BYTES) {
    return { path: displayPath, size: info.size, version: null, encoding: 'too_large', offsetBytes: Number(offset), nextOffsetBytes: null };
  }
  let artifact;
  try {
    artifact = await readFileArtifact({ path: displayPath }, sessionId, workingDirectoryOf(config), boundaryOf(config),
      undefined, FILE_CHANGE_MAX_FILE_BYTES, FILE_CHANGE_MAX_FILE_BYTES);
  } catch (error) {
    if (error instanceof KernelError && error.code === 'artifact_file_changed') throw new KernelError('project_file_changed', { cause: error });
    throw new KernelError('project_file_unreadable', { cause: error });
  }
  const bytes = artifact.preview ?? Buffer.alloc(0);
  if (bytes.length > FILE_CHANGE_MAX_FILE_BYTES) {
    return { path: displayPath, size: bytes.length, version: null, encoding: 'too_large', mimeType: artifact.artifact.mimeType,
      offsetBytes: Number(offset), nextOffsetBytes: null };
  }
  const version = versionOf(bytes);
  const mimeType = artifact.artifact.mimeType;
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
    if (Number(offset) !== 0) throw new KernelError('project_file_offset_invalid');
    const preview = await previewFileArtifact(artifact.artifact, workingDirectoryOf(config), boundaryOf(config)).catch((error: unknown) => {
      if (error instanceof KernelError && error.code === 'artifact_modified') throw new KernelError('project_file_changed', { cause: error });
      throw new KernelError('project_file_image_preview_failed', { cause: error });
    });
    if (preview.type !== 'image') {
      return { path: displayPath, size: bytes.length, version, encoding: 'binary', mimeType, offsetBytes: 0, nextOffsetBytes: null };
    }
    return { path: displayPath, size: bytes.length, version, encoding: 'image', mimeType,
      imagePreview: { mimeType: 'image/webp', base64: preview.base64 }, offsetBytes: 0, nextOffsetBytes: null };
  }
  if (['application/pdf', 'application/zip'].includes(mimeType) || bytes.includes(0)) {
    if (Number(offset) !== 0) throw new KernelError('project_file_offset_invalid');
    return { path: displayPath, size: bytes.length, version, encoding: 'binary', mimeType, offsetBytes: 0, nextOffsetBytes: null };
  }
  if (!isUtf8(bytes)) {
    if (Number(offset) !== 0) throw new KernelError('project_file_offset_invalid');
    return { path: displayPath, size: bytes.length, version, encoding: 'invalid_utf8', mimeType,
      offsetBytes: 0, nextOffsetBytes: null };
  }
  const start = Number(offset);
  if (start > bytes.length || !isUtf8Boundary(bytes, start)) throw new KernelError('project_file_offset_invalid');
  let end = Math.min(bytes.length, start + limit);
  while (end > start && !isUtf8(bytes.subarray(start, end))) end -= 1;
  const text = bytes.subarray(start, end).toString('utf8');
  return {
    path: displayPath,
    size: bytes.length,
    version,
    encoding: 'utf8',
    mimeType,
    text,
    offsetBytes: start,
    nextOffsetBytes: end < bytes.length ? end : null,
  };
}

export type ProjectFileSave = {
  readonly path: string;
  readonly target: string;
  readonly beforeBytes: Buffer;
  readonly expectedAfterBytes: Buffer;
  readonly outcome: 'written' | 'unchanged' | 'unknown';
  readonly saved: boolean;
  readonly changed: boolean | null;
  readonly mutationAttempted: boolean;
  readonly version: string | null;
  readonly recorded: boolean;
  readonly errorCode?: string;
};

function wellFormedText(text: string): boolean {
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return !text.includes('\u0000');
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

export async function saveProjectFile(config: CapabilityConfig, sessionId: string, pathValue: unknown, expectedVersionValue: unknown,
  textValue: unknown, queue: FileWriteQueue, authorize: () => Promise<void>,
  recordChange: (result: Omit<ProjectFileSave, 'recorded'>) => Promise<boolean>): Promise<ProjectFileSave> {
  const path = textPath(pathValue);
  if (typeof expectedVersionValue !== 'string' || !/^[a-f0-9]{16}$/iu.test(expectedVersionValue)) {
    throw new KernelError('project_file_version_invalid');
  }
  if (typeof textValue !== 'string' || !wellFormedText(textValue)) throw new KernelError('project_file_text_invalid');
  const expectedAfterBytes = Buffer.from(textValue, 'utf8');
  if (expectedAfterBytes.length > FILE_CHANGE_MAX_FILE_BYTES) throw new KernelError('project_file_too_large');
  const target = await resolveProjectPath(config, path, false, true);
  let initialInfo;
  try { initialInfo = await lstat(target); }
  catch (error) { throw new KernelError('project_file_not_found', { cause: error }); }
  if (!initialInfo.isFile() || initialInfo.isSymbolicLink()) throw new KernelError('project_file_not_regular');
  if (initialInfo.size > FILE_CHANGE_MAX_FILE_BYTES) throw new KernelError('project_file_too_large');

  return await queue.run(target, async () => {
    await authorize();
    const currentTarget = await resolveProjectPath(config, path, false, true);
    if (currentTarget !== target) throw new KernelError('project_file_target_changed');
    let currentInfo;
    try { currentInfo = await lstat(currentTarget); }
    catch (error) { throw new KernelError('project_file_target_changed', { cause: error }); }
    if (!sameFileIdentity(initialInfo, currentInfo)) throw new KernelError('project_file_target_changed');

    const displayPath = path;
    const withRecord = async (result: Omit<ProjectFileSave, 'recorded'>): Promise<ProjectFileSave> => {
      let recorded = false;
      try { recorded = await recordChange(result); }
      catch { recorded = false; }
      return { ...result, recorded, ...(recorded ? {} : { errorCode: 'workspace_file_change_record_failed' }) };
    };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let beforeBytes: Buffer | undefined;
    let mutationAttempted = false;
    let writeFailed = false;
    try {
      const flags = constants.O_RDWR | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
      handle = await open(currentTarget, flags);
      const [openedInfo, namedInfo, realTarget] = await Promise.all([
        handle.stat(), lstat(currentTarget), realpath(currentTarget),
      ]);
      const realBoundary = await realpath(boundaryOf(config));
      if (!sameFileIdentity(initialInfo, openedInfo) || !sameFileIdentity(initialInfo, namedInfo)
        || realTarget !== currentTarget || !isWithin(realBoundary, realTarget)) {
        throw new KernelError('project_file_target_changed');
      }
      beforeBytes = await handle.readFile();
      if (beforeBytes.length > FILE_CHANGE_MAX_FILE_BYTES) throw new KernelError('project_file_too_large');
      if (beforeBytes.includes(0) || !isUtf8(beforeBytes)) throw new KernelError('project_file_not_utf8');
      const version = versionOf(beforeBytes);
      if (version !== expectedVersionValue.toLowerCase()) throw new KernelError('project_file_conflict');
      if (beforeBytes.equals(expectedAfterBytes)) {
        return { path: displayPath, target: currentTarget, beforeBytes, expectedAfterBytes, outcome: 'unchanged',
          saved: true, changed: false, mutationAttempted: false, version, recorded: true };
      }

      mutationAttempted = true;
      await handle.truncate(0);
      let written = 0;
      while (written < expectedAfterBytes.length) {
        const result = await handle.write(expectedAfterBytes, written, expectedAfterBytes.length - written, written);
        if (result.bytesWritten === 0) throw new Error('project_file_write_zero_bytes');
        written += result.bytesWritten;
      }
      await handle.truncate(expectedAfterBytes.length);
      await handle.sync();
    } catch (error) {
      if (!mutationAttempted) {
        if (error instanceof KernelError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new KernelError('project_file_target_changed', { cause: error });
        if (code === 'EACCES' || code === 'EPERM') throw new KernelError('project_file_permission_denied', { cause: error });
        throw new KernelError('project_file_save_unavailable', { cause: error });
      }
      writeFailed = true;
    } finally {
      try { await handle?.close(); }
      catch (error) { if (mutationAttempted) writeFailed = true; else throw new KernelError('project_file_target_changed', { cause: error }); }
    }

    if (!mutationAttempted || beforeBytes === undefined) throw new KernelError('project_file_save_state_invalid');
    let observed: Buffer | undefined;
    try {
      const after = await readFileArtifact({ path: displayPath }, sessionId, workingDirectoryOf(config), boundaryOf(config),
        undefined, FILE_CHANGE_MAX_FILE_BYTES, FILE_CHANGE_MAX_FILE_BYTES);
      observed = after.preview;
    } catch { /* The write result stays unknown when a safe readback is unavailable. */ }

    if (observed?.equals(expectedAfterBytes)) {
      return await withRecord({ path: displayPath, target: currentTarget, beforeBytes, expectedAfterBytes, outcome: 'written',
        saved: true, changed: true, mutationAttempted: true, version: versionOf(observed) });
    }
    if (observed?.equals(beforeBytes)) {
      return await withRecord({ path: displayPath, target: currentTarget, beforeBytes, expectedAfterBytes, outcome: 'unchanged',
        saved: false, changed: false, mutationAttempted: true, version: versionOf(beforeBytes), errorCode: 'project_file_save_failed' });
    }
    return await withRecord({ path: displayPath, target: currentTarget, beforeBytes, expectedAfterBytes, outcome: 'unknown',
      saved: false, changed: null, mutationAttempted: true, version: observed === undefined ? null : versionOf(observed),
      errorCode: writeFailed ? 'project_file_save_outcome_unknown' : 'project_file_readback_mismatch' });
  });
}
