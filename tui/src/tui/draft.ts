import stringWidth from 'string-width';
import type { InkKey } from './keymap.js';

export interface DraftState {
  readonly draft: string;
  readonly caret: number;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeBoundaries(text: string): number[] {
  return [...GRAPHEMES.segment(text)].map((part) => part.index);
}

export function editDraft(draft: string, caret: number, input: string, key: InkKey): DraftState {
  const boundaries = graphemeBoundaries(draft);
  const previous = boundaries.filter((index) => index < caret).at(-1) ?? 0;
  const next = boundaries.find((index) => index > caret) ?? draft.length;
  if (key.leftArrow) return { draft, caret: previous };
  if (key.rightArrow) return { draft, caret: next };
  if (key.home || (key.ctrl && input === 'a')) return { draft, caret: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { draft, caret: draft.length };
  if (key.ctrl && input === 'u') return { draft: '', caret: 0 };
  if (key.ctrl && input === 'w') {
    const head = draft.slice(0, caret).replace(/\s+$/, '').replace(/[\p{L}\p{M}\p{N}_.\-/]+$/u, '');
    return { draft: head + draft.slice(caret), caret: head.length };
  }
  if (key.backspace) {
    if (caret === 0) return { draft, caret };
    return { draft: draft.slice(0, previous) + draft.slice(caret), caret: previous };
  }
  if (key.delete) {
    if (caret >= draft.length) return { draft, caret };
    return { draft: draft.slice(0, caret) + draft.slice(next), caret };
  }
  if (input === '' || key.ctrl || key.meta) return { draft, caret };
  const inserted = draft.slice(0, caret) + input + draft.slice(caret);
  const insertedEnd = caret + input.length;
  const insertedCaret = graphemeBoundaries(inserted).find((index) => index >= insertedEnd) ?? inserted.length;
  return { draft: inserted, caret: insertedCaret };
}

export function isTypingRun(before: DraftState, after: DraftState): boolean {
  if (before.caret !== before.draft.length || after.caret !== after.draft.length) return false;
  if (!after.draft.startsWith(before.draft)) return false;
  const added = after.draft.slice(before.draft.length);
  return [...GRAPHEMES.segment(added)].length === 1 && !/\s/u.test(added);
}

export function moveDraftCaret(draft: string, caret: number, direction: 'up' | 'down'): number {
  const lineStart = caret === 0 ? 0 : draft.lastIndexOf('\n', caret - 1) + 1;
  const lineEnd = draft.indexOf('\n', lineStart);
  const currentEnd = lineEnd < 0 ? draft.length : lineEnd;
  const currentLine = draft.slice(lineStart, currentEnd);
  const currentColumn = stringWidth(currentLine.slice(0, caret - lineStart));
  const targetStart = direction === 'up'
    ? lineStart > 0 ? (lineStart > 1 ? draft.lastIndexOf('\n', lineStart - 2) + 1 : 0) : -1
    : currentEnd < draft.length ? currentEnd + 1 : -1;
  if (targetStart < 0) return caret;
  const targetEndIndex = draft.indexOf('\n', targetStart);
  const targetEnd = targetEndIndex < 0 ? draft.length : targetEndIndex;
  let targetCaret = targetStart;
  let targetColumn = 0;
  for (const part of GRAPHEMES.segment(draft.slice(targetStart, targetEnd))) {
    const width = stringWidth(part.segment);
    if (targetColumn + width > currentColumn) break;
    targetColumn += width;
    targetCaret += part.segment.length;
  }
  return targetCaret;
}
