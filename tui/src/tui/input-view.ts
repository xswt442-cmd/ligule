import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { displayWidth } from './commands.js';
import { TUI_COLORS } from './ui-style.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
interface DraftLine { readonly text: string; readonly start: number; readonly end: number }

export function draftViewport(draft: string, caret: number, columns: number, height: number): {
  readonly lines: readonly DraftLine[]; readonly offset: number; readonly cursor: number; readonly total: number;
} {
  const all: DraftLine[] = [];
  let start = 0;
  let text = '';
  let width = 0;
  for (const part of graphemes.segment(draft)) {
    if (part.segment === '\n') {
      all.push({ text, start, end: part.index });
      text = ''; width = 0; start = part.index + 1;
      continue;
    }
    const size = displayWidth(part.segment);
    if (text !== '' && width + size > Math.max(1, columns)) {
      all.push({ text, start, end: part.index });
      text = ''; width = 0; start = part.index;
    }
    text += part.segment;
    width += size;
  }
  all.push({ text, start, end: draft.length });
  const cursor = Math.max(0, all.findLastIndex(line => line.start <= caret));
  const rows = Math.max(1, height);
  const offset = Math.max(0, Math.min(cursor - rows + 1, all.length - rows));
  return { lines: all.slice(offset, offset + rows), offset, cursor, total: all.length };
}

export function DraftInput({ draft, caret, columns, height, placeholder, focused = true }: {
  readonly draft: string; readonly caret: number; readonly columns: number; readonly height: number;
  readonly placeholder: string; readonly focused?: boolean;
}): ReactElement {
  // Keep one display column available for an end-of-line cursor.
  const viewport = draftViewport(draft, caret, Math.max(1, columns - 5), height);
  return h(Box, {
    width: columns, flexDirection: 'column', paddingX: 1,
    borderStyle: 'single', borderTop: true, borderBottom: true, borderLeft: false, borderRight: false,
    borderColor: focused ? TUI_COLORS.accent : TUI_COLORS.muted,
  }, draft === ''
    ? h(Text, { wrap: 'truncate-end' }, h(Text, { color: TUI_COLORS.accent }, '› '), h(Text, { color: TUI_COLORS.muted }, placeholder))
    : viewport.lines.map((line, index) => {
      const selected = viewport.offset + index === viewport.cursor;
      const local = caret - line.start;
      const character = [...graphemes.segment(line.text.slice(local))][0]?.segment ?? ' ';
      const prefix = index === 0 ? viewport.offset > 0 ? '… ' : '› ' : '  ';
      return h(Text, { key: line.start, wrap: 'truncate-end' },
        h(Text, { color: TUI_COLORS.accent }, prefix),
        selected && focused
          ? h(Text, null, line.text.slice(0, local), h(Text, { inverse: true }, character), line.text.slice(local + (local === line.text.length ? 0 : character.length)))
          : line.text);
    }));
}
