import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('the command workspace keeps the source conversation unchanged and answers approval on its real owner', {
  skip: skipReason,
  timeout: 45_000,
}, async () => {
  await withTuiHost(async ({ client: initialClient, sessionId, projectDirectory, sessionDirectory, providerRequests, restart }) => {
    let client = initialClient;
    await writeFile(join(projectDirectory, 'workbench-probe.mjs'), [
      "process.stdout.write('command stdout started\\n');",
      "process.stderr.write('command stderr started\\n');",
      'for (let index = 0; index < 40; index += 1) process.stdout.write(`command-line-${index}\\n`);',
      "setInterval(() => process.stdout.write('command tick\\n'), 250);",
    ].join('\n'));
    await writeFile(join(projectDirectory, 'workbench-second.mjs'), [
      "process.stdout.write('second command only marker\\n');",
      'process.exitCode = 0;',
    ].join('\n'));
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('policy.set', { sessionId, mode: 'auto' });
    const preferences = await client.request('prefs.read', {});
    await client.request('prefs.write', {
      version: preferences.version,
      json: JSON.stringify({
        ...preferences.settings,
        language: 'zh',
        lastSession: { id: sessionId, projectRoot: projectDirectory },
        workbench: { ...preferences.settings.workbench, bottomOpen: true, bottomHeight: 300 },
      }),
    });
    const savedPreferences = await client.request('prefs.read', {});
    assert.equal(savedPreferences.settings.workbench.bottomOpen, true);
    const sourceBytesBefore = await readFile(join(sessionDirectory, `${sessionId}.jsonl`));

    const requireFrontend = createRequire(join(frontend, 'package.json'));
    const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    const entryPath = join(frontend, '__command-workbench-entry.tsx').replaceAll('\\', '/');
    const entry = `
import { createRoot } from 'react-dom/client';
import { App } from './src/App';
import './src/styles.css';
let deliver;
const transport = {
  send(raw) {
    const message = JSON.parse(raw);
    if (typeof message.method === 'string') {
      window.hostCall(message.method, message.params).then(
        result => deliver(JSON.stringify({ id: message.id, result })),
        error => deliver(JSON.stringify({ id: message.id, error: { code: error?.code ?? error?.message ?? 'host_request_failed' } })),
      );
    } else if (typeof message.id === 'string' && Object.hasOwn(message, 'result')) {
      window.hostReply(message.id, message.result);
    }
  },
  onFrame(handle) { deliver = handle; },
  onLog() {},
  defaultWorkspace: async () => window.projectRoot(),
};
window.deliverHostFrame = frame => deliver(JSON.stringify(frame));
createRoot(document.getElementById('root')).render(<App transport={transport} />);
`;
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__command-workbench-entry.tsx"></script></body></html>';
    const vite = await createServer({
      root: frontend,
      configFile: join(frontend, 'vite.config.ts'),
      server: { port: 5187, strictPort: false, host: '127.0.0.1' },
      plugins: [{
        name: 'command-workbench-entry',
        enforce: 'pre',
        resolveId(id) { return id === '/__command-workbench-entry.tsx' ? entryPath : undefined; },
        load(id) { return id === entryPath ? entry : undefined; },
        configureServer(server) {
          server.middlewares.use('/__command-workbench', async (_request, response, next) => {
            try {
              response.setHeader('content-type', 'text/html');
              response.end(await server.transformIndexHtml('/__command-workbench', html));
            } catch (error) { next(error); }
          });
        },
      }],
    });
    const browserDirectory = await mkdtemp(join(testDirectory, 'command-workbench-browser-'));
    let context;
    let page;
    const pendingApprovals = new Map();
    const approvalRequests = [];
    const bridgeApprovals = (connection) => connection.onRequest((message) => {
      if (message.method !== 'approval.request') throw new Error('unexpected_host_request');
      approvalRequests.push(message.params);
      return new Promise((resolveAnswer, rejectAnswer) => {
        pendingApprovals.set(message.id, resolveAnswer);
        if (page === undefined) {
          rejectAnswer(new Error('approval_page_not_ready'));
          return;
        }
        void page.evaluate(frame => window.deliverHostFrame(frame), message).catch(rejectAnswer);
      });
    });
    bridgeApprovals(client);
    try {
      await vite.listen();
      context = await chromium.launchPersistentContext(browserDirectory, { headless: true, executablePath: browserExecutable });
      page = await context.newPage();
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(10_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeBinding('hostCall', (_source, method, params) => client.request(method, params));
      await page.exposeBinding('hostReply', (_source, requestId, result) => {
        const resolveAnswer = pendingApprovals.get(requestId);
        if (resolveAnswer === undefined) throw new Error('approval_request_not_pending');
        pendingApprovals.delete(requestId);
        resolveAnswer(result);
      });
      await page.exposeBinding('projectRoot', () => projectDirectory);
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__command-workbench`, { waitUntil: 'domcontentloaded' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${vite.httpServer.address().port}` });
      const commandAreaToggle = page.getByRole('button', { name: '命令工作区' });
      if (await commandAreaToggle.getAttribute('aria-expanded') !== 'true') await commandAreaToggle.click();
      try { await page.getByRole('textbox', { name: '命令' }).waitFor(); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : 'command_form_missing'}\n${await page.locator('body').innerText()}`, { cause: error }); }
      await page.getByRole('textbox', { name: '工作目录' }).fill('.');
      await page.getByRole('textbox', { name: '命令' }).fill('node workbench-probe.mjs');
      await page.getByRole('button', { name: '运行命令' }).click();

      const approval = page.getByRole('region', { name: '等待审批的操作' });
      await approval.waitFor();
      assert.equal(approvalRequests.length, 1);
      assert.equal(approvalRequests[0].sourceSessionId, sessionId);
      assert.notEqual(approvalRequests[0].sessionId, sessionId,
        'the approval owner is the independent Operation Session');
      await approval.getByRole('button', { name: '允许一次' }).click();

      await page.getByRole('tab', { name: /node workbench-probe\.mjs/u }).waitFor();
      const stored = await client.request('prefs.read', {});
      const reference = stored.settings.workbench.commandTabs?.at(-1);
      assert.ok(reference?.operationSessionId);
      assert.ok(reference?.operationId);
      assert.ok(reference?.executionId);
      assert.equal(reference.sourceSessionId, sessionId);
      await page.getByText('command stdout started').waitFor();
      await page.getByText('command stderr started').waitFor();
      const logPane = page.getByRole('tabpanel', { name: '命令输出' }).locator('.command-workspace-log');
      await page.waitForFunction(() => {
        const element = document.querySelector('.command-workspace-log');
        return element !== null && element.scrollHeight > element.clientHeight && element.scrollTop > 0;
      });
      await logPane.evaluate(element => element.scrollTo({ top: 0 }));
      await page.getByRole('button', { name: '跳到末尾' }).waitFor();
      await page.waitForTimeout(1_100);
      assert.ok(await logPane.evaluate(element => element.scrollTop < 10), 'new output must not follow while the user is reading older lines');
      await page.getByRole('button', { name: '跳到末尾' }).click();
      await page.waitForFunction(() => {
        const element = document.querySelector('.command-workspace-log');
        return element !== null && element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
      });
      await page.getByRole('button', { name: '复制输出' }).click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\[stdout\].*command-line-39/s);
      assert.equal(providerRequests.length, 0);
      assert.deepEqual(await readFile(join(sessionDirectory, `${sessionId}.jsonl`)), sourceBytesBefore,
        'starting a command must not add an event to the source conversation');

      await page.getByRole('button', { name: '等待 2 秒' }).click();
      await page.getByText('等待到期，命令仍在运行。').waitFor();
      const afterWait = await client.request('execution.status', {
        sessionId: reference.operationSessionId, runId: reference.operationId, executionId: reference.executionId,
      });
      assert.equal(afterWait.state, 'running', 'a UI wait timeout must leave the process running');

      await page.getByRole('button', { name: '隐藏命令工作区' }).click();
      const running = await client.request('execution.status', {
        sessionId: reference.operationSessionId, runId: reference.operationId, executionId: reference.executionId,
      });
      assert.equal(running.state, 'running', 'hiding the command workspace must not cancel its process');
      await page.getByRole('button', { name: '命令工作区' }).click();
      await page.getByRole('button', { name: '取消命令' }).click();
      await page.getByRole('tabpanel', { name: '命令输出' }).getByText('已取消').waitFor();
      await page.getByRole('textbox', { name: '命令' }).fill('node workbench-second.mjs');
      await page.getByRole('button', { name: '运行命令' }).click();
      await page.getByRole('region', { name: '等待审批的操作' }).waitFor();
      await page.getByRole('region', { name: '等待审批的操作' }).getByRole('button', { name: '允许一次' }).click();
      const secondTab = page.getByRole('tab', { name: /node workbench-second\.mjs/u }).last();
      await secondTab.waitFor();
      await page.getByText('second command only marker').waitFor();
      const savedTwo = await client.request('prefs.read', {});
      assert.equal(savedTwo.settings.workbench.commandTabs.length, 2);
      const secondReference = savedTwo.settings.workbench.commandTabs.at(-1);
      assert.notEqual(secondReference.operationId, reference.operationId);
      const secondStatus = await client.request('execution.status', {
        sessionId: secondReference.operationSessionId, runId: secondReference.operationId, executionId: secondReference.executionId,
      });
      assert.equal(secondStatus.state, 'exited');
      assert.equal(secondStatus.exitCode, 0);
      assert.equal(approvalRequests.length, 2);
      assert.ok(approvalRequests.every(request => request.sourceSessionId === sessionId && request.sessionId !== sessionId));
      await page.getByRole('tab', { name: /node workbench-probe\.mjs/u }).click();
      const firstOutput = page.getByRole('tabpanel', { name: '命令输出' });
      await firstOutput.getByText('command stdout started').waitFor();
      assert.equal(await firstOutput.getByText('second command only marker').count(), 0,
        'switching command tabs must keep output and cursors separate');

      client = await restart();
      bridgeApprovals(client);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: /node workbench-probe\.mjs/u }).waitFor();
      await page.getByRole('tab', { name: /node workbench-second\.mjs/u }).click();
      await page.getByRole('tabpanel', { name: '命令输出' }).getByText('second command only marker').waitFor();
      const restoredFirst = await client.request('execution.status', {
        sessionId: reference.operationSessionId, runId: reference.operationId, executionId: reference.executionId,
      });
      const restoredSecond = await client.request('execution.status', {
        sessionId: secondReference.operationSessionId, runId: secondReference.operationId, executionId: secondReference.executionId,
      });
      assert.equal(restoredFirst.state, 'cancelled');
      assert.equal(restoredSecond.state, 'exited');
      assert.equal(providerRequests.length, 0);
      assert.deepEqual(await readFile(join(sessionDirectory, `${sessionId}.jsonl`)), sourceBytesBefore);
      if (process.env.LIGULE_BROWSER_SCREENSHOT !== undefined) {
        await page.screenshot({ path: process.env.LIGULE_BROWSER_SCREENSHOT, fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context?.close();
      await vite.close();
      await rm(browserDirectory, { recursive: true, force: true });
    }
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 8 } },
    testDirectory,
  });
});
