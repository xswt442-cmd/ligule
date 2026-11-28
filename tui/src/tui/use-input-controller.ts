import { useApp, useInput, usePaste } from 'ink';
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { insertMention, type Candidate } from './commands.js';
import { editDraft, isTypingRun, moveDraftCaret, type DraftState } from './draft.js';
import { editInExternalEditor, type EditorOutcome } from './editor.js';
import { searchHistory } from './history.js';
import { hit, type InkKey } from './keymap.js';
import type { TranscriptItem } from './transcript.js';

export interface UndoState {
  stack: DraftState[];
  future: DraftState[];
  kind: 'insert' | 'text' | null;
  before: DraftState;
}

export interface SearchState {
  readonly query: string;
  readonly at: number;
}

export interface MentionState {
  readonly paths: readonly string[];
  readonly chosen: number;
  readonly start: number;
  readonly text: string;
  readonly stopped: 'pending' | 'error' | 'budget' | 'unreadable' | 'done' | '';
  readonly failed?: string;
}

interface InputControllerOptions {
  readonly interactive: boolean;
  readonly running: boolean;
  readonly answering: boolean;
  readonly mayPaste: boolean;
  readonly sessionId: string;
  readonly questionId?: string;
  readonly alive: RefObject<boolean>;
  readonly activeSession: RefObject<string>;
  readonly activeQuestion: RefObject<string | undefined>;
  readonly editor?: string;
  readonly draft: DraftState & { readonly undo: RefObject<UndoState>; setText(text: string): void; setCaret(caret: number): void };
  readonly history: {
    readonly entries: readonly string[];
    readonly at: number;
    readonly savedDraft: string;
    readonly search: SearchState | null;
    setAt(at: number): void;
    saveDraft(text: string): void;
    setSearch(search: SearchState | null): void;
  };
  readonly mention: { readonly current: MentionState | null; set(mention: MentionState | null): void; hide(text: string): void };
  readonly completion: { readonly picks: readonly Candidate[]; readonly chosen: number; pick(index: number): void; dismiss(draft: string): void };
  readonly queued: { readonly items: readonly string[]; readonly set: Dispatch<SetStateAction<string[]>> };
  handlePanelInput(input: string, key: InkKey): boolean;
  cancelRound(): void;
  send(text: string): void;
  push(...items: TranscriptItem[]): void;
  t(zh: string, en: string): string;
}

