import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import sharp from 'sharp';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { dataRoot } from '../kernel/config-file.js';
import { workspaceDataDirectory, type SessionDirectoryConfig } from '../session/list.js';

export const IMAGE_LIMITS = Object.freeze({ inputBytes: 20 * 1024 * 1024, pixels: 40_000_000,
  dimension: 2048, outputBytes: 8 * 1024 * 1024, storageBytes: 256 * 1024 * 1024, retentionMs: 30 * 86_400_000 });
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);

export interface ImageReference {
  readonly kind: 'image';
  readonly version: 1;
  readonly id: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly source: 'file' | 'desktop' | 'browser' | 'document';
  readonly mimeType: 'image/png';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly createdAt: string;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isImageReference(value: unknown): value is ImageReference {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 12 && item.kind === 'image' && item.version === 1 && typeof item.id === 'string' && IMAGE_ID.test(item.id)
    && typeof item.workspace === 'string' && typeof item.sessionId === 'string' && item.sessionId.length > 0
    && ['file', 'desktop', 'browser', 'document'].includes(String(item.source)) && item.mimeType === 'image/png'
    && Number.isSafeInteger(item.bytes) && Number(item.bytes) > 0 && Number(item.bytes) <= IMAGE_LIMITS.outputBytes
    && Number.isSafeInteger(item.width) && Number(item.width) > 0 && Number(item.width) <= IMAGE_LIMITS.dimension
    && Number.isSafeInteger(item.height) && Number(item.height) > 0 && Number(item.height) <= IMAGE_LIMITS.dimension
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt));
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new KernelError('image_storage_link');
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > maxBytes) throw new KernelError('image_storage_invalid');
    // Read at most the approved size even if another process grows the file.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new KernelError('image_bytes_exceeded');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function exclusiveWrite(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

