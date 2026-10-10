import { useEffect, useState } from 'react';

// 模型提问那一格（D107、方案 4.4）：一到四道题各答一次，一次显式提交。
// 它与审批卡分开画：审批答的是「能不能做这一件」，这一格答的是「这一件事该怎么办」。
export type QuestionOption = { label: string; description?: string };
export type Question = { id: string; question: string; header?: string; options: QuestionOption[]; multiSelect: boolean };
export type QuestionAsk = { id: string; sessionId: string; project: string; questions: Question[] };
/** 一张卡上打下的那些字：卡片收掉时由外面留成一条可读的记录，所以一路送出去一份（审阅 F2）。 */
export type QuestionDrafts = Record<string, { picked: string[]; extra: string }>;

const answered = (draft: { picked: string[]; extra: string }) => draft.picked.length > 0 || draft.extra.trim() !== '';

export function QuestionCard({ ask, queued, active, onSubmit, onCancel, onOpen, onDraft }: {
  ask: QuestionAsk;
  queued: number;
  active: string | null;
  // 交出去的是那一次请求自己的编号对得上的答复；没答的那一道由宿主原样写成「没有回答」。
  onSubmit: (answers: { id: string; selected: string[]; custom?: string }[]) => void;
  onCancel: () => void;
  onOpen: (sessionId: string) => void;
  onDraft: (id: string, drafts: QuestionDrafts) => void;
}) {
  const [drafts, setDrafts] = useState<QuestionDrafts>(
    () => Object.fromEntries(ask.questions.map((question) => [question.id, { picked: [], extra: '' }])),
  );
  useEffect(() => { onDraft(ask.id, drafts); }, [ask.id, drafts, onDraft]);
  const background = ask.sessionId !== active;
  const anyAnswered = ask.questions.some((question) => answered(drafts[question.id] ?? { picked: [], extra: '' }));
  const pick = (id: string, label: string, multiple: boolean) => setDrafts((current) => {
    const draft = current[id] ?? { picked: [], extra: '' };
    const picked = multiple
      ? (draft.picked.includes(label) ? draft.picked.filter((one) => one !== label) : [...draft.picked, label])
      : [label];
    return { ...current, [id]: { ...draft, picked } };
  });
  const write = (id: string, extra: string) => setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? { picked: [], extra: '' }), extra } }));
  const submit = () => {
    if (!anyAnswered) return;
    onSubmit(ask.questions
      .map((question) => {
        const draft = drafts[question.id] ?? { picked: [], extra: '' };
        return { id: question.id, selected: draft.picked, ...(draft.extra.trim() === '' ? {} : { custom: draft.extra.trim() }) };
      })
      .filter((answer) => answered({ picked: answer.selected, extra: answer.custom ?? '' })));
  };
  return <section className="question" aria-label="等一个人回答的问题">
    <div className="question-body">
      <div className="question-head">
        <span className="question-kind">{background ? '另一份会话在等人回答' : '模型在等你回答'}</span>
        {ask.project !== '' && <span className="row-note">项目 {ask.project}</span>}
        {queued > 0 && <span className="row-note">后面还有 {queued} 条在等</span>}
        {background && <button type="button" onClick={() => onOpen(ask.sessionId)}>看这一份会话 {ask.sessionId.slice(0, 8)}</button>}
      </div>
      {ask.questions.map((question, index) => {
        const draft = drafts[question.id] ?? { picked: [], extra: '' };
        return <fieldset className="question-item" key={question.id}>
          <legend>
            {index + 1}. {question.question}
            {question.header === undefined ? '' : <span className="question-tag">{question.header}</span>}
            {question.multiSelect && <span className="question-tag">可多选</span>}
          </legend>
          {question.options.map((option) => <label className="question-option" key={option.label}>
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              name={question.id}
              checked={draft.picked.includes(option.label)}
              onChange={() => pick(question.id, option.label, question.multiSelect)}
            />
            <span>{option.label}</span>
            {option.description === undefined ? null : <span className="question-option-note">{option.description}</span>}
          </label>)}
          <input
            className="question-free"
            type="text"
            placeholder="或者自己写一句"
            value={draft.extra}
            aria-label={`第 ${index + 1} 题的补充回答`}
            onChange={(event) => write(question.id, event.target.value)}
            onKeyDown={(event) => {
              // 输入法拼的那一段里 Enter 属于选词，不在这里提交（方案 5.1、5.4）。
              if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            }}
          />
          {!answered(draft) && <span className="row-note">这道没答，交出去时写成「没有回答」</span>}
        </fieldset>;
      })}
    </div>
    <div className="question-actions">
      <button type="button" data-tone="allow" disabled={!anyAnswered} onClick={submit}>交出答案</button>
      <button type="button" data-tone="deny" onClick={onCancel}>取消这一轮</button>
      <span className="question-note">没有回答时限，这一轮一直等到你答或者取消。</span>
    </div>
  </section>;
}
