import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { createHost } from '../dist/host/host.js';
import { createConfigStore } from '../dist/kernel/config-store.js';
import { loadConfigLayers } from '../dist/kernel/config-file.js';
import { createConfig } from '../dist/kernel/config.js';
import { MESSAGES_CAPABILITIES } from '../dist/index.js';
import { createPermissionContext } from '../dist/kernel/permission.js';

async function withPolicyHost(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-policy-memory-'));
  const home = join(root, 'home');
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const projectC = join(root, 'project-c');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true }), mkdir(projectC, { recursive: true })]);
  const previousHome = process.env.LIGULE_HOME;
  process.env.LIGULE_HOME = home;

  let modelCall = 0;
  const provider = {
    capabilities: MESSAGES_CAPABILITIES,
    model: 'policy-memory-test',
    async *stream(request) {
      const userAt = request.messages.findLastIndex((message) => message.role === 'user');
      const hasToolResult = request.messages.slice(userAt + 1).some((message) => message.role === 'tool');
      if (!hasToolResult) {
        modelCall += 1;
        const nextCall = options.toolCall?.(modelCall) ?? { name: 'read', args: { path: 'note.txt' } };
        yield { type: 'tool-call', id: `tool-${modelCall}`, ...nextCall };
      } else yield { type: 'text', text: 'Read complete.' };
    },
  };

  const environment = async (projectRoot) => {
    await mkdir(join(projectRoot, '.ligule', 'sessions'), { recursive: true });
    await writeFile(join(projectRoot, 'note.txt'), 'permission memory test');
    const layers = await loadConfigLayers({ projectRoot, userHome: home });
    const config = createConfig({
      ...layers,
      user: {
        ...layers.user,
        boundary: projectRoot,
        workspaceRoot: projectRoot,
        host: { sessionDirectory: join(projectRoot, '.ligule', 'sessions') },
      },
    });
    return {
      config,
      provider,
      policy: config.policy,
      layers,
      store: createConfigStore({ projectRoot, userHome: home, layers }),
    };
  };

  const mode = options.policyMode ?? 'ask';
  const rules = options.policyRules ?? [];
  const configText = [
    '[policy]',
    `mode = ${JSON.stringify(mode)}`,
    ...rules.flatMap((rule) => [
      '', '[[policy.rules]]',
      `tool = ${JSON.stringify(rule.tool)}`,
      `decision = ${JSON.stringify(rule.decision)}`,
      ...(rule.match === undefined ? [] : [`match = ${JSON.stringify(rule.match)}`]),
      ...(rule.reason === undefined ? [] : [`reason = ${JSON.stringify(rule.reason)}`]),
    ]),
    '',
  ].join('\n');

  let host;
  try {
    for (const project of [projectA, projectB, projectC]) {
      await mkdir(join(project, '.ligule'), { recursive: true });
      await writeFile(join(project, '.ligule', 'config.toml'), configText);
    }
    const seed = await environment(projectA);
    host = createHost({
      config: seed.config,
      provider,
      policy: seed.policy,
      configLayers: seed.layers,
      configStore: seed.store,
      loadEnvironment: environment,
      permissionControl: true,
      interactive: true,
      ...(options.permission === undefined ? {} : { permission: options.permission }),
    });
    await run({ host, projectA, projectB, projectC, home });
  } finally {
    await host?.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

function connection(scope, requests, rememberTarget) {
  return {
    notify() {},
    async request(method, params) {
      assert.equal(method, 'approval.request');
      requests.push(params);
      return { decision: 'allow', rememberScope: scope, ...(rememberTarget === undefined ? {} : { rememberTarget }) };
    },
  };
}

async function runRead(host, client, sessionId, input = 'read the note') {
  return host.handle({ method: 'run.start', params: { sessionId, input } }, client);
}

test('session-scoped approval memory survives closing and reopening that session', async () => {
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = connection('session', requests);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await runRead(host, client, sessionId);
    assert.equal(requests.length, 1);
    const saved = await host.handle({ method: 'session.read', params: { sessionId } }, client);
    assert.ok(saved.events.some((event) => event.kind === 'sessionPolicyRule' && event.rule.tool === 'read'));

    await host.handle({ method: 'session.close', params: { sessionId } }, client);
    await host.handle({ method: 'session.open', params: { sessionId, projectRoot: projectA } }, client);
    await runRead(host, client, sessionId, 'read it again');
    assert.equal(requests.length, 1);
  });
});

test('project-scoped approval memory affects other sessions in that project', async () => {
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = connection('project', requests);
    const first = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await runRead(host, client, first.sessionId);
    assert.equal(requests.length, 1);
    const config = await readFile(join(projectA, '.ligule', 'config.local.toml'), 'utf8');
    assert.match(config, /tool = "read"/u);

    const second = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await runRead(host, client, second.sessionId, 'read again');
    assert.equal(requests.length, 1);
  });
});

