import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { KernelError } from '../errors.js';

export interface ToolResultCursorIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly eventSeq: number;
  readonly sha256: string;
}

export interface ToolResultSpillReference {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

const SPILL_NAME = /^result-\d+-[a-f0-9]{8}\.json$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CURSOR_LENGTH = 768;

function cursorError(): KernelError {
  return new KernelError('tool_result_cursor_invalid');
}

export function encodeToolResultCursor(identity: ToolResultCursorIdentity, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw cursorError();
  const encoded = Buffer.from(JSON.stringify({ v: 1, s: identity.sessionId, r: identity.runId,
    c: identity.callId, e: identity.eventSeq, d: identity.sha256, o: offset }), 'utf8').toString('base64url');
  if (encoded.length > MAX_CURSOR_LENGTH) throw cursorError();
  return encoded;
}

export function decodeToolResultCursor(value: unknown, identity: ToolResultCursorIdentity): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw cursorError();
  let payload: unknown;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw cursorError();
    payload = JSON.parse(decoded.toString('utf8'));
  }
  catch { throw cursorError(); }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw cursorError();
  const cursor = payload as Record<string, unknown>;
  if (cursor.v !== 1 || cursor.s !== identity.sessionId || cursor.r !== identity.runId
    || cursor.c !== identity.callId || cursor.e !== identity.eventSeq || cursor.d !== identity.sha256
    || !Number.isSafeInteger(cursor.o) || Number(cursor.o) < 0) throw cursorError();
  return Number(cursor.o);
}

export async function readVerifiedToolResultSpillPage(
  directory: string,
  reference: ToolResultSpillReference,
  offset: number,
  limitBytes: number,
): Promise<Buffer> {
  if (!SPILL_NAME.test(reference.name) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0
    || !SHA256.test(reference.sha256) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 4_096 || offset > reference.bytes) {
    throw new KernelError('session_spill_reference_invalid');
  }
  const requestedEnd = Math.min(reference.bytes, offset + limitBytes);
  let handle;
  try {
    const base = await realpath(directory);
    const path = join(directory, reference.name);
    const resolved = await realpath(path);
    const local = relative(base, resolved);
    const metadata = await lstat(path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || metadata.isSymbolicLink() || !metadata.isFile()) throw new KernelError('session_spill_reference_invalid');
    handle = await open(path, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== reference.bytes) throw new KernelError('session_spill_integrity_invalid');
    const hash = createHash('sha256');
    const page: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const current = chunk.subarray(0, bytesRead);
      hash.update(current);
      const overlapStart = Math.max(offset, position);
      const overlapEnd = Math.min(requestedEnd, position + bytesRead);
      if (overlapStart < overlapEnd) page.push(Buffer.from(current.subarray(overlapStart - position, overlapEnd - position)));
      position += bytesRead;
    }
    if (position !== reference.bytes || hash.digest('hex') !== reference.sha256) {
      throw new KernelError('session_spill_integrity_invalid');
    }
    return Buffer.concat(page);
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    throw new KernelError('session_spill_read_failed', { cause, detail: reference.name });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function checkedToolResultSpillReference(value: unknown): ToolResultSpillReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const reference = value as Record<string, unknown>;
  if (typeof reference.name !== 'string' || !SPILL_NAME.test(reference.name)
    || !Number.isSafeInteger(reference.bytes) || Number(reference.bytes) < 0
    || typeof reference.sha256 !== 'string' || !SHA256.test(reference.sha256)) return undefined;
  return { name: reference.name, bytes: Number(reference.bytes), sha256: reference.sha256 };
}
