import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { measuredPermissionContext, withTuiHost } from './helpers/tui-host.ts';

test('the three bundled presets run through real child Sessions with their documented boundaries', { timeout: 35_000 }, async t => {
  const measured = await measuredPermissionContext('full-access', 'unrestricted');
  if (measured.capabilities.process !== 'full' || measured.capabilities.filesystemWrite === 'unavailable'
    || measured.profiles.workspaceWrite === 'unavailable') {
    return t.skip('the platform cannot provide the real command and workspace-write capabilities required by the examples');
  }
  const permission = createPermissionContext(measured.profile, measured.network, measured.capabilities, {
    profiles: measured.profiles,
    limitations: measured.limitations,
    partialWorkspaceWriteConfirmationRequired: measured.partialWorkspaceWriteConfirmationRequired,
    partialWorkspaceWriteConfirmed: true,
    workspaceTrusted: measured.workspaceTrusted,
  });
  let releaseParent!: () => void;
  let markParentReached!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  let projectDirectory = '';
  const counts = new Map<string, number>();
  const providerTrace: string[] = [];
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory: currentProject, sessionDirectory }) => {
      projectDirectory = currentProject;
      await client.request('workspace.trust', { projectRoot: currentProject, trusted: true, confirmWorkspaceTrust: true });
      const parentStatus = await client.request('status.get', { sessionId }) as { tools: string[]; mode?: string };
      assert.ok(parentStatus.tools.includes('exec'), JSON.stringify(parentStatus));
      client.onRequest(message => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
      const parent = await client.request('run.submit', { sessionId, input: 'example parent held' }) as { runId: string };
      await parentReached;

      const research = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, presetId: 'research', task: 'research the local note',
      }) as { subrunId: string; sessionId: string; runId: string };
      const researchDone = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [research.subrunId], timeoutMs: 10_000,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(researchDone.timedOut, false);
      assert.equal(researchDone.subruns[0]?.state, 'completed');
      const researchLog = (await readFile(join(sessionDirectory, `${research.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      assert.ok(researchLog.some(event => event.kind === 'tool' && event.tool === 'read'));
      const researchSnapshot = researchLog.find(event => event.kind === 'turnContext')?.agentPreset as Record<string, unknown> | undefined;
      assert.equal((researchSnapshot?.permission as { profile: string }).profile, 'read-only');

      const implement = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, presetId: 'implement', task: 'implement a small marker file',
      }) as { subrunId: string; sessionId: string; runId: string };
      const implementDone = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [implement.subrunId], timeoutMs: 10_000,
      }) as { timedOut: boolean; subruns: { state: string }[] };
      assert.equal(implementDone.timedOut, false);
      assert.equal(implementDone.subruns[0]?.state, 'completed');
      const implementLog = (await readFile(join(sessionDirectory, `${implement.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      let marker: string | undefined;
      try { marker = await readFile(join(projectDirectory, 'implement-marker.txt'), 'utf8'); }
      catch { throw new Error(`implement preset trace: ${JSON.stringify({ providerTrace, tools: implementLog.filter(event => event.kind === 'tool') })}`); }
      assert.equal(marker, 'written by the child');

      await t.test('verify runs its declared command only when workspace network policy is enforceable', async verifyTest => {
        if (permission.capabilities.network !== 'full') {
          verifyTest.skip(`workspace-write with network=policy requires full network enforcement; detected ${permission.capabilities.network}`);
          return;
        }
        const verify = await client.request('subrun.start', {
          sessionId, parentRunId: parent.runId, presetId: 'verify', task: 'verify the local marker',
        }) as { subrunId: string; sessionId: string; runId: string };
        const verifyDone = await client.request('subrun.wait', {
          sessionId, parentRunId: parent.runId, subrunIds: [verify.subrunId], timeoutMs: 10_000,
        }) as { timedOut: boolean; subruns: { state: string }[] };
        assert.equal(verifyDone.timedOut, false);
        if (verifyDone.subruns[0]?.state !== 'completed') {
          const events = (await readFile(join(sessionDirectory, `${verify.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u)
            .map(line => JSON.parse(line) as Record<string, unknown>);
          throw new Error(`verify preset trace: ${JSON.stringify({ providerTrace, events: events.filter(event => event.kind === 'tool' || event.kind === 'check') })}`);
        }
        assert.equal(verifyDone.subruns[0]?.state, 'completed');
        const verifyLog = (await readFile(join(sessionDirectory, `${verify.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u)
          .map(line => JSON.parse(line) as Record<string, unknown>);
        const check = verifyLog.find(event => event.kind === 'check' && event.runId === verify.runId);
        assert.ok(check);
        assert.equal(check.commandStatus, 'met');
        assert.equal(check.reportStatus, 'reported_pass');
        assert.equal((check.report as { passed: number }).passed, 1);
        assert.equal(check.scopeStatus, 'sampled');
      });

      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      setup: async paths => {
        projectDirectory = paths.projectDirectory;
        await writeFile(join(projectDirectory, 'research-note.txt'), 'The project release date is unknown.\n');
        await writeFile(join(projectDirectory, 'verify-marker.mjs'),
          "import { readFileSync } from 'node:fs';\nif (readFileSync('implement-marker.txt', 'utf8') !== 'written by the child') process.exitCode = 1;\nprocess.stdout.write('LIGULE_TEST_REPORT_V1\\t{\"schema\":\"ligule-test-report\",\"version\":1,\"passed\":1,\"failed\":0,\"skipped\":0,\"todo\":0}\\n');\n");
      },
      providerReply: body => {
        const user = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        const count = (counts.get(String(user)) ?? 0) + 1;
        counts.set(String(user), count);
        providerTrace.push(`${String(user)} #${count}: ${(body.tools ?? []).map(tool => tool.function.name).join(',')}`);
        if (user === 'example parent held') return { text: 'parent done' };
        if (user === 'research the local note' && count === 1) return { toolCalls: [{ tool: 'read', args: { path: 'research-note.txt' } }] };
        if (user === 'implement a small marker file' && count === 1) return { toolCalls: [{ tool: 'create', args: {
          path: 'implement-marker.txt', content: 'written by the child',
        } }] };
        if (user === 'verify the local marker' && count === 1) return { toolCalls: [{ tool: 'exec', args: {
          command: `node "${join(projectDirectory, 'verify-marker.mjs').replaceAll('\\', '/')}"`, waitMs: 30_000,
          check: { name: 'verification', purpose: 'verify the marker written by the prior task', expectedExitCodes: [0],
            scope: ['implement-marker.txt'], report: { format: 'ligule-test-report-v1' } },
        } }] };
        return { text: 'I completed only the work and checks requested for this preset.' };
      },
      beforeResponse: async body => {
        if ([...body.messages].reverse().find(message => message.role === 'user')?.content === 'example parent held') {
          markParentReached();
          await parentGate;
        }
      },
      permission,
      permissionControl: true,
      modeName: 'full',
      config: { loop: { iterations: 8, modelCalls: 8, totalModelCalls: 24 } },
      testDirectory: join(process.cwd(), 'testplace', 'tmp'),
    });
  } finally {
    releaseParent();
  }
});
