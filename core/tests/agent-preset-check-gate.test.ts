import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measuredPermissionContext, waitFor, withTuiHost } from './helpers/tui-host.ts';

test('required P13 checks gate a preset child without extension completion hooks and reject stale or failing attempts', {
  timeout: 45_000,
}, async t => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let markParentReached!: () => void;
  let markChildReached!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  const childReached = new Promise<void>(resolve => { markChildReached = resolve; });
  let childModelCalls = 0;
  let staleFeedback = false;
  let failingReportFeedback = false;
  let checkProjectDirectory = '';
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory }) => {
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
      client.onRequest(message => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      await parentReached;
      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, presetId: 'verify-check', task: 'verify task',
      }) as { subrunId: string; sessionId: string; runId: string };
      await childReached;
      releaseChild();
      const outcome = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 30_000,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(outcome.timedOut, false);
      assert.equal(outcome.subruns[0]?.state, 'completed');
      assert.ok(staleFeedback, 'a later scoped edit must make the earlier passing check stale and continue the child');
      assert.ok(failingReportFeedback, 'a failing latest check must continue even if an older attempt passed');

      const lines = (await readFile(join(sessionDirectory, `${child.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u);
      const events = lines.map(line => JSON.parse(line) as Record<string, unknown>);
      const checks = events.filter(event => event.kind === 'check' && event.runId === child.runId);
      assert.equal(checks.length, 3);
      assert.deepEqual(checks.map(event => event.reportStatus), ['reported_pass', 'reported_fail', 'reported_pass']);
      assert.equal((checks[0]?.report as { passed: number }).passed, 1);
      assert.equal((checks[1]?.report as { failed: number }).failed, 1);
      assert.equal((checks[2]?.report as { passed: number }).passed, 1);
      assert.ok(checks.every(event => event.logStatus === 'complete'));

      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      setup: async ({ projectDirectory }) => {
        checkProjectDirectory = projectDirectory;
        await mkdir(join(projectDirectory, '.ligule', 'agents'), { recursive: true });
        await writeFile(join(projectDirectory, '.ligule', 'agents', 'verify-check.toml'), [
          'schemaVersion = 1',
          'description = "Verify check completion"',
          'instruction = "Run the required finite check and report its actual result."',
          'permissionProfile = "full-access"',
          'network = "unrestricted"',
          'mode = "full"',
          'requiredChecks = ["verification"]',
        ].join('\n'));
        await writeFile(join(projectDirectory, 'scope.txt'), 'stable scope\n');
        const report = (passed: number, failed: number) => ({
          schema: 'ligule-test-report', version: 1, passed, failed, skipped: 0, todo: 0,
        });
        const script = (value: Record<string, unknown>) =>
          `process.stdout.write(${JSON.stringify(`LIGULE_TEST_REPORT_V1\t${JSON.stringify(value)}\n`)});\n`;
        await writeFile(join(projectDirectory, 'first-pass.mjs'), script(report(1, 0)));
        await writeFile(join(projectDirectory, 'report-failed.mjs'), script(report(1, 1)));
        await writeFile(join(projectDirectory, 'latest-pass.mjs'), script(report(1, 0)));
      },
      permission,
      permissionControl: true,
      modeName: 'full',
      config: { loop: { iterations: 8, modelCalls: 8 } },
      testDirectory: join(process.cwd(), 'testplace', 'tmp'),
      beforeResponse: async body => {
        const lastUser = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (lastUser === 'parent-held') { markParentReached(); await parentGate; }
        if (lastUser === 'verify task') {
          markChildReached();
          await childGate;
        }
      },
      providerReply: body => {
        const user = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (user === 'parent-held') return { text: 'parent completed' };
        if (user !== 'verify task') return undefined;
        childModelCalls += 1;
        const guidance = body.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
        if (guidance.includes('scope_stale')) staleFeedback = true;
        if (guidance.includes('report_not_passing')) failingReportFeedback = true;
        if (childModelCalls === 1 || childModelCalls === 4 || childModelCalls === 6) {
          const script = childModelCalls === 1 ? 'first-pass.mjs' : childModelCalls === 4 ? 'report-failed.mjs' : 'latest-pass.mjs';
          return { toolCalls: [{ tool: 'exec', args: {
            command: `node "${join(checkProjectDirectory, script).replaceAll('\\', '/')}"`, waitMs: 30_000,
            check: { name: 'verification', purpose: 'verify the requested change', expectedExitCodes: [0],
              scope: ['scope.txt'], report: { format: 'ligule-test-report-v1' } },
          } }] };
        }
        if (childModelCalls === 2) return { toolCalls: [{ tool: 'edit', args: {
          path: 'scope.txt', changes: [{ oldText: 'stable scope', newText: 'changed scope' }],
        } }] };
        return { text: 'The check is complete.' };
      },
    });
  } finally {
    releaseChild();
    releaseParent();
  }
});
