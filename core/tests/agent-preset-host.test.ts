import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

test('an invalid project preset rejects child start before creating a child Session', { timeout: 20_000 }, async () => {
  let releaseParent!: () => void;
  let markParentReached!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests }) => {
      const presetDirectory = join(projectDirectory, '.ligule', 'agents');
      await mkdir(presetDirectory, { recursive: true });
      await writeFile(join(presetDirectory, 'research.toml'), [
        'schemaVersion = 1',
        'description = "Invalid project override"',
        'instruction = "Do not start."',
        'mode = "minimal"',
        'unexpected = true',
      ].join('\n'));

      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      await parentReached;
      const before = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      await assert.rejects(client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'must not start', presetId: 'research',
      }), { code: 'agent_preset_field_unknown' });
      await delay(50);
      const after = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      assert.deepEqual(after, before);
      assert.equal(providerRequests.filter(request => request.messages.some(message =>
        typeof message.content === 'string' && message.content.includes('must not start'))).length, 0);
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });
    }, {
      modeName: 'full',
      permissionControl: true,
      testDirectory: 'testplace/tmp',
      beforeResponse: async body => {
        if ([...body.messages].reverse().find(message => message.role === 'user')?.content === 'parent-held') {
          markParentReached();
          await parentGate;
        }
      },
    });
  } finally {
    releaseParent();
  }
});

