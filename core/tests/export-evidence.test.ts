// 验证 F06：导出的每条命令都带命令引用、起止时间、退出或终止原因、日志引用和完整度；
// 命令日志与基线正文按与 Session 相同的访问规则读取，只保留有界摘录，读不到就写明原因。
// 排版是纯计算；需要正文的那几例先在真的临时目录里写出真的日志文件和基线快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { EXPORT_EVIDENCE_MAX_BYTES, exportMarkdown, exportRecordOf, readExportEvidence } from '../dist/host/export.js';
import type { ExportRecord } from '../dist/host/export.js';
import { removeExecutionLog, writeExecutionLog } from '../dist/session/execution-log.js';
import type { ExecLogSnapshot } from '../dist/capability/exec.js';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_NAME = 'change-0123456789abcdef-11111111-1111-4111-8111-111111111111.snapshot';

function executionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 3, kind: 'execution', state: 'exited',
    executionId: EXECUTION_ID, runId: 'run-1', callId: 'call-1',
    startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:02.000Z',
    timeoutMs: 30_000, exitCode: 0,
    logTotalBytes: 0, logFirstAvailableOffset: 0,
    cancelRequested: false, deadlineExceeded: false, terminationPending: false, cleanupPending: false,
    ...overrides,
  };
}

function recordOf(event: Record<string, unknown>): ExportRecord {
  const record = exportRecordOf(event as never);
  assert.ok(record, 'execution 事件必须能进入导出记录');
  return record;
}

function logSnapshot(body: string): ExecLogSnapshot {
  const data = Buffer.from(body, 'utf8');
  return {
    totalBytes: data.length,
    firstAvailableOffset: 0,
    chunks: [{ sequence: 0, stream: 'stdout', offset: 0, data }],
  };
}

function fileChange(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'note.txt', operation: 'write', outcome: 'written',
    beforeVersion: 'a'.repeat(16), expectedAfterVersion: 'b'.repeat(16), observedAfterVersion: 'b'.repeat(16),
    observedAt: '2026-11-17T00:00:00.000Z',
    baselineStatus: 'available', baselineExists: true, baselineVersion: 'a'.repeat(16),
    observedStatus: 'available', observedExists: true,
    expectedMatchesObserved: true, changedFromBaseline: true,
    ...overrides,
  };
}

async function temporaryDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('an execution event keeps the command reference, window, result and log reference', () => {
  const logsRef = { name: `execution-${EXECUTION_ID}.log.json`, bytes: 123, sha256: 'd'.repeat(64) };
  const record = recordOf(executionEvent({ logsRef, logTotalBytes: 40, logFirstAvailableOffset: 8 }));
  assert.deepEqual(record.execution, {
    executionId: EXECUTION_ID, runId: 'run-1', callId: 'call-1', state: 'exited',
    startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:02.000Z',
    timeoutMs: 30_000, exitCode: 0, logsRef,
    logTotalBytes: 40, logFirstAvailableOffset: 8,
    cancelRequested: false, deadlineExceeded: false, terminationPending: false, cleanupPending: false,
  });
});