test('user-scoped approval memory is available in other projects unless a project rule overrides it', async () => {
  await withPolicyHost(async ({ host, projectA, projectB, projectC }) => {
    const requests = [];
    const client = connection('user', requests);
    const first = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await runRead(host, client, first.sessionId);
    assert.equal(requests.length, 1);
    assert.match(await readFile(join(process.env.LIGULE_HOME, 'config.toml'), 'utf8'), /tool = "read"/u);

    const second = await host.handle({ method: 'session.create', params: { projectRoot: projectB } }, client);
    await runRead(host, client, second.sessionId, 'read in another project');
    assert.equal(requests.length, 1);

    await writeFile(join(projectC, '.ligule', 'config.toml'), '[policy]\nmode = "ask"\n\n[[policy.rules]]\ntool = "read"\ndecision = "ask"\n');
    const third = await host.handle({ method: 'session.create', params: { projectRoot: projectC } }, client);
    await runRead(host, client, third.sessionId, 'read with project override');
    assert.equal(requests.length, 2);
    const records = await host.handle({ method: 'session.read', params: { sessionId: third.sessionId } }, client);
    const lastTool = records.events.filter((event) => event.kind === 'tool').at(-1);
    assert.equal(lastTool.result.code, 'policy_memory_shadowed');
  });
});

test('remembering create is file-scoped by default and does not create a tool-wide allow', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = connection('project', requests, 'file');
    const first = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId: first.sessionId, input: 'create a note' } }, client);
    assert.equal(requests.length, 1);
    const saved = await readFile(join(projectA, '.ligule', 'config.local.toml'), 'utf8');
    assert.match(saved, /tool = "create"/u);
    assert.match(saved, /target = "file"/u);
    assert.match(saved, /path = .*app\.js/u);

    const samePath = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId: samePath.sessionId, input: 'create that file again' } }, client);
    assert.equal(requests.length, 1, 'the same target skips the approval even if the create tool reports that it already exists');

    const otherPath = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId: otherPath.sessionId, input: 'create another file' } }, client);
    assert.equal(requests.length, 2, 'a different file still requires approval');
  }, {
    permission,
    toolCall: (index) => ({ name: 'create', args: { path: index === 3 ? 'other.js' : 'app.js', content: 'saved' } }),
  });
});

test('remembered workspace scope applies only to the selected write operation class', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = connection('project', requests, 'workspace');
    const first = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId: first.sessionId, input: 'create a note' } }, client);
    assert.equal(requests.length, 1);
    const saved = await readFile(join(projectA, '.ligule', 'config.local.toml'), 'utf8');
    const savedConfig = parse(saved);
    const workspaceRule = savedConfig.policy.rules.find((rule) => rule.target === 'workspace' && rule.tool === 'create');
    assert.ok(workspaceRule, 'the remembered create rule should use workspace scope');
    assert.equal(workspaceRule.path, await realpath(projectA));

    const next = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId: next.sessionId, input: 'create another note' } }, client);
    assert.equal(requests.length, 1);
    assert.ok((await readFile(join(projectA, 'other.js'), 'utf8')).includes('saved'));
  }, {
    permission,
    toolCall: (index) => ({ name: 'create', args: { path: index === 1 ? 'app.js' : 'other.js', content: 'saved' } }),
  });
});

test('20 KB and 100 KB file approvals send only a bounded summary and retrieve the original pending arguments on demand', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  for (const size of [20_000, 100_000]) {
    const content = 'x'.repeat(size);
    await withPolicyHost(async ({ host, projectA }) => {
      let summary;
      let fullDetails;
      const client = {
        notify() {},
        async request(method, params) {
          assert.equal(method, 'approval.request');
          summary = params;
          assert.equal(JSON.stringify(params).includes(content), false);
          assert.ok(String(params.args.content).length <= 513);
          fullDetails = await host.handle({ method: 'approval.details', params: { sessionId: params.sessionId, requestId: params.detailsRef } }, client);
          return { decision: 'allow' };
        },
      };
      const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
      await host.handle({ method: 'run.start', params: { sessionId, input: `create ${size} bytes` } }, client);

      const digest = createHash('sha256').update(content, 'utf8').digest('hex');
      assert.equal(summary.contentBytes, size);
      assert.equal(summary.contentSha256, digest);
      assert.equal(summary.argumentSha256, fullDetails.argumentSha256);
      assert.equal(fullDetails.args.content, content);
      assert.equal((await readFile(join(projectA, 'payload.txt'), 'utf8')), content);
      await assert.rejects(
        host.handle({ method: 'approval.details', params: { sessionId, requestId: summary.detailsRef } }, client),
        { code: 'control_interaction_stale' },
      );
    }, {
      permission,
      toolCall: () => ({ name: 'create', args: { path: 'payload.txt', content } }),
    });
  }
});

