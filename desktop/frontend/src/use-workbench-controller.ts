import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { holdReasons, report, type EditGate } from './edit-gate';
import { code, type Client } from './protocol';
import { saveWorkbenchSettings, type Settings } from './settings';
import { updateWorkbenchFileDraft, workbenchStateFrom, type WorkbenchFileDraft, type WorkbenchState } from './workbench';

export function useWorkbenchController(
  client: Client, initial: WorkbenchState, preferencesReady: RefObject<Promise<void>>,
  setSettings: Dispatch<SetStateAction<Settings>>, reportSaveFailure: (error: unknown) => void,
) {
  const [gate, setGate] = useState<EditGate>({});
  const [hold, setHold] = useState<{ reasons: string[]; go: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasons = useRef<string[]>([]);
  reasons.current = holdReasons(gate);
  const reportDock = useCallback((reason: string) => setGate(now => report(now, 'dock', reason)), []);
  const leaveDock = useCallback((go: () => void) => {
    if (reasons.current.length === 0) go();
    else setHold({ reasons: reasons.current, go });
  }, []);

  const workbench = useRef(initial);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stopTimer, [stopTimer]);

  const save = useCallback((value: WorkbenchState, revision: number) => {
    void preferencesReady.current.then(() => saveWorkbenchSettings(client, value)).then(() => {
      if (pending.current === revision) pending.current = null;
    }).catch(reportSaveFailure);
  }, [client, preferencesReady, reportSaveFailure]);
  const replace = useCallback((value: WorkbenchState) => {
    workbench.current = value;
    const revision = ++generation.current;
    pending.current = revision;
    setSettings(current => ({ ...current, workbench: value }));
    return revision;
  }, [setSettings]);

  const applyWorkbenchState = useCallback((value: WorkbenchState) => {
    stopTimer();
    const next = workbenchStateFrom(value);
    save(next, replace(next));
  }, [replace, save, stopTimer]);

  const updateProjectFileDraft = useCallback((key: string, draft: WorkbenchFileDraft | undefined) => {
    try {
      const next = updateWorkbenchFileDraft(workbench.current, key, draft);
      const revision = replace(next);
      stopTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (pending.current === revision) save(workbench.current, revision);
      }, 250);
      return true;
    } catch (error) {
      setError(code(error));
      return false;
    }
  }, [replace, save, stopTimer]);

  const adoptWorkbench = useCallback((saved: WorkbenchState) => {
    if (pending.current === null) workbench.current = saved;
    return workbench.current;
  }, []);

  return { workbench, reasons, hold, setHold, error, setError, reportDock, leaveDock, applyWorkbenchState, updateProjectFileDraft, adoptWorkbench };
}