test('the export writes the command reference, window, result, log reference and completeness', () => {
  const logsRef = { name: `execution-${EXECUTION_ID}.log.json`, bytes: 123, sha256: 'd'.repeat(64) };
  const text = exportMarkdown([recordOf(executionEvent({ logsRef, logTotalBytes: 40, logFirstAvailableOffset: 8 }))], { id: 's-1' });
  assert.match(text, /### 第 3 条 · 命令 call-1/);
  assert.match(text, /- 命令引用：call call-1；run run-1；execution 11111111-1111-4111-8111-111111111111/);
  assert.match(text, /- 时段：2026-11-17T00:00:00\.000Z → 2026-11-17T00:00:02\.000Z/);
  assert.match(text, /- 命令结果：exited（退出码 0）/);
  assert.match(text, new RegExp(`- 日志引用：execution-${EXECUTION_ID}\\.log\\.json（123 字节，SHA-256 d{64}）`, 'u'));
  assert.match(text, /- 日志完整度：partial（共 40 字节，最早可读偏移 8）/);
  // 这一层没有正文通道时必须说清“没带”，不能让人以为日志本来就是空的。
  assert.match(text, /- 日志正文未随这份导出包含（export_evidence_not_provided）/);
});

test('a terminated command records the termination reason and the pending marks', () => {
  const text = exportMarkdown([recordOf(executionEvent({
    state: 'failed', exitCode: undefined, errorCode: 'exec_timeout',
    cancelRequested: true, deadlineExceeded: true, terminationPending: true,
    logsRef: undefined, logUnavailableReason: 'log_quota_exceeded', logTotalBytes: 0,
  }))], { id: 's-1' });
  assert.match(text, /- 命令结果：failed$/m);
  assert.match(text, /- 终止原因：exec_timeout/);
  assert.match(text, /- 标记：cancelRequested；deadlineExceeded；terminationPending/);
  assert.match(text, /- 日志引用：无（log_quota_exceeded）/);
  assert.match(text, /- 日志完整度：unavailable（共 0 字节，最早可读偏移 0）/);
});

test('an execution event that cannot be read is marked instead of being dropped', () => {
  const record = recordOf({ seq: 4, kind: 'execution', state: 'exited' });
  assert.equal(record.execution, undefined);
  const text = exportMarkdown([record], { id: 's-1' });
  assert.match(text, /第 4 条 · 命令/);
  assert.match(text, /export_execution_invalid/);
});

test('a live command log is quoted as a fenced excerpt under its reference', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-log-');
  const body = 'hello world\n';
  const logsRef = await writeExecutionLog(directory, EXECUTION_ID, logSnapshot(body));
  const record = recordOf(executionEvent({ logsRef, logTotalBytes: body.length }));
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 's-1' }, undefined, evidence);
  assert.match(text, /- 日志完整度：complete（共 12 字节，最早可读偏移 0）/);
  assert.match(text, /- 日志正文（完整正文：共 12 字节）：\n\n```text\nhello world\n```/);
});

test('repeated execution events quote the log body only once', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-log-');
  const logsRef = await writeExecutionLog(directory, EXECUTION_ID, logSnapshot('hello world\n'));
  const records = [
    recordOf(executionEvent({ seq: 3, state: 'started', finishedAt: undefined, exitCode: undefined, logsRef, logTotalBytes: 12 })),
    recordOf(executionEvent({ seq: 4, logsRef, logTotalBytes: 12 })),
  ];
  const evidence = await readExportEvidence(directory, records);
  const text = exportMarkdown(records, { id: 's-1' }, undefined, evidence);
  assert.equal(text.split('hello world').length - 1, 1, '同一条命令只展开一次正文');
  assert.match(text, /- 日志正文：见第 3 条，这里不重复展开。/);
});

test('a log removed by retention is reported as missing, not as empty', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-log-');
  const logsRef = await writeExecutionLog(directory, EXECUTION_ID, logSnapshot('gone\n'));
  assert.equal(await removeExecutionLog(directory, logsRef.name), true);
  const record = recordOf(executionEvent({ logsRef, logTotalBytes: 5 }));
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 's-1' }, undefined, evidence);
  assert.match(text, /- 日志引用：execution-11111111-1111-4111-8111-111111111111\.log\.json/);
  assert.match(text, /- 日志正文未随这份导出包含（export_evidence_missing）/);
  assert.doesNotMatch(text, /gone/);
});

test('a log bigger than the excerpt limit is quoted as a bounded tail', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-log-');
  // 完整流 10000 字节，保留策略只留下从 4000 起的 6000 字节；导出的窗口只有最后 4096 字节。
  const stream = `${'x'.repeat(9000)}\n${'y'.repeat(999)}`;
  const logsRef = await writeExecutionLog(directory, EXECUTION_ID, {
    totalBytes: 10_000,
    firstAvailableOffset: 4000,
    chunks: [{ sequence: 0, stream: 'stdout', offset: 4000, data: Buffer.from(stream.slice(4000), 'utf8') }],
  });
  const record = recordOf(executionEvent({ logsRef, logTotalBytes: 10_000, logFirstAvailableOffset: 4000 }));
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 's-1' }, undefined, evidence);
  assert.match(text, /- 日志正文（有界摘录：共 10000 字节，仅包含最后 999 字节）：/);
  assert.match(text, /y{999}/);
  assert.doesNotMatch(text, /x{20}/, '被切掉的正文不写进导出件');
  assert.ok(text.length < 6000, `导出件保持有界（实际 ${text.length} 字节）`);
  assert.ok(EXPORT_EVIDENCE_MAX_BYTES <= 4096);
});

