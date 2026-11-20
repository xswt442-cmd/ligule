import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConnection } from '../dist/host/connection.js';
import { withTuiHost, waitFor } from './helpers/tui-host.ts';

const hostFixture = fileURLToPath(new URL('./fixtures/finite-command-host-process.mjs', import.meta.url));

function commandScript(markerPath: string): string {
  // 路径通过 argv 传入，-e 的代码体保持常量；避免把生成的临时路径拼进可执行代码。
  const child = "const{writeFileSync}=require('node:fs');const m=process.argv[1];writeFileSync(m+'.started',JSON.stringify({pid:process.pid,parentId:process.ppid,startedAt:Date.now()}));setTimeout(()=>writeFileSync(m,'late'),5_000);";
  return [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', ${JSON.stringify(child)}, ${JSON.stringify(markerPath)}], { stdio: 'ignore', windowsHide: true });`,
    'setTimeout(() => {}, 10_000);',
  ].join('\n');
}

function spawnHost(projectRoot: string, sessionDirectory: string, baseURL: string) {
  const child = spawn(process.execPath, [hostFixture, projectRoot, sessionDirectory, baseURL], {
    cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
  if (child.stdin === null || child.stdout === null) throw new Error('finite_command_host_stdio_unavailable');
  const client = createConnection({ input: child.stdout, output: child.stdin });
  client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
  return { child, client, stderr: () => stderr };
}

test('abrupt Host exit kills its finite command tree and restores an interrupted handle as unknown', {
  skip: process.platform !== 'win32' && process.platform !== 'linux',
  timeout: 45_000,
}, async () => {
  let commandPath = '';
  let providerStep = 0;
  await withTuiHost(async ({ projectDirectory, sessionDirectory, config, providerRequests }) => {
    commandPath = join(projectDirectory, 'host-crash-command.mjs');
    const markerPath = join(projectDirectory, 'must-not-run-after-host-crash.txt');
    await writeFile(commandPath, commandScript(markerPath));

    let hostProcess = spawnHost(projectDirectory, sessionDirectory, config.model.baseURL);
    let restarted: ReturnType<typeof spawnHost> | undefined;
    let runSettled: Promise<void> = Promise.resolve();
    try {
      const created = await hostProcess.client.request('session.create', { projectRoot: projectDirectory }) as { sessionId: string };
      const sessionId = created.sessionId;
      await hostProcess.client.request('workspace.trust', {
        projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
      });

      const run = hostProcess.client.request('run.start', { sessionId, input: 'start a finite command before Host crash' });
      runSettled = run.then(() => undefined, () => undefined);
      let executionId = '';
      let runId = '';
      await waitFor(async () => {
        const record = await hostProcess.client.request('session.read', { sessionId, fullResults: true }) as {
          events: { kind?: string; state?: string; executionId?: string; runId?: string }[];
        };
        const started = record.events.findLast((event) => event.kind === 'execution' && event.state === 'started');
        if (typeof started?.executionId !== 'string' || typeof started.runId !== 'string') return false;
        executionId = started.executionId;
        runId = started.runId;
        return true;
      }, { within: 10_000, read: () => JSON.stringify(providerRequests.map((request) => request.messages)) });

      await waitFor(() => existsSync(`${markerPath}.started`), { within: 5_000,
        read: () => `Host pid ${hostProcess.child.pid} has not started the command descendant` });
      const processStarted = JSON.parse(await readFile(`${markerPath}.started`, 'utf8')) as {
        pid: number; parentId: number; startedAt: number;
      };

      const exited = once(hostProcess.child, 'exit');
      const killedAt = Date.now();
      assert.equal(hostProcess.child.kill('SIGKILL'), true, 'the test must terminate the child Host process');
      await exited;
      await runSettled;
      await delay(5_500);
      assert.equal(existsSync(markerPath), false,
        `the command grandchild must not outlive the Host process; started=${JSON.stringify(processStarted)} killedAt=${killedAt} hostPid=${hostProcess.child.pid} hostSignal=${hostProcess.child.signalCode} stderr=${hostProcess.stderr()}`);

      await delay(10_500);
      restarted = spawnHost(projectDirectory, sessionDirectory, config.model.baseURL);
      await restarted.client.request('session.open', { projectRoot: projectDirectory, sessionId });
      const status = await restarted.client.request('execution.status', { sessionId, runId, executionId }) as Record<string, unknown>;
      assert.equal(status.state, 'unknown');
      assert.equal(status.errorCode, 'execution_result_unknown');
      assert.equal(status.cancelRequested, false, 'recovery does not reconnect to or kill a PID');
      const logs = await restarted.client.request('execution.logs', { sessionId, runId, executionId }) as Record<string, unknown>;
      assert.equal(logs.available, false);
      assert.equal(logs.unavailableReason, 'host_interrupted');
    } catch (error) {
      throw new Error(`finite command Host crash scenario failed; stderr=${hostProcess.stderr()}`, { cause: error });
    } finally {
      await runSettledSafe(hostProcess.child);
      if (restarted !== undefined) await runSettledSafe(restarted.child);
    }
  }, {
    providerReply: () => providerStep++ === 0
      ? { toolCalls: [{ tool: 'exec', args: { command: 'node ' + JSON.stringify(commandPath.replaceAll('\\', '/')), waitMs: 0 } }] }
      : { text: 'Host crash lifecycle observed' },
    permissionControl: true,
    testDirectory: join(process.cwd(), 'testplace', 'tmp'),
  });
});

async function runSettledSafe(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await Promise.race([exited, delay(5_000)]);
}
