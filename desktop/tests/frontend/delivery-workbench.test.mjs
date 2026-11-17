import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPermissionContext } from '../../../core/dist/kernel/permission.js';
import { withTuiHost } from '../../../core/tests/helpers/tui-host.ts';

const playwrightModule = process.env.LIGULE_PLAYWRIGHT_MODULE;
const browserExecutable = process.env.LIGULE_BROWSER_EXE;
const skipReason = playwrightModule === undefined || browserExecutable === undefined
  ? 'Set LIGULE_PLAYWRIGHT_MODULE and LIGULE_BROWSER_EXE to run the optional Desktop browser regressions.'
  : false;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const frontend = join(repositoryRoot, 'desktop', 'frontend');
const testDirectory = process.env.LIGULE_TEST_DIRECTORY ?? join(repositoryRoot, 'testplace', 'tmp');
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function runIdFor(client, sessionId, task) {
  const record = await client.request('session.read', { sessionId, limit: 200, fullResults: true });
  const event = record.events.find(item => item.kind === 'user' && item.text === task);
  assert.ok(event?.run?.runId, `accepted Run for ${task} is present in the Session`);
  return event.run.runId;
}

test('Workbench deliveries show real Run results, checks, artifacts, logs, and opt-in diagnostics', {
  skip: skipReason,
  timeout: 60_000,
}, async () => {
  let reportPath = '';
  const taskArtifact = 'delivery-artifact-task';
  const taskCheck = 'delivery-check-task';
  await withTuiHost(async ({ client, sessionId, projectDirectory, sessionDirectory, providerRequests, requests }) => {
    const releasePath = join(projectDirectory, 'release.txt');
    reportPath = join(projectDirectory, 'check-report.mjs');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(releasePath, 'release baseline\n');
    await writeFile(reportPath, [
      "process.stdout.write('LIGULE_TEST_REPORT_V1\\t{\"schema\":\"ligule-test-report\",\"version\":1,\"passed\":2,\"failed\":1,\"skipped\":0,\"todo\":0}\\n');",
      "process.stderr.write('delivery check warning\\n');",
    ].join('\n'));
    git(projectDirectory, 'init', '--quiet');
    git(projectDirectory, 'config', 'user.name', 'Ligule delivery test');
    git(projectDirectory, 'config', 'user.email', 'ligule-delivery-test@example.invalid');
    git(projectDirectory, 'add', '--', 'release.txt');
    git(projectDirectory, '-c', 'user.name=Ligule delivery test', '-c', 'user.email=ligule-delivery-test@example.invalid',
      'commit', '--quiet', '-m', 'baseline');
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    client.onRequest(message => message.method === 'approval.request' ? { decision: 'allow' } : undefined);

    const artifactRun = await client.request('run.start', { sessionId, input: taskArtifact, delegation: {
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    } });
    const checkRun = await client.request('run.start', { sessionId, input: taskCheck });
    const artifactRunId = await runIdFor(client, sessionId, taskArtifact);
    const checkRunId = await runIdFor(client, sessionId, taskCheck);
    assert.notEqual(artifactRunId, checkRunId);
    assert.equal(await readFile(releasePath, 'utf8'), 'release delivered\n', 'the local deterministic Run must make the confirmed file change');
    assert.equal(typeof artifactRun, 'object');
    assert.equal(typeof checkRun, 'object');
    const providerRequestsBeforeUi = providerRequests.length;

    const preferences = await client.request('prefs.read', {});
    await client.request('prefs.write', {
      version: preferences.version,
      json: JSON.stringify({ ...preferences.settings, language: 'zh',
        lastSession: { id: sessionId, projectRoot: projectDirectory } }),
    });
    const preferencesBeforeWorkbench = await client.request('prefs.read', {});
    const preferenceBytesBeforeWorkbench = Buffer.byteLength(JSON.stringify(preferencesBeforeWorkbench.settings), 'utf8');
    const sourceSessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    const sourceSessionBytesBeforeWorkbench = await readFile(sourceSessionPath);
    const sourceEventsBeforeWorkbench = await client.request('session.read', { sessionId, fullResults: true });

    const requireFrontend = createRequire(join(frontend, 'package.json'));
    const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    const entryPath = join(frontend, '__delivery-workbench-entry.tsx').replaceAll('\\', '/');
    const entry = `
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import './src/styles.css';
let deliver;
const transport = {
  send(raw) {
    const request = JSON.parse(raw);
    window.hostCall(request.method, request.params).then(
      result => deliver(JSON.stringify({ id: request.id, result })),
      error => deliver(JSON.stringify({ id: request.id, error: { code: error?.code ?? error?.message ?? 'host_request_failed' } })),
    );
  },
  onFrame(handle) { deliver = handle; },
  onLog() {},
  defaultWorkspace: async () => window.projectRoot(),
};
createRoot(document.getElementById('root')).render(<App transport={transport} />);
`;
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__delivery-workbench-entry.tsx"></script></body></html>';
    const vite = await createServer({
      root: frontend,
      configFile: join(frontend, 'vite.config.ts'),
      server: { port: 5188, strictPort: false, host: '127.0.0.1' },
      plugins: [{
        name: 'delivery-workbench-entry',
        enforce: 'pre',
        resolveId(id) { return id === '/__delivery-workbench-entry.tsx' ? entryPath : undefined; },
        load(id) { return id === entryPath ? entry : undefined; },
        configureServer(server) {
          server.middlewares.use('/__delivery-workbench', async (_request, response, next) => {
            try {
              response.setHeader('content-type', 'text/html');
              response.end(await server.transformIndexHtml('/__delivery-workbench', html));
            } catch (error) { next(error); }
          });
        },
      }],
    });
    const browserDirectory = await mkdtemp(join(testDirectory, 'delivery-workbench-browser-'));
    let context;
    try {
      await vite.listen();
      context = await chromium.launchPersistentContext(browserDirectory, { headless: true, executablePath: browserExecutable });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(10_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeBinding('hostCall', (_source, method, params) => client.request(method, params));
      await page.exposeBinding('projectRoot', () => projectDirectory);
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__delivery-workbench`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '工作台' }).click();
      await page.getByRole('button', { name: '交付' }).click();
      await page.getByRole('region', { name: '交付与检查' }).waitFor();
      await page.getByRole('button', { name: /delivery-check-task/u }).click();
      await page.getByText('reported_fail', { exact: false }).waitFor();
      assert.match(await page.getByRole('region', { name: '运行详情' }).innerText(), /已完成/);
      assert.match(await page.getByRole('region', { name: '运行详情' }).innerText(), /reported_fail/);
      assert.match(await page.getByRole('region', { name: '运行详情' }).innerText(), /未请求结构化输出/);
      await page.getByRole('button', { name: '读取检查输出' }).click();
      await page.locator('.delivery-check-log').filter({ hasText: 'delivery check warning' }).waitFor();
      await page.getByRole('button', { name: '在工作台查看检查' }).click();
      await page.getByRole('region', { name: '检查详情' }).waitFor();
      await page.locator('.delivery-check-log').filter({ hasText: 'delivery check warning' }).waitFor();
      await page.getByRole('button', { name: /跳到检查事件/u }).click();
      await page.locator('.row-flash').waitFor();
      await page.getByRole('tab', { name: '交付', exact: true }).click();
      await page.getByRole('button', { name: /delivery-artifact-task/u }).click();
      await page.getByText('结构化输出合格').waitFor();
      assert.equal(requests.filter(request => request.method === 'run.result' && request.params.runId === artifactRunId).length >= 2, true,
        'a large result must be read using Host pages');
      await page.locator('.delivery-artifacts').getByRole('button', { name: /来源事件/u }).click();
      await page.locator('.row-flash').waitFor();
      await page.getByRole('button', { name: '项目差异' }).first().click();
      await page.locator('.project-git-panel').waitFor();
      await page.getByRole('list', { name: '改动文件' }).getByText('release.txt').waitFor();
      await page.getByRole('list', { name: '改动文件' }).getByRole('button', { name: 'release.txt' }).click();
      await page.locator('.project-git-patches').waitFor();
      await page.getByRole('tab', { name: '交付', exact: true }).click();
      await page.getByRole('button', { name: '验证与预览' }).click();
      const artifactDetail = page.getByRole('region', { name: '交付物详情' });
      await artifactDetail.getByRole('button', { name: '检查并预览' }).waitFor();
      await artifactDetail.getByRole('button', { name: '检查并预览' }).click();
      await artifactDetail.locator('.file-delivery').getByText('release delivered').waitFor();
      await artifactDetail.getByRole('button', { name: /打开文件/u }).click();
      await page.locator('[data-file-preview]').filter({ hasText: 'release delivered' }).waitFor();

      const beforeDiagnostics = requests.filter(request => request.method === 'usage.diagnostics').map(request => request.params.action);
      await page.getByRole('tab', { name: '交付', exact: true }).click();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.delivery-runs li').length === 2);
      assert.equal(await page.locator('.delivery-runs li').count(), 2, 'refresh keeps the two recorded Run receipts without duplicates');
      await page.getByRole('button', { name: '上下文诊断' }).click();
      await page.getByText('上下文与压缩').waitFor();
      await page.getByText('请求构成诊断').waitFor();
      const afterDiagnostics = requests.filter(request => request.method === 'usage.diagnostics').map(request => request.params.action);
      assert.ok(afterDiagnostics.includes('read'));
      assert.equal(afterDiagnostics.includes('enable'), false, 'opening diagnostics must not enable request collection');
      assert.ok(afterDiagnostics.length >= beforeDiagnostics.length);
      assert.equal(providerRequests.length, providerRequestsBeforeUi, 'Workbench delivery and diagnostics add no model calls');
      const requestsByMethod = Object.fromEntries([...new Set(requests.map(request => request.method))]
        .sort().map(method => [method, requests.filter(request => request.method === method).length]));
      assert.ok((requestsByMethod['run.receipts'] ?? 0) >= 1);
      assert.ok((requestsByMethod['artifact.inspect'] ?? 0) >= 1);
      assert.ok((requestsByMethod['artifact.preview'] ?? 0) >= 1);
      assert.ok((requestsByMethod['project.git.status'] ?? 0) >= 1);
      assert.ok((requestsByMethod['project.git.diff'] ?? 0) >= 1);
      const preferencesAfterWorkbench = await client.request('prefs.read', {});
      const preferenceBytesAfterWorkbench = Buffer.byteLength(JSON.stringify(preferencesAfterWorkbench.settings), 'utf8');
      assert.ok(preferenceBytesAfterWorkbench < 64 * 1024, 'Workbench preferences remain bounded');
      assert.equal(JSON.stringify(preferencesAfterWorkbench.settings).includes('A'.repeat(256)), false,
        'Run output is not persisted in Workbench preferences');
      const sourceSessionBytesAfterWorkbench = await readFile(sourceSessionPath);
      assert.deepEqual(sourceSessionBytesAfterWorkbench, sourceSessionBytesBeforeWorkbench,
        'opening delivery and diagnostics does not append to the source Session');
      const sourceEventsAfterWorkbench = await client.request('session.read', { sessionId, fullResults: true });
      assert.equal(sourceEventsAfterWorkbench.events.length, sourceEventsBeforeWorkbench.events.length);
      console.log(JSON.stringify({
        providerRequests: providerRequests.length,
        requestsByMethod,
        sourceSessionEvents: sourceEventsBeforeWorkbench.events.length,
        sourceSessionJsonlBytes: sourceSessionBytesBeforeWorkbench.byteLength,
        preferenceBytesBeforeWorkbench,
        preferenceBytesAfterWorkbench,
      }));
      assert.deepEqual(errors, []);
    } finally {
      await context?.close();
      await vite.close();
      await rm(browserDirectory, { recursive: true, force: true });
    }
  }, {
    providerReply: body => {
      const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user');
      const task = body.messages[lastUserIndex]?.content;
      const toolResults = body.messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool').length;
      if (task === taskArtifact) {
        if (toolResults === 0) return { toolCalls: [{ tool: 'read', args: { path: 'release.txt' } }] };
        if (toolResults === 1) return { toolCalls: [{ tool: 'write', args: { path: 'release.txt', content: 'release delivered\n' } }] };
        if (toolResults === 2) return { toolCalls: [{ tool: 'present', args: { files: [{ path: 'release.txt', description: 'delivery report' }] } }] };
        if (toolResults === 3) return { toolCalls: [{ tool: 'ligule_delegation_result', args: { result: { summary: 'release delivered · ' + 'A'.repeat(9_000) } } }] };
        return { text: 'Artifact delivery completed.\n' + 'A'.repeat(9_000) };
      }
      if (task === taskCheck) {
        if (toolResults === 0) return { toolCalls: [{ tool: 'exec', args: {
          command: 'node check-report.mjs', cwd: '.', waitMs: 30_000,
          check: { name: 'delivery tests', purpose: 'check the release file', expectedExitCodes: [0],
            scope: ['release.txt'], report: { format: 'ligule-test-report-v1' } },
        } }] };
        return { text: 'Check run completed.' };
      }
      return { text: 'unrelated fixture reply' };
    },
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 16 } },
    testDirectory,
  });
});
