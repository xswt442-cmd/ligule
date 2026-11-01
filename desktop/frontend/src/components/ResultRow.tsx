import { Fold } from './Fold';
import type { RowProps } from './types';
import { ImagePreview } from './ImagePreview';
import { FileArtifactCard } from './FileArtifactCard';

// 结果卡片只显示工具名、变更量与附件；成功不需要额外状态词，失败由失败卡片负责。
export function ResultRow({ row, verbosity, client, sessionId, projectRoot }: RowProps) {
  return <article className="row result" data-kind="result">
    <div className="row-head">
      <code className="row-tool">{row.tool}</code>
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
