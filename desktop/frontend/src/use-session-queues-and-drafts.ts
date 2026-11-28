import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { mergeQueueIntoDraft, updateSettings, type Settings } from './settings';
import { clearSessionDraftIfCurrent, sessionDraftRevisionFor, updateSessionDraftRevision, type SessionDraftRevisions } from './session-draft-revisions';
import type { Client } from './protocol';

type Owner = { root: string; id: string };
type PendingInput = Owner & { draft?: string; items?: string[] };
type Queue = { items: string[]; paused: boolean };
type DraftUpdate = string | ((current: string) => string);
const inputKey = ({ root, id }: Owner) => JSON.stringify([root, id]);

function put<Value extends { length: number }>(table: Record<string, Record<string, Value>>, { root, id }: Owner, value: Value) {
  const row = { ...(table[root] ?? {}) };
  if (value.length === 0) delete row[id];
  else row[id] = value;
  const next = { ...table };
  if (Object.keys(row).length === 0) delete next[root];
  else next[root] = row;
  return next;
}

interface InputOptions {
  readonly client: Client;
  readonly projectRoot: string;
  readonly sessionId: string | null;
  readonly readOnlySessionId: string | null;
  readonly settings: Settings;
  readonly settingsReady: boolean;
  readonly setSettings: Dispatch<SetStateAction<Settings>>;
  readonly sessions: RefObject<Map<string, { root: string }>>;
  readonly active: RefObject<string | null>;
}

export function useSessionQueuesAndDrafts({ client, projectRoot, sessionId, readOnlySessionId,
  settings, settingsReady, setSettings, sessions, active }: InputOptions) {
  const [draft, setDraftState] = useState('');
  const [inputOwner, setInputOwner] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, Queue>>({});
  const queue = readOnlySessionId === sessionId ? { items: [], paused: false } : queues[sessionId ?? ''] ?? { items: [], paused: false };
  const patchQueue = useCallback((id: string, next: (current: Queue) => Queue) => {
    setQueues(current => ({ ...current, [id]: next(current[id] ?? { items: [], paused: false }) }));
  }, []);
  const unsaved = useRef(new Map<string, PendingInput>());
  const revisions = useRef<SessionDraftRevisions>(new Map());
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const currentOwner = useRef(inputOwner);
  currentOwner.current = inputOwner;
  const ownerId = inputOwner ?? sessionId ?? '$new';
  const draftOwner = useRef<Owner>({ root: projectRoot, id: ownerId });
  draftOwner.current = { root: projectRoot || sessions.current.get(ownerId)?.root || '', id: ownerId };
  const saveWarned = useRef(false);

  const saveBackgroundDraft = useCallback((text: string, owner: Owner) => {
    const key = inputKey(owner);
    revisions.current = updateSessionDraftRevision(revisions.current, key, text);
    unsaved.current.set(key, { ...unsaved.current.get(key), ...owner, draft: text });
  }, []);
  const setDraft = useCallback((update: DraftUpdate, owner: Owner | null = draftOwner.current) => {
    const previous = currentDraft.current;
    const next = typeof update === 'function' ? update(previous) : update;
    if (next !== previous && owner !== null) saveBackgroundDraft(next, owner);
    currentDraft.current = next;
    setDraftState(next);
  }, [saveBackgroundDraft]);

  const restoreInputs = useCallback((stored: Settings, owner: Owner, observing: boolean, reclaimQueue: boolean) => {
    const pending = unsaved.current.get(inputKey(owner));
    const restoredDraft = pending?.draft ?? stored.drafts[owner.root]?.[owner.id] ?? '';
    const restoredItems = pending?.items ?? stored.queued[owner.root]?.[owner.id] ?? [];
    if (observing) {
      setDraft('', null);
    } else if (reclaimQueue && restoredItems.length > 0) {
      setDraft(mergeQueueIntoDraft(restoredDraft, restoredItems), owner);
      patchQueue(owner.id, () => ({ items: [], paused: false }));
    } else {
      setDraft(restoredDraft, owner);
      patchQueue(owner.id, () => ({ items: restoredItems, paused: restoredItems.length > 0 }));
    }
    setInputOwner(observing ? null : owner.id);
  }, [patchQueue, setDraft]);

  const pendingDraft = useCallback((owner: Owner) => unsaved.current.get(inputKey(owner))?.draft, []);
  const forgetPending = useCallback((owner: Owner) => { unsaved.current.delete(inputKey(owner)); }, []);
  const localDraft = useCallback((owner: Owner, sameRoot: (root: string, actual: string) => boolean) => {
    const entry = [...unsaved.current.entries()].find(([, value]) => value.id === owner.id && sameRoot(value.root, owner.root));
    return revisions.current.get(entry?.[0] ?? inputKey(owner))?.text ?? entry?.[1].draft;
  }, []);

  const captureSubmission = useCallback((owner: Owner, text: string) => {
    const key = inputKey(owner);
    if (revisions.current.get(key)?.text !== text) saveBackgroundDraft(text, owner);
    return sessionDraftRevisionFor(revisions.current, key);
  }, [saveBackgroundDraft]);
  const finishSubmission = useCallback((owner: Owner, revision: number, text: string): boolean => {
    const key = inputKey(owner);
    const previous = revisions.current;
    const next = clearSessionDraftIfCurrent(previous, key, revision);
    if (next === previous) return false;
    revisions.current = next;
    unsaved.current.set(key, { ...unsaved.current.get(key), ...owner, draft: '' });
    setSettings(current => ({ ...current, drafts: put(current.drafts, owner, '') }));
    if (active.current !== owner.id || currentOwner.current !== owner.id || currentDraft.current !== text) return false;
    setDraft('');
    return true;
  }, [active, setDraft, setSettings]);

  const persistInputs = useCallback(async () => {
    if (!settingsReady) throw Object.assign(new Error('prefs_reload_required'), { code: 'prefs_reload_required' });
    const remember = (owner: Owner, value: { draft?: string; items?: string[] }) => {
      const key = inputKey(owner);
      if (value.draft !== undefined && revisions.current.get(key)?.text !== value.draft) return;
      unsaved.current.set(key, { ...unsaved.current.get(key), ...owner, ...value });
    };
    if (inputOwner === sessionId) remember({ root: projectRoot, id: sessionId ?? '$new' }, { draft });
    for (const [id, value] of Object.entries(queues)) {
      const root = sessions.current.get(id)?.root;
      if (root !== undefined) remember({ root, id }, { items: value.items });
    }
    const pending = new Map(unsaved.current);
    await updateSettings(client, stored => {
      let drafts = stored.drafts;
      let queued = stored.queued;
      for (const input of pending.values()) {
        if (input.draft !== undefined) drafts = put(drafts, input, input.draft);
        if (input.items !== undefined) queued = put(queued, input, input.items);
      }
      return { ...stored, ...settings, drafts, queued };
    });
    for (const [key, input] of pending) {
      if (unsaved.current.get(key) === input) unsaved.current.delete(key);
    }
  }, [client, draft, inputOwner, projectRoot, queues, sessionId, sessions, settings, settingsReady]);

  return { draft, setDraft, inputOwner, setInputOwner, queue, queues, patchQueue, saveWarned, saveBackgroundDraft,
    restoreInputs, pendingDraft, forgetPending, localDraft, captureSubmission, finishSubmission, persistInputs };
}