test('a private baseline is quoted under the same access rule as its reference', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-baseline-');
  const content = Buffer.from('baseline note\n', 'utf8');
  await writeFile(join(directory, SNAPSHOT_NAME), content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const record: ExportRecord = {
    seq: 5, kind: 'tool', tool: 'write', result: { content: 'wrote note.txt' },
    fileChanges: [fileChange({ baselineRef: { name: SNAPSHOT_NAME, bytes: content.length, sha256 } })] as never,
  };
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 'session-1' }, undefined, evidence);
  assert.match(text, new RegExp(`Session 私有基线引用：14 字节，SHA-256 ${sha256}。`, 'u'));
  assert.match(text, /- 基线正文（完整正文：共 14 字节）：\n\n```text\nbaseline note\n```/);
  assert.doesNotMatch(text, /内容未嵌入这份导出/);
});

test('a baseline that resolves outside the session directory is refused with a reason', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-baseline-');
  const outside = await temporaryDirectory(t, 'ligule-export-outside-');
  const content = Buffer.from('outside note\n', 'utf8');
  const target = join(outside, 'target.txt');
  await writeFile(target, content);
  // 快照被换成指向会话目录之外的链接；环境不允许创建链接时退回 `..` 路径。
  // 两种形状都必须在导出时被拒，外部正文不得出现在导出件里。
  let name = SNAPSHOT_NAME;
  try {
    await symlink(target, join(directory, SNAPSHOT_NAME));
  } catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EACCES') throw cause;
    name = relative(directory, target);
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  const record: ExportRecord = {
    seq: 6, kind: 'tool', tool: 'write', result: { content: 'wrote note.txt' },
    fileChanges: [fileChange({ baselineRef: { name, bytes: content.length, sha256 } })] as never,
  };
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 'session-1' }, undefined, evidence);
  assert.match(text, /- 基线正文未随这份导出包含（export_baseline_outside_session）/);
  assert.doesNotMatch(text, /outside note/);
});

test('a baseline whose bytes no longer match its reference is refused with a reason', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-baseline-');
  const content = Buffer.from('changed\n', 'utf8');
  await writeFile(join(directory, SNAPSHOT_NAME), content);
  const record: ExportRecord = {
    seq: 7, kind: 'tool', tool: 'write', result: { content: 'wrote note.txt' },
    fileChanges: [fileChange({
      baselineRef: { name: SNAPSHOT_NAME, bytes: content.length, sha256: 'e'.repeat(64) },
    })] as never,
  };
  const evidence = await readExportEvidence(directory, [record]);
  const text = exportMarkdown([record], { id: 'session-1' }, undefined, evidence);
  assert.match(text, /- 基线正文未随这份导出包含（export_baseline_digest_mismatch）/);
  assert.doesNotMatch(text, /changed/);
});

test('a file change without a stored baseline still says the content was not saved', () => {
  const text = exportMarkdown([{
    seq: 8, kind: 'tool', tool: 'write', result: { content: 'wrote note.txt' },
    fileChanges: [fileChange({
      baselineStatus: 'unavailable', baselineExists: false, baselineVersion: null,
      baselineReason: 'baseline_snapshot_unavailable', baselineRef: undefined, changedFromBaseline: null,
    })] as never,
  }], { id: 'session-1' });
  assert.match(text, /- 基线：unavailable（baseline_snapshot_unavailable）/);
  assert.match(text, /- 基线正文未保存；本项仅包含可观察的版本和状态。/);
  assert.doesNotMatch(text, /基线正文（/);
});

test('the whole export stays inside the evidence budget and marks what it could not include', async (t) => {
  const directory = await temporaryDirectory(t, 'ligule-export-budget-');
  const records: ExportRecord[] = [];
  for (let index = 0; index < 20; index += 1) {
    const executionId = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
    const logsRef = await writeExecutionLog(directory, executionId, logSnapshot('z'.repeat(4096)));
    records.push(recordOf(executionEvent({ seq: index, executionId, logsRef, logTotalBytes: 4096 })));
  }
  const evidence = await readExportEvidence(directory, records);
  const text = exportMarkdown(records, { id: 's-budget' }, undefined, evidence);
  assert.match(text, /export_evidence_budget_exhausted/);
  assert.ok(text.length < 64 * 1024 + 24 * 1024, `导出件保持有界（实际 ${text.length} 字节）`);
});