export function useInputController({
  interactive, running, answering, mayPaste, sessionId, questionId, alive, activeSession, activeQuestion, editor,
  draft: { draft, caret, undo, setText, setCaret }, history, mention, completion, queued,
  handlePanelInput, cancelRound, send, push, t,
}: InputControllerOptions): void {
  const app = useApp();
  const { entries, at: historyAt, savedDraft, search, setSearch } = history;
  const { picks, chosen } = completion;

  function replaceDraft(text: string, position = text.length) {
    setText(text);
    setCaret(position);
  }

  useEffect(() => {
    const cell = undo.current;
    const current = { draft, caret };
    const previous = cell.before;
    cell.before = current;
    if (current.draft === previous.draft) { cell.kind = null; return; }
    const run = isTypingRun(previous, current);
    if (run && cell.kind === 'insert') return;
    cell.stack = [...cell.stack.slice(-99), previous];
    cell.kind = run ? 'insert' : 'text';
  }, [draft, caret, undo]);

  useInput((input, key) => {
    if (handlePanelInput(input, key)) return;
    if (hit('editor', input, key)) {
      if (editor === undefined || editor === '') {
        push({ kind: 'error', text: t('请先设置 VISUAL 或 EDITOR 环境变量', 'Set the VISUAL or EDITOR environment variable first') });
        return;
      }
      void (async () => {
        let outcome: EditorOutcome = { code: 'tui_editor_failed', detail: 'external editor failed' };
        await app.suspendTerminal(async () => { outcome = await editInExternalEditor(editor, draft); });
        const result = outcome as EditorOutcome;
        if ('code' in result) {
          push({ kind: 'error', text: t(`外部编辑失败：${result.code}`, `External editor failed: ${result.code}`) });
          return;
        }
        if (!alive.current || activeSession.current !== sessionId || questionId !== undefined && activeQuestion.current !== questionId) return;
        replaceDraft(result.text.replace(/\r\n?/g, '\n'));
      })();
      return;
    }
    if (hit('search-open', input, key) && search === null) {
      setSearch({ query: '', at: 0 });
      return;
    }
    if (search !== null) {
      const found = searchHistory(entries, search.query);
      const cycle = (step: number) => setSearch(found.length === 0 ? search : { ...search, at: (search.at + step + found.length) % found.length });
      if (hit('search-close', input, key)) setSearch(null);
      else if (hit('search-pick', input, key)) {
        const picked = found[search.at];
        if (picked !== undefined) replaceDraft(picked);
        setSearch(null);
      } else if (hit('search-up', input, key) || hit('search-cycle', input, key)) cycle(1);
      else if (hit('search-down', input, key)) cycle(-1);
      else if (hit('search-back', input, key) || hit('search-back-alt', input, key)) {
        setSearch(search.query === '' ? null : { query: search.query.slice(0, -1), at: 0 });
      } else if (input !== '' && !key.ctrl && !key.meta) setSearch({ query: search.query + input, at: 0 });
      return;
    }
    const pathChoices = mention.current;
    if (pathChoices !== null && !answering) {
      if (hit('path-close', input, key)) {
        mention.hide(pathChoices.text);
        mention.set(null);
        return;
      }
      const picking = hit('pick-path', input, key) || hit('pick-path-alt', input, key);
      if (pathChoices.stopped === 'pending' && picking) return;
      if (pathChoices.paths.length > 0 && picking) {
        const picked = pathChoices.paths[Math.min(pathChoices.chosen, pathChoices.paths.length - 1)];
        const merged = insertMention(draft, caret, pathChoices.start, picked);
        replaceDraft(merged.draft, merged.caret);
        mention.hide('');
        mention.set(null);
        return;
      }
      if (pathChoices.paths.length > 0 && (hit('path-up', input, key) || hit('path-down', input, key))) {
        const step = hit('path-up', input, key) ? -1 : 1;
        mention.set({ ...pathChoices, chosen: (pathChoices.chosen + step + pathChoices.paths.length) % pathChoices.paths.length });
        return;
      }
    }
    if (picks.length > 0) {
      if (hit('complete', input, key)) {
        const picked = picks[chosen];
        replaceDraft(`/${picked.name}${picked.hint === '' ? '' : ' '}`);
        completion.pick(0);
        return;
      }
      if (hit('complete-up', input, key) || hit('complete-down', input, key)) {
        completion.pick(hit('complete-up', input, key) ? (chosen === 0 ? picks.length - 1 : chosen - 1) : (chosen + 1) % picks.length);
        return;
      }
      if (hit('complete-close', input, key)) {
        completion.dismiss(draft);
        return;
      }
    }
    if (hit('interrupt', input, key)) {
      if (running) cancelRound();
      return;
    }
    const up = hit('history-up', input, key) || hit('history-up-shift', input, key);
    const down = hit('history-down', input, key) || hit('history-down-shift', input, key);
    if (up || down) {
      if (draft.includes('\n')) {
        setCaret(moveDraftCaret(draft, caret, up ? 'up' : 'down'));
        return;
      }
      if (entries.length === 0) return;
      if (historyAt === -1 && up) history.saveDraft(draft);
      const next = up ? Math.min(historyAt + 1, entries.length - 1) : Math.max(historyAt - 1, -1);
      history.setAt(next);
      replaceDraft(next < 0 ? savedDraft : entries[next]);
      return;
    }
    if (hit('undo-draft', input, key) || hit('redo-draft', input, key)) {
      const cell = undo.current;
      const back = hit('undo-draft', input, key);
      const target = (back ? cell.stack : cell.future).at(-1);
      if (target === undefined) return;
      const current = { draft: cell.before.draft, caret: cell.before.caret };
      if (back) {
        cell.stack = cell.stack.slice(0, -1);
        cell.future = [...cell.future.slice(-99), current];
      } else {
        cell.future = cell.future.slice(0, -1);
        cell.stack = [...cell.stack.slice(-99), current];
      }
      cell.kind = null;
      cell.before = target;
      replaceDraft(target.draft, target.caret);
      return;
    }
    if (!answering && (hit('queue-recall', input, key) || hit('queue-recall-alt', input, key)) && draft === '' && queued.items.length > 0) {
      queued.set(current => current.slice(0, -1));
      replaceDraft(queued.items[queued.items.length - 1]);
      return;
    }
    if (hit('newline', input, key) || hit('newline-alt', input, key)) {
      replaceDraft(draft.slice(0, caret) + '\n' + draft.slice(caret), caret + 1);
      return;
    }
    if (hit('send', input, key)) {
      if (draft.trim() !== '' || answering) send(draft);
      return;
    }
    const edited = editDraft(draft, caret, input.replace(/\r\n?/g, '\n'), key);
    replaceDraft(edited.draft, edited.caret);
  }, { isActive: interactive });

  usePaste((text) => {
    if (!mayPaste) return;
    if (search !== null) {
      setSearch({ query: search.query + text.replace(/[\r\n\t]+/gu, ' '), at: 0 });
      return;
    }
    const inserted = editDraft(draft, caret, text.replace(/\r\n?/g, '\n'), {});
    replaceDraft(inserted.draft, inserted.caret);
  }, { isActive: interactive });
}
