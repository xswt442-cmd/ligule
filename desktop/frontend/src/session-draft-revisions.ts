export type SessionDraftRevision = { readonly text: string; readonly revision: number };
export type SessionDraftRevisions = ReadonlyMap<string, SessionDraftRevision>;

export function sessionDraftRevisionFor(revisions: SessionDraftRevisions, key: string): number {
  return revisions.get(key)?.revision ?? 0;
}

export function updateSessionDraftRevision(revisions: SessionDraftRevisions, key: string, text: string): SessionDraftRevisions {
  const previous = revisions.get(key);
  if (previous?.text === text) return revisions;
  const next = new Map(revisions);
  next.set(key, { text, revision: (previous?.revision ?? 0) + 1 });
  return next;
}

export function clearSessionDraftIfCurrent(
  revisions: SessionDraftRevisions,
  key: string,
  submittedRevision: number,
): SessionDraftRevisions {
  const current = revisions.get(key);
  if (current === undefined || current.revision !== submittedRevision || current.text === '') return revisions;
  const next = new Map(revisions);
  next.set(key, { text: '', revision: current.revision + 1 });
  return next;
}
