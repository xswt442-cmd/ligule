import type { Client } from './protocol';

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

export type ProjectFilePage = {
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

export type ProjectFileSnapshot = ProjectFilePage & { readonly text?: string };

export const MAX_PROJECT_FILE_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 64_000;
const MAX_FILE_PAGES = 64;
const MAX_IMAGE_PREVIEW_BYTES = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relativePath(value: unknown, allowDot = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (allowDot && normalized === '.') return '.';
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[a-z]:/iu.test(normalized)) return undefined;
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.');
  return parts.length === 0 || parts.some(part => part === '..') ? undefined : parts.join('/');
}

function checkedOffset(value: unknown, offset: number, maximum = MAX_PROJECT_FILE_BYTES): value is number | null {
  return value === null || Number.isSafeInteger(value) && Number(value) > offset && Number(value) <= maximum;
}

export async function listProjectDirectory(client: Client, sessionId: string, path: string, offset = 0): Promise<ProjectDirectoryPage> {
  const raw = await client.call('project.files.list', { sessionId, path, offset, limit: 100 }, 15_000);
  if (!object(raw) || relativePath(raw.path, true) === undefined || raw.offset !== offset
    || !Array.isArray(raw.entries) || raw.entries.length > 200 || !checkedOffset(raw.nextOffset, offset, 5000)
    || typeof raw.incomplete !== 'boolean') throw Object.assign(new Error('project_files_response_invalid'), { code: 'project_files_response_invalid' });
  const entries: ProjectFileEntry[] = [];
  for (const value of raw.entries) {
    if (!object(value) || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 255
      || /[\u0000-\u001f\u007f/\\]/u.test(value.name) || relativePath(value.path) === undefined
      || !['directory', 'file', 'link', 'other'].includes(String(value.kind))) {
      throw Object.assign(new Error('project_files_response_invalid'), { code: 'project_files_response_invalid' });
    }
    entries.push({ name: value.name, path: value.path as string, kind: value.kind as ProjectFileEntry['kind'] });
  }
  return { path: raw.path as string, entries, offset, nextOffset: raw.nextOffset as number | null, incomplete: raw.incomplete };
}

export async function searchProjectFiles(client: Client, sessionId: string, query: string, path: string, offset = 0): Promise<ProjectFileSearchPage> {
  const raw = await client.call('project.files.search', { sessionId, query, path, offset, limit: 100 }, 15_000);
  if (!object(raw) || typeof raw.query !== 'string' || raw.query.length > 128 || raw.offset !== offset
    || !Array.isArray(raw.matches) || raw.matches.length > 200 || !checkedOffset(raw.nextOffset, offset, 4000)
    || typeof raw.incomplete !== 'boolean'
    || raw.matches.some(value => !object(value) || relativePath(value.path) === undefined)) {
    throw Object.assign(new Error('project_files_response_invalid'), { code: 'project_files_response_invalid' });
  }
  return {
    query: raw.query,
    matches: raw.matches.map(value => ({ path: (value as { path: string }).path })),
    offset,
    nextOffset: raw.nextOffset as number | null,
    incomplete: raw.incomplete,
  };
}

async function readProjectFilePage(client: Client, sessionId: string, path: string, offsetBytes: number,
  signal?: AbortSignal): Promise<ProjectFilePage> {
  signal?.throwIfAborted();
  const raw = await client.call('project.file.read', { sessionId, path, offsetBytes, limitBytes: MAX_PAGE_BYTES }, 15_000);
  signal?.throwIfAborted();
  const encoding = object(raw) ? raw.encoding : undefined;
  const size = object(raw) ? raw.size : undefined;
  if (!object(raw) || relativePath(raw.path) !== relativePath(path) || !Number.isSafeInteger(size) || Number(size) < 0
    || encoding !== 'too_large' && Number(size) > MAX_PROJECT_FILE_BYTES
    || encoding === 'too_large' && Number(size) <= MAX_PROJECT_FILE_BYTES
    || raw.version !== null && (typeof raw.version !== 'string' || !/^[a-f0-9]{16}$/iu.test(raw.version))
    || !['utf8', 'image', 'binary', 'invalid_utf8', 'too_large'].includes(String(raw.encoding))
    || raw.offsetBytes !== offsetBytes || !checkedOffset(raw.nextOffsetBytes, offsetBytes)
    || raw.mimeType !== undefined && (typeof raw.mimeType !== 'string' || raw.mimeType.length > 200)) {
    throw Object.assign(new Error('project_file_response_invalid'), { code: 'project_file_response_invalid' });
  }
  const checkedEncoding = raw.encoding as ProjectFilePage['encoding'];
  if (checkedEncoding === 'utf8') {
    if (typeof raw.text !== 'string' || new TextEncoder().encode(raw.text).byteLength > MAX_PAGE_BYTES || raw.version === null) {
      throw Object.assign(new Error('project_file_response_invalid'), { code: 'project_file_response_invalid' });
    }
  } else if (checkedEncoding === 'image') {
    const preview = raw.imagePreview;
    if (!object(preview) || preview.mimeType !== 'image/webp' || typeof preview.base64 !== 'string'
      || preview.base64.length > 4 * Math.ceil(MAX_IMAGE_PREVIEW_BYTES / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(preview.base64)) {
      throw Object.assign(new Error('project_file_response_invalid'), { code: 'project_file_response_invalid' });
    }
    const bytes = Uint8Array.from(atob(preview.base64), character => character.charCodeAt(0));
    if (bytes.byteLength > MAX_IMAGE_PREVIEW_BYTES || raw.text !== undefined) {
      throw Object.assign(new Error('project_file_response_invalid'), { code: 'project_file_response_invalid' });
    }
  } else if (raw.text !== undefined || raw.imagePreview !== undefined || raw.nextOffsetBytes !== null
    || checkedEncoding === 'too_large' && raw.version !== null) {
    throw Object.assign(new Error('project_file_response_invalid'), { code: 'project_file_response_invalid' });
  }
  return raw as ProjectFilePage;
}

export async function readProjectFile(client: Client, sessionId: string, path: string, signal?: AbortSignal): Promise<ProjectFileSnapshot> {
  const first = await readProjectFilePage(client, sessionId, path, 0, signal);
  if (first.encoding !== 'utf8') return first;
  let page = first;
  let text = '';
  for (let index = 0; index < MAX_FILE_PAGES; index += 1) {
    if (page.encoding !== 'utf8' || page.version !== first.version
      || page.size !== first.size) throw Object.assign(new Error('project_file_changed'), { code: 'project_file_changed' });
    text += page.text ?? '';
    if (page.nextOffsetBytes === null) {
      if (new TextEncoder().encode(text).byteLength !== page.size) {
        throw Object.assign(new Error('project_file_page_incomplete'), { code: 'project_file_page_incomplete' });
      }
      return { ...first, text };
    }
    page = await readProjectFilePage(client, sessionId, path, page.nextOffsetBytes, signal);
  }
  throw Object.assign(new Error('project_file_page_limit_exceeded'), { code: 'project_file_page_limit_exceeded' });
}
