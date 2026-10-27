import { useEffect, useRef, useState } from 'react';
import type { Client } from '../protocol';
import type { FileDelivery } from '../rows';
import { useText } from '../locale';

type StoredArtifact = { artifactKey: string; artifact: FileDelivery };
type ArtifactPage = { items: StoredArtifact[]; nextOffset: number | null };
type PreviewResult = { status: string; preview?: { type: 'text'; text: string; truncated: boolean }
  | { type: 'image'; mimeType: 'image/webp'; base64: string } | { type: 'unsupported_preview' } };

export function FileArtifactCard({ file, client, sessionId, projectRoot }: {
  file: FileDelivery; client: Client; sessionId: string; projectRoot: string;
}) {
  const t = useText();
  const [state, setState] = useState<{ status?: string; artifactKey?: string; text?: string; image?: string; busy: boolean; error?: string }>({ busy: false });
  const generation = useRef(0);
  const imageUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    generation.current += 1;
    if (imageUrl.current !== undefined) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = undefined;
    setState({ busy: false });
    return () => {
      generation.current += 1;
      if (imageUrl.current !== undefined) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = undefined;
    };
  }, [client, file.path, file.sha256, file.sessionId, projectRoot, sessionId]);

  async function inspect() {
    const requested = ++generation.current;
    setState({ busy: true });
    try {
      let offset = 0;
      let matching: StoredArtifact | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await client.call('artifact.list', { projectRoot, sessionId, limit: 50, offset }, 15_000) as ArtifactPage;
        matching = result.items.find(item => item.artifact.sessionId === file.sessionId && item.artifact.path === file.path
          && item.artifact.sha256 === file.sha256);
        if (matching !== undefined || result.nextOffset === null) break;
        offset = result.nextOffset;
      }
      if (matching === undefined) throw new Error('artifact_not_in_session');
      const result = await client.call('artifact.inspect', {
        projectRoot, sessionId, artifactKey: matching.artifactKey,
      }, 15_000) as { status: string };
      if (result.status !== 'available') {
        if (requested === generation.current) setState({ busy: false, status: result.status, artifactKey: matching.artifactKey });
        return;
      }
      const preview = await client.call('artifact.preview', {
        projectRoot, sessionId, artifactKey: matching.artifactKey,
      }, 15_000) as PreviewResult;
      if (requested !== generation.current) return;
      if (imageUrl.current !== undefined) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = undefined;
      let image: string | undefined;
      if (preview.preview?.type === 'image') {
        const encoded = preview.preview.base64;
        if (encoded.length > 4 * Math.ceil(256 * 1024 / 3)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
          throw new Error('artifact_preview_invalid');
        }
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        if (bytes.byteLength > 256 * 1024) throw new Error('artifact_preview_invalid');
        image = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
        imageUrl.current = image;
      }
      setState({ busy: false, status: preview.status, artifactKey: matching.artifactKey, text: preview.preview?.type === 'text'
        ? preview.preview.text + (preview.preview.truncated ? '\n…' : '') : undefined, image });
    } catch (cause) {
      if (requested === generation.current) setState({ busy: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return <section className="file-delivery">
    <div><strong>{file.path.split('/').at(-1)}</strong>{file.description ? ` · ${file.description}` : ''}</div>
    <small>{file.path} · {file.mimeType} · {file.bytes} B · SHA-256 {file.sha256.slice(0, 12)}…</small>
    <div>
      <button type="button" disabled={state.busy} onClick={() => void inspect()}>
        {state.busy ? t('检查中…', 'Checking…') : t('检查并预览', 'Verify and preview')}
      </button>
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(file.path).catch(() => setState(current => ({ ...current, error: 'clipboard_unavailable' })));
      }}>{t('复制相对路径', 'Copy relative path')}</button>
      {state.status === 'available' && state.artifactKey !== undefined && window.liguleDesktop?.revealArtifact !== undefined &&
        <button type="button" onClick={() => {
          const revealArtifact = window.liguleDesktop?.revealArtifact;
          if (revealArtifact === undefined) return;
          void revealArtifact({ projectRoot, sessionId, artifactKey: state.artifactKey! })
            .catch(() => setState(current => ({ ...current, error: 'artifact_reveal_unavailable' })));
        }}>{t('在文件夹中显示', 'Show in folder')}</button>}
    </div>
    {state.status !== undefined && <small>{state.status}</small>}
    {state.text !== undefined && <pre>{state.text}</pre>}
    {state.image !== undefined && <img src={state.image} alt={file.path} style={{ maxWidth: '100%', maxHeight: 512 }} />}
    {state.error !== undefined && <small role="status">{t('文件不可用', 'File unavailable')}
      {/^[a-z][a-z0-9_]{0,79}$/u.test(state.error) ? ` · ${state.error}` : ''}</small>}
  </section>;
}
