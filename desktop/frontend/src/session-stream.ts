export type SessionStream = { text: string; reasoning: string };

const EMPTY_STREAM: SessionStream = { text: '', reasoning: '' };

/** Keeps partial assistant output separate until its owning session records it. */
export class SessionStreamBuffer {
  private readonly sessions = new Map<string, SessionStream>();

  append(sessionId: string, kind: string, text: string): SessionStream | null {
    if (kind !== 'text' && kind !== 'reasoning') return null;
    const stream = this.sessions.get(sessionId) ?? { ...EMPTY_STREAM };
    stream[kind] += text;
    this.sessions.set(sessionId, stream);
    return { ...stream };
  }

  settle(sessionId: string, recordKind: string): SessionStream {
    const stream = this.sessions.get(sessionId) ?? { ...EMPTY_STREAM };
    if (recordKind === 'assistant') stream.text = '';
    else if (recordKind === 'reasoning') stream.reasoning = '';

    if (stream.text === '' && stream.reasoning === '') this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, stream);
    return { ...stream };
  }

  read(sessionId: string): SessionStream {
    return { ...(this.sessions.get(sessionId) ?? EMPTY_STREAM) };
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
