import { useCallback, useEffect, useRef, useState } from 'react';
import { blockedSessions, type QuitInput, type QuitRow } from './quit';
import type { Transport } from './protocol';

interface QuitOptions {
  readonly transport: Pick<Transport, 'quit' | 'onQuit'>;
  readonly input: QuitInput;
  persistInputs(): Promise<unknown>;
  cancel(sessionId: string): Promise<unknown>;
  editReasons(): string[];
  reportFailure(error: unknown): void;
}

export function useQuitGate({ transport, input, persistInputs, cancel, editReasons, reportFailure }: QuitOptions) {
  const [rows, setRows] = useState<QuitRow[]>([]);
  const [hold, setHold] = useState<string[] | null>(null);
  const [closing, setClosing] = useState(false);
  const quitting = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const quit = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    setClosing(true);
    setRows([]);
    try {
      await persistInputs();
      for (const sessionId of latest.current.running) await cancel(sessionId);
      await transport.quit?.();
    } catch (error) {
      reportFailure(error);
      quitting.current = false;
      setClosing(false);
    }
  }, [cancel, persistInputs, reportFailure, transport]);
  const approve = useRef<() => void>(() => undefined);
  approve.current = () => {
    const blocked = blockedSessions(latest.current);
    if (blocked.length === 0) void quit();
    else setRows(blocked);
  };
  const currentEdits = useRef(editReasons);
  currentEdits.current = editReasons;
  useEffect(() => {
    let active = true;
    const stop = transport.onQuit?.(() => {
      if (!active) return;
      const reasons = currentEdits.current();
      if (reasons.length > 0) setHold(reasons);
      else approve.current();
    });
    return () => { active = false; stop?.(); };
  }, [transport]);
  return { rows, setRows, hold, setHold, closing, quitting, quit, approve };
}
