import { useCallback, useRef, useState, type RefObject } from 'react';
import type { Locale, SessionEvent } from '@ligule/core/tui.js';
import { maxTranscriptSequence, transcriptRows, type TranscriptItem } from './transcript.js';

const emptyLive = () => ({ text: '', reasoning: '' });

export function useTranscriptSession(locale: Locale, alive: RefObject<boolean>) {
  const [rows, setRows] = useState<TranscriptItem[]>([]);
  const [live, setLive] = useState(emptyLive);
  const lastTranscriptSequence = useRef(-1);
  const terminalReceived = useRef(false);

  const push = useCallback((...added: TranscriptItem[]) => {
    if (!alive.current) return;
    for (const row of added) {
      if (Number.isSafeInteger(row.seq)) lastTranscriptSequence.current = Math.max(lastTranscriptSequence.current, row.seq!);
    }
    setRows(current => [...current, ...added]);
  }, [alive]);

  const clearLive = useCallback(() => setLive(emptyLive()), []);
  const beginTurn = useCallback(() => {
    terminalReceived.current = false;
    clearLive();
  }, [clearLive]);

  const appendDelta = useCallback((type: 'text' | 'reasoning', text: string) => {
    setLive(current => ({ ...current, [type]: current[type] + text }));
  }, []);

  const record = useCallback((event: SessionEvent) => {
    if (event.kind === 'turn') terminalReceived.current = true;
    if (event.kind === 'assistant') setLive(current => ({ ...current, text: '' }));
    if (event.kind === 'reasoning') setLive(current => ({ ...current, reasoning: '' }));
    push(...transcriptRows([event], locale));
  }, [locale, push]);

  const restore = useCallback((events: readonly SessionEvent[]) => {
    lastTranscriptSequence.current = maxTranscriptSequence(events);
    setRows(transcriptRows(events, locale));
    clearLive();
  }, [clearLive, locale]);

  const appendObserved = useCallback((events: readonly SessionEvent[]) => {
    const committedThrough = lastTranscriptSequence.current;
    const newestObserved = maxTranscriptSequence(events);
    const unseen = transcriptRows(events, locale, committedThrough);
    lastTranscriptSequence.current = Math.max(committedThrough, newestObserved);
    push(...unseen);
    if (unseen.some(item => item.kind === 'reasoning')) {
      setLive(current => ({ ...current, reasoning: '' }));
    }
    return newestObserved >= committedThrough;
  }, [locale, push]);

  return { rows, live, lastTranscriptSequence, terminalReceived, push, clearLive, beginTurn, appendDelta, record, restore, appendObserved, setLive };
}