test('Host preview and preset start share one config, persist its snapshot before returning, and list children after restart', { timeout: 30_000 }, async () => {
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let markParentReached!: () => void;
  let markChildReached!: () => void;
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const parentReached = new Promise<void>(resolve => { markParentReached = resolve; });
  const childReached = new Promise<void>(resolve => { markChildReached = resolve; });
  try {
    await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests, restart }) => {
      const presetDirectory = join(projectDirectory, '.ligule', 'agents');
      await mkdir(presetDirectory, { recursive: true });
      const presetPath = join(presetDirectory, 'implement.toml');
      const schemaPresetPath = join(presetDirectory, 'schema-locked.toml');
      const definition = (instruction: string) => [
        'schemaVersion = 1',
        'description = "Snapshot test preset"',
        `instruction = ${JSON.stringify(instruction)}`,
        'permissionProfile = "workspace-write"',
        'network = "policy"',
        '',
        '[mode]',
        'tools = ["exec", "exec_control", "find", "search", "read", "create", "write", "edit", "delete"]',
        'prompt = []',
      ].join('\n');
      await writeFile(presetPath, definition('Keep the original guidance.'));
      await writeFile(schemaPresetPath, [
        'schemaVersion = 1',
        'description = "Keep required output fields"',
        'instruction = "Return an answer."',
        '',
        '[outputSchema]',
        'type = "object"',
        'required = ["answer"]',
        'additionalProperties = false',
        '',
        '[outputSchema.properties]',
        'answer = { type = "string" }',
        '',
        '[mode]',
        'tools = ["read"]',
        'prompt = []',
      ].join('\n'));

      const listing = await client.request('preset.list', { sessionId, limit: 64 }) as {
        presets: { id: string; layer: string }[];
      };
      assert.deepEqual(listing.presets.map(item => item.id), ['implement', 'research', 'schema-locked', 'verify']);
      assert.equal(listing.presets[0]?.layer, 'project');

      const idlePreview = await client.request('preset.preview', { sessionId, presetId: 'implement' }) as {
        executable: boolean; permission: { profile: string; network: string };
        mode: { name: string; tools: readonly string[] | '*' }; instruction: string;
      };
      assert.equal(idlePreview.executable, false);
      assert.equal(idlePreview.permission.profile, 'read-only', 'a preset must not raise the parent Permission');
      assert.equal(idlePreview.permission.network, 'policy');
      assert.equal(idlePreview.mode.name, 'inline');
      assert.equal(idlePreview.instruction, 'Keep the original guidance.');

      const parent = await client.request('run.submit', { sessionId, input: 'parent-held' }) as { runId: string };
      await parentReached;
      const activePreview = await client.request('preset.preview', { sessionId, parentRunId: parent.runId, presetId: 'implement' }) as {
        executable: boolean; mode: { tools: readonly string[] | '*' };
      };
      assert.equal(activePreview.executable, true);
      assert.deepEqual(activePreview.mode.tools, ['exec', 'exec_control', 'find', 'search', 'read', 'create', 'write', 'edit', 'delete']);

      const beforeSchemaConflict = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      await assert.rejects(client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'schema conflict must not start', presetId: 'schema-locked',
        outputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      }), { code: 'agent_preset_output_schema_conflict' });
      const afterSchemaConflict = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      assert.deepEqual(afterSchemaConflict, beforeSchemaConflict);

      const child = await client.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'Implement the requested change.', presetId: 'implement',
      }) as { subrunId: string; sessionId: string; runId: string };
      await childReached;
      const parentRecord = await client.request('session.read', { sessionId, fullResults: true }) as {
        events: { kind?: string; tool?: string; text?: string; source?: string; parentRunId?: string;
          subrunId?: string; childSessionId?: string; childRunId?: string; presetId?: string; taskLabel?: string }[];
      };
      const started = parentRecord.events.find(event => event.kind === 'subrunStarted');
      assert.deepEqual(started && {
        source: started.source, parentRunId: started.parentRunId, subrunId: started.subrunId,
        childSessionId: started.childSessionId, childRunId: started.childRunId,
        presetId: started.presetId, taskLabel: started.taskLabel,
      }, {
        source: 'human', parentRunId: parent.runId, subrunId: child.subrunId,
        childSessionId: child.sessionId, childRunId: child.runId,
        presetId: 'implement', taskLabel: 'Implement the requested change.',
      });
      assert.equal(parentRecord.events.some(event => event.kind === 'tool'), false,
        'starting a child from the UI must not create a fake parent tool call');
      assert.equal(parentRecord.events.some(event => event.kind === 'user' && event.text === 'Implement the requested change.'), false,
        'the child task must not be recorded as a new parent user turn');
      const childPath = join(sessionDirectory, `${child.sessionId}.jsonl`);
      const eventsBeforeEdit = (await readFile(childPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line) as Record<string, unknown>);
      const snapshot = eventsBeforeEdit.find(event => event.kind === 'turnContext')?.agentPreset as Record<string, unknown> | undefined;
      assert.equal((snapshot?.instruction as string), 'Keep the original guidance.');
      assert.equal((eventsBeforeEdit.find(event => event.kind === 'user')?.text), 'Implement the requested change.');
      assert.ok(providerRequests.some(request => request.messages.some(message =>
        typeof message.content === 'string' && message.content.includes('Keep the original guidance.'))));

      await writeFile(presetPath, definition('Changed after the child started.'));
      const eventsAfterEdit = (await readFile(childPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line) as Record<string, unknown>);
      const saved = eventsAfterEdit.find(event => event.kind === 'turnContext')?.agentPreset as Record<string, unknown> | undefined;
      assert.equal(saved?.instruction, 'Keep the original guidance.');
      assert.equal(JSON.stringify(saved).includes('Changed after the child started.'), false);

      const liveChildren = await client.request('subrun.list', { sessionId, parentRunId: parent.runId, limit: 32 }) as {
        subruns: { subrunId: string; runId: string }[];
      };
      assert.ok(liveChildren.subruns.some(item => item.subrunId === child.subrunId));
      releaseChild();
      const completed = await client.request('subrun.wait', {
        sessionId, parentRunId: parent.runId, subrunIds: [child.subrunId], timeoutMs: 5_000,
      }) as { subruns: { state: string }[] };
      assert.equal(completed.subruns[0]?.state, 'completed');
      releaseParent();
      await client.request('run.wait', { sessionId, runId: parent.runId });

      const restarted = await restart();
      await restarted.request('session.open', { sessionId });
      const restoredParent = await restarted.request('session.read', { sessionId, fullResults: true }) as {
        events: { kind?: string; childSessionId?: string }[];
      };
      assert.equal(restoredParent.events.filter(event => event.kind === 'subrunStarted' && event.childSessionId === child.sessionId).length, 1,
        'the parent Session restores one navigable record for the UI-started child');
      const persisted = await restarted.request('subrun.list', { sessionId, parentRunId: parent.runId, limit: 32 }) as {
        subruns: { subrunId: string; runId: string }[];
      };
      assert.ok(persisted.subruns.some(item => item.subrunId === child.subrunId && item.runId === child.runId));

      const beforeStaleStart = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      await assert.rejects(restarted.request('subrun.start', {
        sessionId, parentRunId: parent.runId, task: 'stale parent must not start', presetId: 'implement',
      }), { code: 'subagent_parent_not_active' });
      const afterStaleStart = (await readdir(sessionDirectory)).filter(name => name.startsWith(`${sessionId}.sub-`) && name.endsWith('.jsonl'));
      assert.deepEqual(afterStaleStart, beforeStaleStart);
    }, {
      modeName: 'full',
      permissionControl: true,
      testDirectory: 'testplace/tmp',
      beforeResponse: async body => {
        const user = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        if (user === 'parent-held') { markParentReached(); await parentGate; }
        if (user === 'Implement the requested change.') { markChildReached(); await childGate; }
      },
    });
  } finally {
    releaseChild();
    releaseParent();
  }
});
