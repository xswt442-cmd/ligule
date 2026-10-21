import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from '../dist/host/host.js';
import { createConfigStore } from '../dist/kernel/config-store.js';
import { loadConfigLayers } from '../dist/kernel/config-file.js';
import { createConfig } from '../dist/kernel/config.js';
import { MESSAGES_CAPABILITIES } from '../dist/index.js';

async function withPolicyHost(run) {
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
        yield { type: 'tool-call', id: `read-${modelCall}`, name: 'read', args: { path: 'note.txt' } };
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

  let host;
  try {
    for (const project of [projectA, projectB, projectC]) {
      await mkdir(join(project, '.ligule'), { recursive: true });
      await writeFile(join(project, '.ligule', 'config.toml'), '[policy]\nmode = "ask"\n');
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
    });
    await run({ host, projectA, projectB, projectC, home });
  } finally {
    await host?.release();
    if (previousHome === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

function connection(scope, requests) {
  return {
    notify() {},
    async request(method, params) {
      assert.equal(method, 'approval.request');
      requests.push(params);
      return { decision: 'allow', rememberScope: scope };
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
