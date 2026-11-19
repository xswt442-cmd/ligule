export type ChangeRecord = {
  readonly seq: number;
  readonly path: string;
  readonly operation: string;
  readonly outcome: string;
  readonly source: 'desktop' | 'agent';
  readonly tool?: string;
  readonly runId?: string;
  readonly beforeVersion?: string;
  readonly afterVersion?: string;
};

export type CheckRecord = {
  readonly seq: number;
  readonly runId?: string;
  readonly name: string;
  readonly commandStatus: string;
  readonly reportStatus: string;
  readonly scopeStatus: string;
  readonly scope: readonly string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') || /^[a-z]:/iu.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('//') && normalized.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function projectChangesFrom(events: readonly Record<string, unknown>[]): { changes: ChangeRecord[]; checks: CheckRecord[] } {
  const changes: ChangeRecord[] = [];
  const checks: CheckRecord[] = [];
  for (const event of events) {
    const seq = event.seq as number;
    if ((event.kind === 'tool' || event.kind === 'workspaceFileChange') && Array.isArray(event.fileChanges)) {
      for (const value of event.fileChanges) {
        if (!record(value) || !projectPath(value.path) || typeof value.operation !== 'string'
          || typeof value.outcome !== 'string') continue;
        const beforeVersion = typeof value.beforeVersion === 'string' && /^[a-f0-9]{16}$/iu.test(value.beforeVersion)
          ? value.beforeVersion : undefined;
        const afterVersion = typeof value.observedAfterVersion === 'string' && /^[a-f0-9]{16}$/iu.test(value.observedAfterVersion)
          ? value.observedAfterVersion : typeof value.expectedAfterVersion === 'string'
            && /^[a-f0-9]{16}$/iu.test(value.expectedAfterVersion) ? value.expectedAfterVersion : undefined;
        changes.push({ seq, path: value.path, operation: value.operation, outcome: value.outcome,
          source: event.kind === 'workspaceFileChange' && event.source === 'desktop' ? 'desktop' : 'agent',
          ...(typeof event.tool === 'string' ? { tool: event.tool } : {}),
          ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
          ...(beforeVersion === undefined ? {} : { beforeVersion }),
          ...(afterVersion === undefined ? {} : { afterVersion }) });
      }
    }
    if (event.kind === 'check' && record(event.declaration) && Array.isArray(event.declaration.scope)) {
      checks.push({ seq,
        ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
        name: typeof event.declaration.name === 'string' ? event.declaration.name : 'check',
        commandStatus: typeof event.commandStatus === 'string' ? event.commandStatus : 'unknown',
        reportStatus: typeof event.reportStatus === 'string' ? event.reportStatus : 'unknown',
        scopeStatus: typeof event.scopeStatus === 'string' ? event.scopeStatus : 'unverified',
        scope: event.declaration.scope.filter(projectPath) });
    }
  }
  changes.sort((left, right) => right.seq - left.seq);
  checks.sort((left, right) => right.seq - left.seq);
  // 范围是否仍然有效由 Host 依据完整会话判定并通过 `scopeStatus` 传下；界面只呈现，不再按当前页重算，
  // 否则同一事实会得到两个答案，而且页外的后续改动会被漏掉。
  return { changes, checks };
}
