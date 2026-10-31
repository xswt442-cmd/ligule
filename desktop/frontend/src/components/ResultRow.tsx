import { Fold } from './Fold';
import { useText } from '../locale';
import type { RowProps } from './types';
import { ImagePreview } from './ImagePreview';
import { FileArtifactCard } from './FileArtifactCard';

// 结果卡片显示退出码、溢出文件、权限判定、派生会话和运行时长。
export function ResultRow({ row, verbosity, client, sessionId, projectRoot }: RowProps) {
  const t = useText();
  return <article className="row result" data-kind="result">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
      <span className="state-ok">{t('完成', 'Done')}</span>
      {row.diff !== undefined && <span className="diff">
        {row.diff.removed > 0 && <span className="diff-minus">−{row.diff.removed}</span>}
        <span className="diff-plus">+{row.diff.added}</span>
      </span>}
      {row.summary !== undefined && row.summary !== '' && <span className="row-target-inline">{row.summary}</span>}
      {row.notes?.map((note) => <span className="row-note" key={note}>{note}</span>)}
    </div>
    <Fold text={row.text} verbosity={verbosity} />
    {row.images?.map((image) => client !== undefined && projectRoot !== undefined
      ? <ImagePreview key={`${sessionId ?? ''}:${image.id}`} client={client} sessionId={sessionId ?? null} projectRoot={projectRoot} image={image} />
      : null)}
    {row.deliveries?.map((file) => client !== undefined && projectRoot !== undefined && sessionId
      ? <FileArtifactCard key={`${file.sessionId}:${file.path}:${file.sha256}`} file={file} client={client} sessionId={sessionId} projectRoot={projectRoot} />
      : null)}
  </article>;
}
