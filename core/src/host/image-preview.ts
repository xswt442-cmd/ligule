// 会话图片预览：按图片 ID 在会话记录里找到引用，再交给媒体存储解码；同一 Host 限制并发预览数。
// 记录只读；找不到引用或记录不存在都明确报错，不回退到其他会话。
import { access } from 'node:fs/promises';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import { createSessionLog, type SessionLog } from '../session/session.js';
import { checkedImageReferences } from '../media.js';
import { createMediaStore, imagePreview } from '../capability/media.js';
import type { SessionDirectoryConfig } from '../session/list.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new KernelError('protocol_args_invalid', { detail: `${field} must be a string` });
  return value;
}

export type ImagePreviewEnvironment = {
  readonly projectRoot: string;
  readonly directory: string;
  readonly config: SessionDirectoryConfig;
};

export type ImagePreviewDeps = {
  readonly environmentFor: (projectRoot: string) => Promise<ImagePreviewEnvironment>;
  readonly opened: (id: string) => { readonly session: SessionLog; readonly environment: { readonly projectRoot: string } } | undefined;
  readonly recordPathOf: (id: string, env: { readonly directory: string }) => string;
};

export type SessionImagePreview = (sessionId: string, params: { readonly projectRoot?: unknown; readonly imageId?: unknown }) => Promise<unknown>;

export function createSessionImagePreview(deps: ImagePreviewDeps): SessionImagePreview {
  let active = 0;
  return async (sessionId, params) => {
    if (active >= 4) throw new KernelError('image_preview_busy');
    active++;
    try {
      const env = await deps.environmentFor(requiredString(params.projectRoot, 'projectRoot'));
      const opened = deps.opened(sessionId);
      if (opened !== undefined && workspaceIdentity(opened.environment.projectRoot) !== workspaceIdentity(env.projectRoot)) {
        throw new KernelError('image_owner_mismatch');
      }
      const path = deps.recordPathOf(sessionId, env);
      try { await access(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('session_not_found');
        throw error;
      }
      const session = opened?.session ?? createSessionLog({ directory: env.directory, id: sessionId });
      const references = (await session.read()).flatMap(event =>
        event.kind === 'tool' && isRecord(event.result) && event.result.failed !== true && event.result.images !== undefined
          ? checkedImageReferences(event.result.images) : []);
      const reference = references.find(item => item.id === requiredString(params.imageId, 'imageId'));
      if (reference === undefined) throw new KernelError('image_not_in_session');
      const media = createMediaStore({ ...env.config, workspaceRoot: env.projectRoot }, sessionId, references);
      return await imagePreview(media, reference);
    } finally { active--; }
  };
}
