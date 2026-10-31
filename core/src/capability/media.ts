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
import { resolveWithin } from './paths.js';
import { boundaryOf, workingDirectoryOf } from './limits.js';
import { IMAGE_ID, IMAGE_LIMITS, isImageReference, type ImageReference } from '../session/media.js';
export { IMAGE_LIMITS, isImageReference, type ImageReference } from '../session/media.js';

const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readRegular(path: string, maxBytes: number, { allowHardLinks = false, signal }: { allowHardLinks?: boolean; signal?: AbortSignal } = {}): Promise<Buffer> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (!allowHardLinks && before.nlink !== 1)) throw new KernelError('image_storage_link');
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > maxBytes) throw new KernelError('image_storage_invalid');
    // Read at most the approved size even if another process grows the file.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, length, Math.min(bytes.length - length, 64 * 1024), null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new KernelError('image_bytes_exceeded');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function readImageFile(config: Parameters<typeof boundaryOf>[0], path: string, signal?: AbortSignal): Promise<Buffer> {
  const target = await resolveWithin(boundaryOf(config), path, { cwd: workingDirectoryOf(config) });
  return await readRegular(target, IMAGE_LIMITS.inputBytes, { allowHardLinks: true, signal });
}

async function exclusiveWrite(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

/** References remain local; providers resolve validated bytes only when constructing an HTTP request. */
export function createMediaStore(config: SessionDirectoryConfig, sessionId: string, inheritedReferences: readonly ImageReference[] = []) {
  if (sessionId.trim() === '' || sessionId.length > 256) throw new KernelError('image_session_required');
  const workspace = workspaceIdentity(config.workspaceRoot ?? config.boundary);
  const directory = join(workspaceDataDirectory(config), 'screenshots');
  const inherited = new Map(inheritedReferences.map(reference => {
    if (!isImageReference(reference) || reference.workspace !== workspace) throw new KernelError('image_owner_mismatch');
    return [reference.id, reference] as const;
  }));
  function owns(reference: ImageReference): boolean {
    if (reference.workspace !== workspace) return false;
    if (reference.sessionId === sessionId) return true;
    const allowed = inherited.get(reference.id);
    return allowed !== undefined && (Object.keys(allowed) as (keyof ImageReference)[]).every(key => allowed[key] === reference[key]);
  }

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
    const bytes = await readRegular(join(directory, `${id}.json`), 8192);
    let reference: unknown;
    try { reference = JSON.parse(bytes.toString('utf8')); }
    catch (cause) { throw new KernelError('image_reference_invalid', { cause }); }
    if (!isImageReference(reference) || reference.id !== id) throw new KernelError('image_reference_invalid');
    if (!owns(reference)) throw new KernelError('image_owner_mismatch');
    if (Date.now() - Date.parse(reference.createdAt) > IMAGE_LIMITS.retentionMs) throw new KernelError('image_expired');
    return reference;
  }

  async function read(reference: ImageReference, signal?: AbortSignal): Promise<Buffer> {
    try {
      signal?.throwIfAborted();
      if (!isImageReference(reference)) throw new KernelError('image_reference_invalid');
      if (!owns(reference)) throw new KernelError('image_owner_mismatch');
      await checkDirectory(false);
      const saved = await readMetadata(reference.id);
      for (const key of Object.keys(saved) as (keyof ImageReference)[]) {
        if (saved[key] !== reference[key]) throw new KernelError('image_reference_mismatch');
      }
      const bytes = await readRegular(join(directory, `${reference.id}.png`), IMAGE_LIMITS.outputBytes, { signal });
      if (bytes.length !== saved.bytes || digest(bytes) !== saved.sha256) throw new KernelError('image_digest_mismatch');
      signal?.throwIfAborted();
      return bytes;
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof KernelError) throw cause;
      throw new KernelError((cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'image_missing' : 'image_storage_read_failed', { cause });
    }
  }

  return {
    directory,
    read,
    async reference(id: string): Promise<ImageReference> {
      try {
        await checkDirectory(false);
        const result = await readMetadata(id);
        await read(result);
        return result;
      } catch (cause) {
        if (cause instanceof KernelError) throw cause;
        throw new KernelError((cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'image_missing' : 'image_storage_read_failed', { cause });
      }
    },
    async put(input: Buffer, source: ImageReference['source'], signal?: AbortSignal): Promise<ImageReference> {
      signal?.throwIfAborted();
      if (workspace.length > 2048) throw new KernelError('image_workspace_invalid');
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
        if (stored + bytes.length + 8192 > IMAGE_LIMITS.storageBytes) throw new KernelError('image_storage_full');
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

/** A transient display derivative; canonical records contain only the original reference. */
export async function imagePreview(media: MediaStore, reference: ImageReference) {
  const bytes = await media.read(reference);
  const output = await sharp(bytes, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning' })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 }).toBuffer({ resolveWithObject: true });
  if (output.data.length > 256 * 1024) throw new KernelError('image_preview_bytes_exceeded');
  return { imageId: reference.id, mimeType: 'image/webp' as const, base64: output.data.toString('base64'),
    width: output.info.width, height: output.info.height };
}
