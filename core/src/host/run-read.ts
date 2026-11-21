// Run 记录读模型：列出可见 receipt、读取单次 receipt、读取可分页的完整结果。
// 归属与可见性在这里判定一次：工作区身份、记录 owner、Run 作用域；结果页把已过期的检查范围标为 stale。
import { access } from 'node:fs/promises';
import { KernelError } from '../kernel/error.js';
import { workspaceIdentity } from '../kernel/workspace.js';
import type { SessionLog } from '../session/session.js';
import { readRunResult, runReceipts, runResultPage } from '../session/run.js';
import { runEvidenceReferences } from '../session/run-evidence.js';
import { runReceiptView } from './run-records.js';

export type RunReadParams = {
  readonly limit?: number;
  readonly before?: number;
  readonly runId?: unknown;
  readonly requestKey?: unknown;
  readonly offset?: number;
};

export type RunReadScope = {
  readonly sessionId: string;
  readonly env: { readonly projectRoot: string; readonly directory: string };
  readonly recordPath: string;
  readonly openedRoot: string | undefined;
  readonly log: SessionLog;
  readonly runScopes: readonly string[] | undefined;
  readonly live: (runId: string) => boolean;
};

async function visibleReceiptsOf(scope: RunReadScope) {
  const { sessionId, env, recordPath, openedRoot, log, runScopes } = scope;
  try { await access(recordPath); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new KernelError('session_not_found');
    throw cause;
  }
  const workspace = workspaceIdentity(env.projectRoot);
  if (openedRoot !== undefined && workspaceIdentity(openedRoot) !== workspace) throw new KernelError('run_owner_mismatch');
  const header = await log.header();
  const owner = header?.workspace ?? (header?.projectRoot ? workspaceIdentity(header.projectRoot) : undefined);
  if (owner !== workspace) throw new KernelError('run_owner_mismatch');
  const events = await log.read();
  const receipts = runScopes === undefined
    ? runReceipts(events, sessionId)
    : runScopes.flatMap(scopeOrPath => runReceipts(events, sessionId, scopeOrPath)).sort((left, right) => left.userSeq - right.userSeq);
  return { workspace, events, receipts };
}

export async function readRunRecord(method: 'run.receipt' | 'run.receipts' | 'run.result', params: RunReadParams, scope: RunReadScope) {
  const { sessionId, env } = scope;
  const { workspace, events, receipts } = await visibleReceiptsOf(scope);
  if (method === 'run.receipts') {
    const limit = params.limit ?? 20;
    const before = params.before;
    const matching = receipts.filter(item => before === undefined || item.userSeq < before).reverse();
    const page = matching.slice(0, limit);
    return { sessionId, receipts: page.map(receipt => runReceiptView(receipt, scope.live(receipt.runId))),
      hasMore: matching.length > page.length,
      nextBefore: matching.length > page.length ? page.at(-1)?.userSeq ?? null : null };
  }
  const reference = method === 'run.result' ? { runId: params.runId as string | undefined } : {
    ...(params.runId === undefined ? {} : { runId: params.runId as string }),
    ...(params.requestKey === undefined ? {} : { requestKey: params.requestKey as string }),
  };
  if ((reference.runId === undefined) === (reference.requestKey === undefined)) throw new KernelError('run_reference_invalid');
  const matches = receipts.filter(item => reference.runId !== undefined
    ? item.runId === reference.runId : item.requestKey === reference.requestKey);
  if (reference.requestKey !== undefined && matches.length > 1) {
    throw new KernelError('run_request_key_ambiguous', { detail: 'requestKey matches multiple visible run scopes; use runId to select one receipt' });
  }
  const receipt = matches[0];
  if (receipt === undefined) throw new KernelError('run_not_found');
  if (method === 'run.receipt') return runReceiptView(receipt, scope.live(receipt.runId));
  const result = await readRunResult(env.directory, workspace, sessionId, receipt);
  const currentEvidence = runEvidenceReferences(events, receipt.runId);
  const checksByCall = new Map(currentEvidence.checks.map(check => [check.callId, check]));
  const projectedResult = result.checks === undefined ? result : {
    ...result,
    checks: result.checks.map(check => checksByCall.get(check.callId)?.scopeStatus === 'stale'
      ? { ...check, scopeStatus: 'stale' as const }
      : check),
  };
  return { runId: receipt.runId, ...runResultPage(projectedResult, params.offset ?? 0) };
}
