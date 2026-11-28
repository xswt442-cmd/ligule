import { useCallback, useRef, useState, type RefObject } from 'react';
import { code, type Client } from './protocol';
import { projectRecord, type Record_, type Row } from './rows';
import { SessionStreamBuffer } from './session-stream';
import { olderRecoveryPage, SessionWindow } from './session-window';

export const RENDER_WINDOW = 400;

interface SessionPage {
  readonly events: Record_[];
  readonly hasMore: boolean;
  readonly header: { readonly projectRoot?: string } | null;
  readonly label: { readonly name: string; readonly archived: boolean };
  readonly writerActive?: boolean;
}

interface ReadScope {
  readonly id: string;
  readonly root: string;
  readonly observing: boolean;
}

export function useHostSession(client: Client, active: RefObject<string | null>) {
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState({ text: '', reasoning: '' });
  const streams = useRef<SessionStreamBuffer | null>(null);
  if (streams.current === null) streams.current = new SessionStreamBuffer();
  const liveBySession = streams.current;
  const windowRef = useRef<SessionWindow<Record_> | null>(null);
  if (windowRef.current === null) windowRef.current = new SessionWindow<Record_>();
  const sessionWindow = windowRef.current;
  const pendingRecords = useRef<Record_[] | null>(null);
  const openRequest = useRef(0);
  const dispatchAt = useRef(new Map<string, number>());

  const appendRecord = useCallback((record: Record_) => {
    if (record?.kind === 'assistant') {
      for (const call of record.toolCalls ?? []) dispatchAt.current.set(call.id, Date.now());
    }
    const started = record?.kind === 'tool' && record.callId !== undefined ? dispatchAt.current.get(record.callId) : undefined;
    if (started !== undefined && record?.callId !== undefined) dispatchAt.current.delete(record.callId);
    const added = projectRecord(record, started === undefined ? {} : { startedAt: started });
    if (added.length > 0) setRows(current => [...current, ...added]);
  }, []);
  const receiveDelta = useCallback((owner: string, kind: string, text: string) => {
    const held = liveBySession.append(owner, kind, text);
    if (held !== null && active.current === owner) setLive(held);
  }, [active, liveBySession]);
  const settleStream = useCallback((owner: string, kind: string) => {
    const held = liveBySession.settle(owner, kind);
    if (active.current === owner) setLive(held);
  }, [active, liveBySession]);
  const receiveRecord = useCallback((owner: string, record: Record_) => {
    settleStream(owner, record?.kind ?? '');
    if (active.current !== owner) return;
    if (pendingRecords.current !== null) pendingRecords.current.push(record);
    else appendRecord(record);
  }, [active, appendRecord, settleStream]);
  const clearStream = useCallback((owner: string) => {
    liveBySession.clear(owner);
    if (active.current === owner) setLive({ text: '', reasoning: '' });
  }, [active, liveBySession]);

  const beginOpen = useCallback((id: string) => {
    const request = ++openRequest.current;
    pendingRecords.current = [];
    sessionWindow.reset(0);
    setLive(liveBySession.read(id));
    dispatchAt.current.clear();
    return request;
  }, [liveBySession, sessionWindow]);
  const invalidateOpen = useCallback(() => {
    pendingRecords.current = null;
    return ++openRequest.current;
  }, []);
  const abandonOpen = useCallback((request: number) => {
    if (openRequest.current === request) pendingRecords.current = null;
  }, []);

  const readPage = useCallback(async ({ id, root, observing }: ReadScope, before?: number, timeout = 15_000): Promise<SessionPage> => {
    const params = { sessionId: id, limit: RENDER_WINDOW, fullResults: true, ...(before === undefined ? {} : { before }) };
    return observing
      ? await client.call('session.observe', { ...params, projectRoot: root }, timeout) as SessionPage
      : await client.call('session.read', params, timeout) as SessionPage;
  }, [client]);
  const readInitial = useCallback(async (id: string, root: string, request: number) => {
    try {
      await client.call('session.open', root === '' ? { sessionId: id } : { sessionId: id, projectRoot: root }, 60_000);
      if (openRequest.current !== request) return null;
      return { observing: false, page: await readPage({ id, root, observing: false }, undefined, 60_000) };
    } catch (error) {
      if (openRequest.current !== request) return null;
      if (code(error) !== 'session_locked') throw error;
      return { observing: true, page: await readPage({ id, root, observing: true }, undefined, 60_000) };
    }
  }, [client, readPage]);

  const readThrough = useCallback(async (scope: ReadScope, initial: SessionPage, sequence: number | undefined, request: number) => {
    let { events, hasMore } = initial;
    while (sequence !== undefined && sequence < Number(events[0]?.seq ?? 0) && hasMore) {
      const older = await readPage(scope, Number(events[0]?.seq));
      if (openRequest.current !== request) return null;
      if (older.events.length === 0) { hasMore = false; break; }
      events = [...older.events, ...events];
      hasMore = older.hasMore;
    }
    return openRequest.current === request ? { events, hasMore } : null;
  }, [readPage]);

  const finishOpen = useCallback(async (scope: ReadScope, request: number, latestSequence: number) => {
    if (openRequest.current !== request) return null;
    sessionWindow.reset(latestSequence);
    const buffered = pendingRecords.current;
    pendingRecords.current = null;
    if (buffered === null) return 0;
    let missing = 0;
    for (const record of buffered) {
      const decision = sessionWindow.incoming(record);
      if (decision.apply) appendRecord(record);
      else if (decision.reason === 'gap') { missing = decision.missingFrom; break; }
    }
    if (missing === 0) return 0;
    const collected = new Map<number, Record_>();
    const remember = (events: Record_[]) => {
      for (const event of events) {
        const sequence = Number(event.seq);
        if (Number.isSafeInteger(sequence)) collected.set(sequence, event);
      }
    };
    let oldest = await readPage(scope);
    if (openRequest.current !== request) return null;
    remember(oldest.events);
    for (let reads = 0; reads < 8; reads += 1) {
      const older = olderRecoveryPage(oldest, missing);
      if (older === null) break;
      oldest = await readPage(scope, older.before);
      if (openRequest.current !== request) return null;
      remember(oldest.events);
    }
    const ordered = [...collected.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
    for (const record of sessionWindow.adopt(ordered)) appendRecord(record);
    const head = Number(buffered.at(-1)?.seq);
    return Number.isSafeInteger(head) ? Math.max(0, head - sessionWindow.loadedThrough) : 0;
  }, [appendRecord, readPage, sessionWindow]);

  return { rows, setRows, live, setLive, openRequest, receiveDelta, receiveRecord, settleStream, clearStream,
    beginOpen, invalidateOpen, abandonOpen, readPage, readInitial, readThrough, finishOpen };
}