/** References remain local; providers resolve validated bytes only when constructing an HTTP request. */
export function createMediaStore(config: SessionDirectoryConfig, sessionId: string, inheritedSessionIds: readonly string[] = []) {
  if (sessionId.trim() === '') throw new KernelError('image_session_required');
  const workspace = workspaceIdentity(config.workspaceRoot ?? config.boundary);
  const directory = join(workspaceDataDirectory(config), 'screenshots');
  const ownedSessions = new Set([sessionId, ...inheritedSessionIds]);

  async function checkDirectory(create: boolean): Promise<void> {
    const root = dataRoot(config.userHome);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const parts = relative(root, directory).split(sep);
    let path = root;
    for (const part of ['', ...parts]) {
      if (part !== '') path = join(path, part);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new KernelError('image_storage_link');
    }
  }

  async function readMetadata(id: string): Promise<ImageReference> {
    if (!IMAGE_ID.test(id)) throw new KernelError('image_reference_invalid');
    const bytes = await readRegular(join(directory, `${id}.json`), 4096);
    let reference: unknown;
    try { reference = JSON.parse(bytes.toString('utf8')); }
    catch (cause) { throw new KernelError('image_reference_invalid', { cause }); }
    if (!isImageReference(reference) || reference.id !== id) throw new KernelError('image_reference_invalid');
    if (reference.workspace !== workspace || !ownedSessions.has(reference.sessionId)) throw new KernelError('image_owner_mismatch');
    if (Date.now() - Date.parse(reference.createdAt) > IMAGE_LIMITS.retentionMs) throw new KernelError('image_expired');
    return reference;
  }

  async function read(reference: ImageReference, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    if (!isImageReference(reference)) throw new KernelError('image_reference_invalid');
    if (reference.workspace !== workspace || !ownedSessions.has(reference.sessionId)) throw new KernelError('image_owner_mismatch');
    await checkDirectory(false);
    const saved = await readMetadata(reference.id);
    for (const key of Object.keys(saved) as (keyof ImageReference)[]) {
      if (saved[key] !== reference[key]) throw new KernelError('image_reference_mismatch');
    }
    const bytes = await readRegular(join(directory, `${reference.id}.png`), IMAGE_LIMITS.outputBytes);
    if (bytes.length !== saved.bytes || digest(bytes) !== saved.sha256) throw new KernelError('image_digest_mismatch');
    signal?.throwIfAborted();
    return bytes;
  }

  return {
    directory,
    read,
    async reference(id: string): Promise<ImageReference> {
      await checkDirectory(false);
      const result = await readMetadata(id);
      await read(result);
      return result;
    },
    async put(input: Buffer, source: ImageReference['source'], signal?: AbortSignal): Promise<ImageReference> {
      signal?.throwIfAborted();
      if (!['file', 'desktop', 'browser', 'document'].includes(source)) throw new KernelError('image_source_invalid');
      if (input.length === 0 || input.length > IMAGE_LIMITS.inputBytes) throw new KernelError('image_bytes_exceeded');
      const decoder = sharp(input, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning', page: 0, pages: 1 });
      // destroy(error) emits on the stream as well as rejecting an active Sharp promise.
      decoder.on('error', () => {});
      const cancel = () => { decoder.destroy(new Error('image_decode_cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
      let bytes: Buffer;
      let width: number;
      let height: number;
      try {
        const metadata = await decoder.metadata();
        if (!FORMATS.has(metadata.format ?? '')) throw new KernelError('image_format_unsupported');
        if ((metadata.width ?? 0) * (metadata.height ?? 0) > IMAGE_LIMITS.pixels) throw new KernelError('image_pixels_exceeded');
        const output = await decoder.rotate().resize({ width: IMAGE_LIMITS.dimension, height: IMAGE_LIMITS.dimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
        bytes = output.data;
        width = output.info.width;
        height = output.info.height;
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause instanceof KernelError) throw cause;
        throw new KernelError('image_decode_failed', { cause });
      } finally { signal?.removeEventListener('abort', cancel); decoder.destroy(); }
      signal?.throwIfAborted();
      if (bytes.length > IMAGE_LIMITS.outputBytes) throw new KernelError('image_bytes_exceeded');
      await checkDirectory(true);
      let compromised: Error | undefined;
      const unlock = await lockfile.lock(directory, { realpath: false, lockfilePath: join(directory, '.write.lock'),
        retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, onCompromised: error => { compromised = error; } });
      try {
        await checkDirectory(false);
        let stored = 0;
        for (const name of await readdir(directory)) {
          if (!/^[0-9a-f-]{36}\.(?:png|json)(?:\.part)?$/u.test(name) || !IMAGE_ID.test(name.slice(0, 36))) continue;
          const path = join(directory, name);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new KernelError('image_storage_link');
          if (Date.now() - info.mtimeMs > IMAGE_LIMITS.retentionMs) await unlink(path);
          else stored += info.size;
        }
        if (stored + bytes.length + 4096 > IMAGE_LIMITS.storageBytes) throw new KernelError('image_storage_full');
        signal?.throwIfAborted();
        if (compromised !== undefined) throw compromised;
        const id = randomUUID();
        const reference: ImageReference = { kind: 'image', version: 1, id, workspace, sessionId, source,
          mimeType: 'image/png', bytes: bytes.length, width, height, sha256: digest(bytes), createdAt: new Date().toISOString() };
        const imageTemp = join(directory, `${id}.png.part`);
        const metadataTemp = join(directory, `${id}.json.part`);
        let published = false;
        try {
          await exclusiveWrite(imageTemp, bytes);
          await rename(imageTemp, join(directory, `${id}.png`));
          await exclusiveWrite(metadataTemp, JSON.stringify(reference));
          signal?.throwIfAborted();
          if (compromised !== undefined) throw compromised;
          await checkDirectory(false);
          await rename(metadataTemp, join(directory, `${id}.json`));
          published = true;
          return reference;
        } finally {
          for (const path of [imageTemp, metadataTemp, ...(published ? [] : [join(directory, `${id}.png`)])]) {
            try { await unlink(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
      } finally { await unlock(); }
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
