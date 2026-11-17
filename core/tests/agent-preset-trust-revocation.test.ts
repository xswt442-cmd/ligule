import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measuredPermissionContext, withTuiHost } from './helpers/tui-host.ts';

test('a preset child still rechecks live workspace trust before executing a project command', { timeout: 30_000 }, async t => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.capabilities.process !== 'full') return t.skip('the platform process ownership backend is unavailable');
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let markParentReached!: () => void;
  let markChildReached!: () => void;
  let projectDirectory = '';
  let sessionDirectory = '';
  let childModelCalls = 0;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  const childReached = new Promise<void>(resolve => { markChildReached = resolve; });
  let stage = 'host startup';
  try {
    await withTuiHost(async context => {
      projectDirectory = context.projectDirectory;
      sessionDirectory = context.sessionDirectory;
      const { client, sessionId } = context;
      stage = 'initial trust';
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
      client.onRequest(message => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
      stage = 'parent Run acceptance';
      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      await parentReached;
      stage = 'child preset start';
      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, presetId: 'trusted-child', task: 'run project script after revocation',
      }) as { subrunId: string; sessionId: string; runId: string };
      await childReached;
      stage = 'workspace trust revocation';
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: false });
      releaseChild();
      stage = 'child settlement';
      const status = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 20_000,
      }) as { subruns: { state: string }[] };
      assert.ok(['completed', 'failed'].includes(status.subruns[0]?.state ?? ''));
      assert.equal(existsSync(join(projectDirectory, 'preset-script-marker.txt')), false);
      const events = (await readFile(join(sessionDirectory, `${child.sessionId}.jsonl`), 'utf8')).trim().split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      const execEvents = events.filter(event => event.kind === 'tool' && event.tool === 'exec');
      assert.ok(execEvents.some(event => JSON.stringify(event).includes('exec_workspace_untrusted')), JSON.stringify(execEvents));
      assert.equal(events.some(event => event.kind === 'execution'), false, 'the denied command must not start a process');
      stage = 'restore trust and settle parent';
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      setup: async paths => {
        projectDirectory = paths.projectDirectory;
        await mkdir(join(projectDirectory, '.ligule', 'agents'), { recursive: true });
        await writeFile(join(projectDirectory, '.ligule', 'agents', 'trusted-child.toml'), [
          'schemaVersion = 1',
          'description = "Run one project command under the live trust check."',
          'instruction = "Attempt the declared project script once and report the actual tool result."',
          'permissionProfile = "full-access"',
          'network = "unrestricted"',
          'mode = "full"',
        ].join('\n'));
        await writeFile(join(projectDirectory, 'write-marker.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('preset-script-marker.txt', 'unexpected');\n");
      },
      providerReply: body => {
        const user = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (user === 'parent-held') return { text: 'parent completed' };
        if (user === 'run project script after revocation') {
          childModelCalls += 1;
          if (childModelCalls === 1) return { toolCalls: [{ tool: 'exec', args: {
            command: `node "${join(projectDirectory, 'write-marker.mjs').replaceAll('\\', '/')}"`, waitMs: 10_000,
          } }] };
        }
        return { text: 'I inspected the actual command result.' };
      },
      beforeResponse: async body => {
        const user = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (user === 'parent-held') { markParentReached(); await parentGate; }
        if (user === 'run project script after revocation') { markChildReached(); await childGate; }
      },
      permission,
      permissionControl: true,
      modeName: 'full',
      config: { loop: { iterations: 5, modelCalls: 5 } },
      testDirectory: join(process.cwd(), 'testplace', 'tmp'),
    });
  } catch (error) {
    throw new Error(`P14 trust revocation check failed during ${stage}`, { cause: error });
  } finally {
    releaseChild();
    releaseParent();
  }
});
