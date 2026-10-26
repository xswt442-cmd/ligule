import { useLayoutEffect, useRef, useState } from 'react';
import { useText } from '../locale';
import type { Client } from '../protocol';
import type { ImageReference } from '../rows';

const MAX_BYTES = 256 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);

type Preview = { imageId: string; mimeType: 'image/webp'; base64: string; width: number; height: number };

function checkedPreview(value: unknown, imageId: string): Preview {
  if (typeof value !== 'object' || value === null) throw new Error('image_preview_invalid');
  const item = value as Record<string, unknown>;
  if (item.imageId !== imageId || item.mimeType !== 'image/webp'
    || typeof item.base64 !== 'string' || item.base64.length === 0 || item.base64.length > MAX_BASE64
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.base64)
    || !Number.isSafeInteger(item.width) || Number(item.width) < 1 || Number(item.width) > 512
    || !Number.isSafeInteger(item.height) || Number(item.height) < 1 || Number(item.height) > 512) {
    throw new Error('image_preview_invalid');
  }
  return { imageId, mimeType: 'image/webp', base64: item.base64, width: Number(item.width), height: Number(item.height) };
}

export function ImagePreview({ client, sessionId, projectRoot, image }: {
  client: Client;
  sessionId: string | null;
  projectRoot: string;
  image: ImageReference;
}) {
  const t = useText();
  const [state, setState] = useState<{ url?: string; width?: number; height?: number; loading: boolean; error?: string }>({ loading: false });
  const generation = useRef(0);
  const url = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    generation.current += 1;
    if (url.current !== undefined) URL.revokeObjectURL(url.current);
    url.current = undefined;
    setState({ loading: false });
    return () => {
      generation.current += 1;
      if (url.current !== undefined) URL.revokeObjectURL(url.current);
      url.current = undefined;
    };
  }, [client, image.id, projectRoot, sessionId]);

  async function load() {
    if (sessionId === null || sessionId === '' || state.loading) return;
    const request = ++generation.current;
    setState({ loading: true });
    try {
      const value = await client.call('session.image.preview', { sessionId, projectRoot, imageId: image.id }, 15_000);
      const preview = checkedPreview(value, image.id);
      if (generation.current !== request) return;
      const bytes = Uint8Array.from(atob(preview.base64), (character) => character.charCodeAt(0));
      if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('image_preview_invalid');
      const created = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
      if (generation.current !== request) {
        URL.revokeObjectURL(created);
        return;
      }
      if (url.current !== undefined) URL.revokeObjectURL(url.current);
      url.current = created;
      setState({ url: created, width: preview.width, height: preview.height, loading: false });
    } catch (error) {
      if (generation.current === request) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return <div className="image-preview">
    {state.url === undefined
      ? <button type="button" disabled={sessionId === null || state.loading} onClick={() => void load()}>
        {state.loading ? t('正在加载图片…', 'Loading image…') : t('预览图片', 'Preview image')}
      </button>
      : <img src={state.url} alt={t(`图片 ${image.width} × ${image.height}`, `Image ${image.width} × ${image.height}`)} width={state.width} height={state.height}
        onError={() => {
          if (url.current !== undefined) URL.revokeObjectURL(url.current);
          url.current = undefined;
          setState({ loading: false, error: 'image_preview_decode_failed' });
        }} />}
    {state.error !== undefined && <span role="status" className="image-preview-error">{t('图片预览不可用', 'Image preview unavailable')}{/^[a-z][a-z0-9_]{0,79}$/u.test(state.error) ? ` · ${state.error}` : ''}</span>}
  </div>;
}
