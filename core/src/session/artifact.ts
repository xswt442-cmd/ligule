import { createHash } from 'node:crypto';
import type { SessionEvent } from './format.js';

export interface FileArtifact {
  readonly kind: 'file';
  readonly sessionId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly description?: string;
}

export function isFileArtifact(value: unknown): value is FileArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.some((key) => !['kind', 'sessionId', 'path', 'mimeType', 'bytes', 'sha256', 'description'].includes(key))
    || !['kind', 'sessionId', 'path', 'mimeType', 'bytes', 'sha256'].every((key) => Object.hasOwn(item, key))) return false;
  if (item.kind !== 'file' || typeof item.sessionId !== 'string' || item.sessionId.length === 0 || item.sessionId.length > 256
    || typeof item.path !== 'string' || item.path.length === 0 || item.path.length > 2048 || item.path.includes('\\')
    || item.path.startsWith('/') || /^[a-zA-Z]:/u.test(item.path)
    || item.path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || typeof item.mimeType !== 'string' || item.mimeType.length === 0 || item.mimeType.length > 128
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || Number(item.bytes) > 20 * 1024 * 1024
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) return false;
  return item.description === undefined || (typeof item.description === 'string' && [...item.description].length <= 400);
}

export interface IndexedFileArtifact {
  readonly artifactKey: string;
  readonly artifact: FileArtifact;
}

export function artifactKey(workspace: string, artifact: FileArtifact): string {
  if (!isFileArtifact(artifact)) throw new TypeError('artifact_invalid');
  return createHash('sha256').update(JSON.stringify([
    workspace, artifact.sessionId, artifact.path, artifact.sha256,
  ])).digest('hex');
}

export function confirmedFileArtifacts(events: readonly SessionEvent[], workspace: string): IndexedFileArtifact[] {
  const found = new Map<string, IndexedFileArtifact>();
  for (const event of events) {
    if (event.kind !== 'tool' || (event.tool !== 'present' && event.tool !== 'subagent')
      || typeof event.result !== 'object' || event.result === null) continue;
    const outcome = event.result as Record<string, unknown>;
    if (outcome.failed === true || typeof outcome.content !== 'object' || outcome.content === null) continue;
    const content = outcome.content as Record<string, unknown>;
    const child = event.tool === 'subagent' && typeof content.result === 'object' && content.result !== null
      ? content.result as Record<string, unknown> : undefined;
    const items = event.tool === 'present' ? content.artifacts : child?.artifacts;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isFileArtifact(item)) continue;
      const key = artifactKey(workspace, item);
      if (!found.has(key)) found.set(key, { artifactKey: key, artifact: item });
    }
  }
  return [...found.values()];
}
