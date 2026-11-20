import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDelegationGrant, delegationPathOf, listDelegationGrants, requireDelegationGrant } from '../dist/host/agent-control.js';
import type { CreateDelegationGrantInput } from '../dist/host/agent-control.js';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { withTuiHost, type TuiHostContext, type TuiHostOptions } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function delayedChildScript(path: string): string {
  const child = "const{writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(process.argv[1],'late'),1500);";
  return [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(child)}, ${JSON.stringify(path)}], { stdio: 'ignore', windowsHide: true });`,
    'setTimeout(() => {}, 5_000);',
  ].join('\n');
}

function providerGate(commandPath: () => string, reached: Deferred<void>, release: Deferred<void>) {
  let startSent = false;
  let held = false;
  return {
    async beforeResponse(body: { messages: { role: string }[] }) {
      if (!held && body.messages.at(-1)?.role === 'tool') {
        held = true;
        reached.resolve();
        await release.promise;
      }
    },
    providerReply() {
      if (startSent) return { text: 'the finite command lifecycle was checked' };
      startSent = true;
      return { toolCalls: [{ tool: 'exec', args: {
        command: `node "${commandPath().replaceAll('\\', '/')}"`, waitMs: 0,
      } }] };
    },
  };
}

async function executionFromSession(context: TuiHostContext) {
  const record = await context.client.request('session.read', { sessionId: context.sessionId }) as {
    events: { kind?: string; tool?: string; runId?: string; result?: { content?: Record<string, unknown> } }[];
  };
  const tool = record.events.find((event) => event.kind === 'tool' && event.tool === 'exec');
  const result = tool?.result?.content;
  assert.equal(result?.kind, 'execution', JSON.stringify(tool));
  assert.equal(result?.state, 'running', JSON.stringify(tool));
  assert.equal(typeof result?.executionId, 'string');
  return { executionId: result!.executionId as string };
}

async function terminalExecution(context: TuiHostContext, executionId: string) {
  const content = await readFile(join(context.sessionDirectory, `${context.sessionId}.jsonl`), 'utf8');
  const events = content.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return events.findLast((event) => event.kind === 'execution' && event.executionId === executionId
    && event.state !== 'accepted' && event.state !== 'started');
}

async function holdCommandUntilAllowed(action: (context: TuiHostContext) => Promise<void>, options: {
  readonly agentControl?: TuiHostOptions['agentControl'];
} = {}) {
  const reached = deferred<void>();
  const release = deferred<void>();
  let sideEffectPath = '';
  let commandPath = '';
  const gate = () => providerGate(() => commandPath, reached, release);
  await withTuiHost(async (context) => {
    commandPath = join(context.projectDirectory, 'revoked-finite-command.mjs');
    sideEffectPath = join(context.projectDirectory, 'must-not-write-after-owner-revocation.txt');
    await writeFile(commandPath, delayedChildScript(sideEffectPath));
    await context.client.request('workspace.trust', {
      projectRoot: context.projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    context.client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const run = context.client.request('run.start', { sessionId: context.sessionId, input: 'start one finite process tree' });
    const runSettled = run.then(() => undefined, () => undefined);
    let stage = 'waiting-for-tool-result';
    let executionId: string | undefined;
    try {
      await reached.promise;
      stage = 'reading-execution';
      const execution = await executionFromSession(context);
      executionId = execution.executionId;
      stage = 'revoking-owner';
      await action(context);
      release.resolve();
      stage = 'waiting-for-run';
      await runSettled;
      stage = 'checking-terminal-record';
      const terminal = await terminalExecution(context, execution.executionId);
      assert.equal(terminal?.state, 'cancelled', JSON.stringify(terminal));
      assert.equal(terminal?.cancelRequested, true);
      assert.equal(terminal?.terminationPending, false);
      assert.equal(terminal?.cleanupPending, false);
      stage = 'checking-descendant';
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      assert.equal(existsSync(sideEffectPath), false, 'the descendant must stop before its delayed file write');
    } catch (error) {
      release.resolve();
      await runSettled;
      throw new Error(`finite command owner revocation failed at ${stage}; executionId=${executionId ?? 'unknown'}`, { cause: error });
    }
  }, {
    ...gate(),
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { loop: { iterations: 8, modelCalls: 8 } },
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
    ...(options.agentControl === undefined ? {} : { agentControl: options.agentControl }),
  });
}

test('revoking workspace trust stops the active finite command tree', { timeout: 30_000 }, async () => {
  await holdCommandUntilAllowed(async (context) => {
    await context.client.request('workspace.trust', { projectRoot: context.projectDirectory, trusted: false });
  });
});

test('revoking an Agent Control Grant stops the active finite command tree', { timeout: 30_000 }, async () => {
  let grantId = '';
  let storePath = '';
  const agentControl: NonNullable<TuiHostOptions['agentControl']> = async ({ homeDirectory, projectDirectory }) => {
    storePath = delegationPathOf(homeDirectory);
    const current = await listDelegationGrants(storePath);
    const input: CreateDelegationGrantInput = {
      name: 'finite command revocation test',
      projectRoot: projectDirectory,
      defaultPermissionProfile: 'full-access',
      maxPermissionProfile: 'full-access',
      defaultNetwork: 'unrestricted',
      maxNetwork: 'unrestricted',
      defaultPolicy: 'ask',
      allowedPolicies: ['ask'],
      allowOperator: true,
      confirmFullAccess: true,
      confirmUnrestrictedNetwork: true,
      confirmPartialWorkspaceWrite: true,
      expiresAt: null,
    };
    const created = await createDelegationGrant(storePath, input, current.version);
    grantId = created.grants[0]!.id;
    return { grantId, storePath, operator: true,
      validate: () => requireDelegationGrant(storePath, grantId, projectDirectory) };
  };
  await holdCommandUntilAllowed(async ({ client }) => {
    const current = await listDelegationGrants(storePath);
    await client.request('agent-control.revoke', { grantId, version: current.version });
  }, { agentControl });
});

test('normal Host release stops an active finite command tree before closing its Session', { timeout: 30_000 }, async () => {
  await holdCommandUntilAllowed(async ({ host }) => { await host.release(); });
});