test('sensitive approval content fails closed with its own code and never appears in an approval request', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const content = 'api_key=do-not-display-this-value';
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = {
      notify() {},
      async request(_method, params) { requests.push(params); return { decision: 'allow' }; },
    };
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    await host.handle({ method: 'run.start', params: { sessionId, input: 'create a sensitive file' } }, client);
    assert.equal(requests.length, 0);
    const records = await host.handle({ method: 'session.read', params: { sessionId } }, client);
    const tool = records.events.filter((event) => event.kind === 'tool').at(-1);
    assert.equal(tool.result.code, 'control_interaction_sensitive');
    assert.notEqual(tool.result.code, 'ask_declined');
    assert.equal((await readFile(join(projectA, 'payload.txt')).catch(() => '')), '');
  }, {
    permission,
    toolCall: () => ({ name: 'create', args: { path: 'payload.txt', content } }),
  });
});

test('one trusted human approval resets forced-to-ask and both denial counters through Session restore', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = connection(undefined, requests);
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    for (let index = 0; index < 3; index += 1) {
      await host.handle({ method: 'run.start', params: { sessionId, input: `denied read ${index}` } }, client);
    }
    const restricted = await host.handle({ method: 'status.get', params: { sessionId } }, client);
    assert.deepEqual(restricted.denials, { consecutive: 3, total: 3 });
    assert.equal(restricted.policy, 'ask', 'the automatic session is now forced to ask');

    await host.handle({ method: 'run.start', params: { sessionId, input: 'create after the human decision' } }, client);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].policyForced, true);
    assert.equal(requests[0].policy, 'ask');
    const reset = await host.handle({ method: 'status.get', params: { sessionId } }, client);
    assert.deepEqual(reset.denials, { consecutive: 0, total: 0 });
    assert.equal(reset.policy, 'auto');

    const records = await host.handle({ method: 'session.read', params: { sessionId } }, client);
    const saved = records.events.filter((event) => event.kind === 'sessionPolicy').at(-1);
    assert.equal(saved.forcedToAsk, false);
    assert.equal(saved.consecutive, 0);
    assert.equal(saved.total, 0);
    await host.handle({ method: 'session.close', params: { sessionId } }, client);
    await host.handle({ method: 'session.open', params: { sessionId, projectRoot: projectA } }, client);
    const restored = await host.handle({ method: 'status.get', params: { sessionId } }, client);
    assert.equal(restored.policy, 'auto');
    assert.deepEqual(restored.denials, { consecutive: 0, total: 0 });
  }, {
    permission,
    policyMode: 'auto',
    policyRules: [{ tool: 'read', decision: 'deny', reason: 'test refusal' }],
    toolCall: (index) => index <= 3
      ? { name: 'read', args: { path: 'note.txt' } }
      : { name: 'create', args: { path: 'after-approval.js', content: 'allowed' } },
  });
});

test('an external operator approval releases forced asking and remains effective after reopening', async () => {
  const permission = createPermissionContext('workspace-write', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  await withPolicyHost(async ({ host, projectA }) => {
    const requests = [];
    const client = { notify() {}, async request(_method, params) {
      requests.push(params);
      return { decision: 'allow', source: 'controller' };
    } };
    const { sessionId } = await host.handle({ method: 'session.create', params: { projectRoot: projectA } }, client);
    for (let index = 0; index < 3; index += 1) {
      await host.handle({ method: 'run.start', params: { sessionId, input: `denied read ${index}` } }, client);
    }
    assert.equal((await host.handle({ method: 'status.get', params: { sessionId } }, client)).policy, 'ask');
    await host.handle({ method: 'run.start', params: { sessionId, input: 'operator approves the create' } }, client);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].policyForced, true);
    const after = await host.handle({ method: 'status.get', params: { sessionId } }, client);
    assert.equal(after.policy, 'auto');
    assert.deepEqual(after.denials, { consecutive: 0, total: 0 });
    await host.handle({ method: 'session.close', params: { sessionId } }, client);
    await host.handle({ method: 'session.open', params: { sessionId, projectRoot: projectA } }, client);
    const reopened = await host.handle({ method: 'status.get', params: { sessionId } }, client);
    assert.equal(reopened.policy, 'auto');
    assert.deepEqual(reopened.denials, { consecutive: 0, total: 0 });
    await host.handle({ method: 'run.start', params: { sessionId, input: 'create again after reopening' } }, client);
    assert.equal(requests.length, 1);
    assert.equal(await readFile(join(projectA, 'after-reopen.js'), 'utf8'), 'allowed');
  }, {
    permission,
    policyMode: 'auto',
    policyRules: [{ tool: 'read', decision: 'deny', reason: 'test refusal' }],
    toolCall: (index) => index <= 3
      ? { name: 'read', args: { path: 'note.txt' } }
      : { name: 'create', args: { path: index === 4 ? 'after-approval.js' : 'after-reopen.js', content: 'allowed' } },
  });
});
