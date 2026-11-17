import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measuredPermissionContext, waitFor, withTuiHost } from './helpers/tui-host.ts';

test('a full preset cannot restore parent-hidden tools or prompt fragments', { timeout: 20_000 }, async t => {
  const permission = await measuredPermissionContext('full-access', 'unrestricted');
  if (permission.profile !== 'full-access') return t.skip('full permission is unavailable');
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let markParentReached!: () => void;
  let markChildReached!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  const childReached = new Promise<void>(resolve => { markChildReached = resolve; });
  const childProviderRequests: { tools?: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] }[] = [];
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
      await client.request('workspace.trust', { projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true });
      const parentStatus = await client.request('status.get', { sessionId }) as { tools: string[] };
      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      await parentReached;
      const preview = await client.request('preset.preview', { sessionId, parentRunId: parent.runId, presetId: 'full-child' }) as {
        mode: { tools: readonly string[] | '*'; prompt: readonly string[] | '*' };
      };
      assert.equal(preview.mode.tools, '*');
      assert.deepEqual(preview.mode.prompt, []);
      await client.request('subrun.start', { sessionId, parentRunId: parent.runId, presetId: 'full-child', task: 'child task' });
      await childReached;
      releaseChild();
      await waitFor(() => childProviderRequests.some(request => request.messages.some(message => message.role === 'user' && message.content === 'child task')));
      const childRequest = childProviderRequests.find(request => request.messages.some(message => message.role === 'user' && message.content === 'child task'))!;
      const childTools = childRequest.tools?.map(tool => tool.function.name) ?? [];
      assert.ok(childTools.every(name => parentStatus.tools.includes(name)), JSON.stringify({ parent: parentStatus.tools, child: childTools }));
      assert.equal(childTools.includes('parent_only_tool'), false);
      const childSystem = childRequest.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
      assert.equal(childSystem.includes('PARENT_ONLY_PROMPT_MARKER'), false);
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      permission,
      permissionControl: true,
      modeName: 'parent-read',
      extensions: { paths: [fileURLToPath(new URL('./fixtures/p14-prompt-extension.mjs', import.meta.url))], ignored: [] },
      setup: async ({ projectDirectory }) => {
        await mkdir(join(projectDirectory, '.ligule', 'modes'), { recursive: true });
        await mkdir(join(projectDirectory, '.ligule', 'agents'), { recursive: true });
        await writeFile(join(projectDirectory, '.ligule', 'modes', 'parent-read.toml'), 'tools = ["read"]\nprompt = []\n');
        await writeFile(join(projectDirectory, '.ligule', 'agents', 'full-child.toml'), [
          'schemaVersion = 1',
          'description = "Attempt a full child mode under a narrower parent."',
          'instruction = "Follow the parent Session limits."',
          'permissionProfile = "read-only"',
          'network = "disabled"',
          'mode = "full"',
        ].join('\n'));
      },
      testDirectory: join(process.cwd(), 'testplace', 'tmp'),
      beforeResponse: async body => {
        const lastUser = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (lastUser === 'parent-held') { markParentReached(); await parentGate; }
        if (lastUser === 'child task') { childProviderRequests.push(body); markChildReached(); await childGate; }
      },
    });
  } finally {
    releaseChild();
    releaseParent();
  }
});
