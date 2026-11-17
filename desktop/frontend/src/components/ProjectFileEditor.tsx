import { useEffect, useRef, useState } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorView as CodeMirrorView } from '@codemirror/view';
import { useText } from '../locale';

type EditorActions = { readonly find: () => void; readonly undo: () => void; readonly redo: () => void };

function lowerExtension(path: string): string {
  return path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
}

async function languageSupport(path: string): Promise<Extension | undefined> {
  const extension = lowerExtension(path);
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(extension)) {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ typescript: ['ts', 'tsx', 'mts', 'cts'].includes(extension), jsx: ['jsx', 'tsx'].includes(extension) });
  }
  if (extension === 'json') return (await import('@codemirror/lang-json')).json();
  if (extension === 'md' || extension === 'markdown') return (await import('@codemirror/lang-markdown')).markdown();
  if (extension === 'html' || extension === 'htm') return (await import('@codemirror/lang-html')).html();
  if (extension === 'css') return (await import('@codemirror/lang-css')).css();
  return undefined;
}

export function ProjectFileEditor({ path, initialText, lineSeparator, readOnly, onChange }: {
  path: string;
  initialText: string;
  lineSeparator?: string;
  readOnly: boolean;
  onChange: (text: string) => void;
}) {
  const t = useText();
  const mount = useRef<HTMLDivElement | null>(null);
  const view = useRef<CodeMirrorView | null>(null);
  const initial = useRef(initialText);
  const onChangeRef = useRef(onChange);
  const updateReadOnly = useRef<((value: boolean) => void) | null>(null);
  const actions = useRef<EditorActions | null>(null);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    let active = true;
    let editor: CodeMirrorView | undefined;
    void (async () => {
      const [stateModule, viewModule, commandModule, searchModule, languageModule, language] = await Promise.all([
        import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/commands'),
        import('@codemirror/search'), import('@codemirror/language'), languageSupport(path),
      ]);
      if (!active || mount.current === null) return;
      const editable = new stateModule.Compartment();
      const readOnlyState = new stateModule.Compartment();
      const extensions: Extension[] = [
        viewModule.lineNumbers(),
        viewModule.highlightActiveLine(),
        viewModule.drawSelection(),
        commandModule.history(),
        searchModule.search(),
        stateModule.EditorState.transactionFilter.of(transaction => {
          if (!transaction.docChanged) return transaction;
          const text = transaction.newDoc.toString();
          if (!text.includes('\u0000') && new TextEncoder().encode(text).byteLength <= 256 * 1024) return transaction;
          if (active) setError('project_file_text_invalid');
          return [];
        }),
        viewModule.keymap.of([
          ...commandModule.defaultKeymap,
          ...commandModule.historyKeymap,
          ...searchModule.searchKeymap,
        ]),
        stateModule.EditorState.lineSeparator.of(lineSeparator ?? '\n'),
        languageModule.syntaxHighlighting(languageModule.defaultHighlightStyle, { fallback: true }),
        viewModule.EditorView.lineWrapping,
        editable.of(viewModule.EditorView.editable.of(!readOnly)),
        readOnlyState.of(stateModule.EditorState.readOnly.of(readOnly)),
        viewModule.EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.sliceDoc());
          setCanUndo(commandModule.undoDepth(update.state) > 0);
          setCanRedo(commandModule.redoDepth(update.state) > 0);
        }),
      ];
      if (language !== undefined) extensions.push(language);
      editor = new viewModule.EditorView({
        state: stateModule.EditorState.create({ doc: initial.current, extensions }),
        parent: mount.current,
      });
      view.current = editor;
      updateReadOnly.current = value => editor?.dispatch({ effects: [
        editable.reconfigure(viewModule.EditorView.editable.of(!value)),
        readOnlyState.reconfigure(stateModule.EditorState.readOnly.of(value)),
      ] });
      actions.current = {
        find: () => { if (editor !== undefined) searchModule.openSearchPanel(editor); },
        undo: () => { if (editor !== undefined) commandModule.undo(editor); },
        redo: () => { if (editor !== undefined) commandModule.redo(editor); },
      };
      setReady(true);
      editor.focus();
    })().catch(() => {
      if (active) setError('project_file_editor_unavailable');
    });
    return () => {
      active = false;
      editor?.destroy();
      view.current = null;
      actions.current = null;
      updateReadOnly.current = null;
    };
  }, [path, lineSeparator]);

  useEffect(() => { updateReadOnly.current?.(readOnly); }, [readOnly]);

  return <section className="project-code-editor" aria-label={t('文本编辑器', 'Text editor')}>
    <div className="project-code-toolbar">
      <button type="button" disabled={!ready || readOnly} onClick={() => actions.current?.find()}>{t('在文件中查找', 'Find in file')}</button>
      <button type="button" disabled={!ready || readOnly || !canUndo} onClick={() => actions.current?.undo()}>{t('撤销编辑', 'Undo edit')}</button>
      <button type="button" disabled={!ready || readOnly || !canRedo} onClick={() => actions.current?.redo()}>{t('重做编辑', 'Redo edit')}</button>
    </div>
    <div className="project-code-mount" ref={mount} data-path={path} />
    {error !== null && <p className="stub" role="alert">{t('无法加载编辑器', 'Could not load the editor')} · {error}</p>}
  </section>;
}
