import { useText } from '../locale';
import { sideChatContextBytes, type SideChatSelection } from '../side-chat';

export function SideChatDialog({ context, question, busy, error, onQuestion, onClose, onCreate }: {
  readonly context: SideChatSelection;
  readonly question: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onQuestion: (value: string) => void;
  readonly onClose: () => void;
  readonly onCreate: () => void;
}) {
  const t = useText();
  const source = context.source.kind === 'event'
    ? t(`会话事件 ${context.source.eventSeq}`, `Session event ${context.source.eventSeq}`)
    : context.source.kind === 'file'
      ? t(`文件 ${context.source.path} · ${context.source.version.slice(0, 12)}`, `File ${context.source.path} · ${context.source.version.slice(0, 12)}`)
      : t(`Git 差异 ${context.source.path}`, `Git diff ${context.source.path}`);
  return <div className="side-chat-scrim" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="side-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="side-chat-title">
      <header>
        <div>
          <h2 id="side-chat-title">{t('侧面询问', 'Side question')}</h2>
          <p>{source} · {sideChatContextBytes(context.text)} {t('字节', 'bytes')}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t('关闭', 'Close')} onClick={onClose}>×</button>
      </header>
      <label>
        {t('附带的选中内容', 'Selected context')}
        <pre>{context.text}</pre>
      </label>
      <label>
        {t('你想问什么？', 'What would you like to ask?')}
        <textarea autoFocus maxLength={8_192} value={question} onChange={event => onQuestion(event.currentTarget.value)} />
      </label>
      {error !== null && <p className="side-chat-error" role="alert">{error}</p>}
      <footer>
        <p>{t('这会新建独立的只读会话。确认后问题会放入输入框，仍由你决定何时发送。',
          'This creates an independent read-only Session. The question will be placed in its composer for you to review and send.')}</p>
        <div>
          <button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button type="button" disabled={busy || question.trim() === ''} onClick={onCreate}>
            {busy ? t('正在创建…', 'Creating…') : t('创建侧聊', 'Create side chat')}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
