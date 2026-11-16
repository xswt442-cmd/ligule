import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPermissionContext } from '../../../core/dist/kernel/permission.js';
import { waitFor, withTuiHost } from '../../../core/tests/helpers/tui-host.ts';

const playwrightModule = process.env.LIGULE_PLAYWRIGHT_MODULE;
const browserExecutable = process.env.LIGULE_BROWSER_EXE;
const skipReason = playwrightModule === undefined || browserExecutable === undefined
  ? 'Set LIGULE_PLAYWRIGHT_MODULE and LIGULE_BROWSER_EXE to run the optional Desktop browser regressions.'
  : false;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const frontend = join(repositoryRoot, 'desktop', 'frontend');
const testDirectory = join(repositoryRoot, 'testplace', 'tmp');
const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

function gatedChildProvider(childCount = 1) {
  let release;
  let markStarted;
  let parentStartSent = false;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  return {
    release,
    started,
    options: {
      beforeResponse: async (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        if (lastUser === 'panel-child-pending') {
          markStarted();
          await gate;
        }
      },
      providerReply: (body) => {
        const lastUser = [...body.messages].reverse().find((message) => message.role === 'user')?.content;
        const tools = new Set(body.tools?.map((tool) => tool.function.name));
        if (lastUser === 'panel-parent-start-child' && tools.has('subagent_start') && !parentStartSent) {
          parentStartSent = true;
          return { toolCalls: Array.from({ length: childCount }, (_value, index) => ({
            tool: 'subagent_start',
            args: { task: index === 0 ? 'panel-child-pending' : `panel-child-complete-${index}` },
          })) };
        }
        return { text: 'completed this safe step' };
      },
    },
  };
}

function branchesFrom(events, parentRunId) {
  return events.flatMap((event) => {
    if (event.kind !== 'tool' || event.tool !== 'subagent_start') return [];
    const content = typeof event.result?.content === 'object' && event.result.content !== null
      ? event.result.content : undefined;
    const parent = typeof event.runId === 'string' ? event.runId : content?.parentRunId;
    if (typeof event.seq !== 'number' || parent !== parentRunId || typeof content?.subrunId !== 'string'
      || typeof content.sessionId !== 'string' || typeof content.runId !== 'string') return [];
    return [{ seq: event.seq, parentRunId: parent, subrunId: content.subrunId, sessionId: content.sessionId, runId: content.runId }];
  });
}

async function withChildRun(run, { childCount = 1 } = {}) {
  const childProvider = gatedChildProvider(childCount);
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    const submitted = await client.request('run.submit', { sessionId, input: 'panel-parent-start-child' });
    await childProvider.started;
    let branches = [];
    await waitFor(async () => {
      const record = await client.request('session.read', { sessionId, fullResults: true });
      branches = branchesFrom(record.events, submitted.runId);
      return branches.length === childCount;
    }, { within: 5_000 });
    try {
      await run({ client, sessionId, parentRunId: submitted.runId, branch: branches[0], branches });
    } finally {
      childProvider.release();
      await client.request('run.wait', { sessionId, runId: submitted.runId });
    }
  }, {
    permission: fullAccess,
    permissionControl: true,
    modeName: 'full',
    config: { policy: { mode: 'auto' }, loop: { iterations: 8, modelCalls: 16, maxConcurrentSubagents: 3 } },
    testDirectory,
    ...childProvider.options,
  });
}

async function withBranchPanel(sessionId, branch, hostCall, run) {
  const requireFrontend = createRequire(join(frontend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const entryPath = join(frontend, '__subrun-controls-entry.tsx').replaceAll('\\', '/');
  const entry = `
import { createRoot } from 'react-dom/client';
import { BranchPanel } from './src/components/BranchPanel';
import { LocaleProvider } from './src/locale';
import { createClient } from './src/protocol';
import './src/styles.css';
const fixture = await window.fixtureData();
let deliver;
let client;
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
};
client = createClient(transport);
deliver = raw => client.receive(raw);
createRoot(document.getElementById('root')).render(
  <LocaleProvider language="zh"><BranchPanel client={client} sessionId={fixture.sessionId} verbosity="standard" /></LocaleProvider>,
);
`;
  const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__subrun-controls-entry.tsx"></script></body></html>';
  const vite = await createServer({
    root: frontend,
    configFile: join(frontend, 'vite.config.ts'),
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    plugins: [{
      name: 'subrun-controls-entry',
      enforce: 'pre',
      resolveId(id) { return id === '/__subrun-controls-entry.tsx' ? entryPath : undefined; },
      load(id) { return id === entryPath ? entry : undefined; },
      configureServer(server) {
        server.middlewares.use('/__subrun-controls', async (_request, response, next) => {
          try {
            response.setHeader('content-type', 'text/html');
            response.end(await server.transformIndexHtml('/__subrun-controls', html));
          } catch (error) { next(error); }
        });
      },
    }],
  });
  const browserDirectory = await mkdtemp(join(testDirectory, 'subrun-panel-browser-'));
  let context;
  try {
    await vite.listen();
    context = await chromium.launchPersistentContext(browserDirectory, { headless: true, executablePath: browserExecutable });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeBinding('fixtureData', () => ({ sessionId }));
    await page.exposeBinding('hostCall', (_source, method, params) => hostCall(method, params));
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__subrun-controls`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: `记录 ${branch.seq}` }).click();
    try {
      await page.getByRole('region', { name: '异步子任务控制' }).waitFor();
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'subrun_panel_missing'}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`);
    }
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await vite.close();
    await rm(browserDirectory, { recursive: true, force: true });
  }
}

test('opening a child Session during wait leaves the child controls usable', { skip: skipReason, timeout: 30_000 }, async () => {
  await withChildRun(async ({ client, sessionId, parentRunId, branch }) => {
    let markWaitStarted;
    let markWaitFinished;
    const waitStarted = new Promise((resolve) => { markWaitStarted = resolve; });
    const waitFinished = new Promise((resolve) => { markWaitFinished = resolve; });
    const hostCall = async (method, params) => {
      if (method === 'subrun.wait') markWaitStarted();
      try { return await client.request(method, params); }
      finally { if (method === 'subrun.wait') markWaitFinished(); }
    };

    await withBranchPanel(sessionId, branch, hostCall, async (page) => {
      await page.getByRole('button', { name: '等待最多 30 秒' }).click();
      await waitStarted;
      await page.getByRole('button', { name: `记录 ${branch.seq}` }).click();
      await page.getByRole('heading', { name: `子任务 ${branch.sessionId}` }).waitFor();
      await client.request('subrun.cancel', {
        sessionId, parentRunId, subrunId: branch.subrunId, runId: branch.runId,
      });
      await waitFinished;
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent === '刷新状态');
        return button !== undefined && !button.disabled;
      });
      assert.equal(await page.getByRole('button', { name: '刷新状态' }).isEnabled(), true,
        'loading a child transcript must not leave the independent control action busy');
    });
  });
});

test('typing a new child message during send preserves that unsent draft', { skip: skipReason, timeout: 30_000 }, async () => {
  await withChildRun(async ({ client, sessionId, branch }) => {
    let markMessageAccepted;
    let releaseMessageReply;
    const messageAccepted = new Promise((resolve) => { markMessageAccepted = resolve; });
    const messageReply = new Promise((resolve) => { releaseMessageReply = resolve; });
    const hostCall = async (method, params) => {
      const result = await client.request(method, params);
      if (method === 'subrun.message') {
        markMessageAccepted();
        await messageReply;
      }
      return result;
    };

    await withBranchPanel(sessionId, branch, hostCall, async (page) => {
      try {
        const input = page.getByRole('textbox', { name: '补充输入' });
        await input.fill('first message');
        await page.locator('section[aria-label="异步子任务控制"] form button[type="submit"]').click();
        await messageAccepted;
        await input.fill('new message while first waits');
        assert.equal(await input.inputValue(), 'new message while first waits');
        releaseMessageReply();
        await page.getByText('补充输入已接受。').waitFor();
        assert.equal(await input.inputValue(), 'new message while first waits',
          'accepting the sent message must not erase text entered while the request was pending');
      } finally {
        releaseMessageReply();
      }
    });
  });
});

test('refreshing one child preserves its newer status and another child first status read', { skip: skipReason, timeout: 30_000 }, async () => {
  await withChildRun(async ({ client, sessionId, parentRunId, branches, branch }) => {
    const other = branches[1];
    assert.ok(other);
    let markOtherStatusStarted;
    let releaseOtherStatus;
    const otherStatusStarted = new Promise((resolve) => { markOtherStatusStarted = resolve; });
    const otherStatusGate = new Promise((resolve) => { releaseOtherStatus = resolve; });
    let held = false;
    let branchStatusReads = 0;
    const hostCall = async (method, params) => {
      if (method === 'subrun.status' && params.subrunId === other.subrunId && !held) {
        held = true;
        markOtherStatusStarted();
        await otherStatusGate;
      }
      const result = await client.request(method, params);
      if (method === 'subrun.status' && params.subrunId === branch.subrunId) {
        branchStatusReads += 1;
        return { ...result, state: branchStatusReads === 1 ? 'completed' : 'running' };
      }
      return result;
    };
    try {
      await withBranchPanel(sessionId, branch, hostCall, async (page) => {
        await otherStatusStarted;
        const otherRow = () => page.locator('li').filter({ has: page.getByRole('button', { name: `记录 ${other.seq}` }) });
        assert.match(await otherRow().innerText(), /读取状态中/);
        assert.equal(branchStatusReads, 1, 'A initial status response has returned as completed while B is still pending');
        await page.getByRole('button', { name: '刷新状态' }).click();
        await page.waitForFunction((seq) => [...document.querySelectorAll('li')].some((row) =>
          row.querySelector('button')?.textContent === `记录 ${seq}` && row.textContent?.includes('running')),
        branch.seq);
        releaseOtherStatus();
        await page.waitForFunction((seq) => [...document.querySelectorAll('li')].some((row) =>
          row.querySelector('button')?.textContent === `记录 ${seq}` && row.textContent?.includes('completed')),
        other.seq);
        assert.match(await otherRow().innerText(), /completed/);
        await page.waitForFunction((seq) => [...document.querySelectorAll('li')].some((row) =>
          row.querySelector('button')?.textContent === `记录 ${seq}` && row.textContent?.includes('running')),
        branch.seq);
      });
    } finally {
      releaseOtherStatus();
    }
  }, { childCount: 2 });
});

test('a failed refresh leaves an explicit status when another child first read is pending', { skip: skipReason, timeout: 30_000 }, async () => {
  await withChildRun(async ({ client, sessionId, branches, branch }) => {
    const other = branches[1];
    assert.ok(other);
    let markOtherStatusStarted;
    let releaseOtherStatus;
    const otherStatusStarted = new Promise((resolve) => { markOtherStatusStarted = resolve; });
    const otherStatusGate = new Promise((resolve) => { releaseOtherStatus = resolve; });
    let held = false;
    let branchStatusReads = 0;
    const hostCall = async (method, params) => {
      if (method === 'subrun.status' && params.subrunId === other.subrunId && !held) {
        held = true;
        markOtherStatusStarted();
        await otherStatusGate;
      }
      if (method === 'subrun.status' && params.subrunId === branch.subrunId) {
        branchStatusReads += 1;
        if (branchStatusReads === 2) {
          throw Object.assign(new Error('child_status_refresh_failed'), { code: 'child_status_refresh_failed' });
        }
        const result = await client.request(method, params);
        return { ...result, state: 'completed' };
      }
      return await client.request(method, params);
    };
    try {
      await withBranchPanel(sessionId, branch, hostCall, async (page) => {
        await otherStatusStarted;
        const branchRow = () => page.locator('li').filter({ has: page.getByRole('button', { name: `记录 ${branch.seq}` }) });
        const otherRow = () => page.locator('li').filter({ has: page.getByRole('button', { name: `记录 ${other.seq}` }) });
        assert.equal(branchStatusReads, 1, 'A first status response has returned while B is still pending');
        assert.match(await otherRow().innerText(), /读取状态中/);

        await page.getByRole('button', { name: '刷新状态' }).click();
        await page.getByText('子任务操作失败：child_status_refresh_failed').waitFor();
        releaseOtherStatus();
        await page.waitForFunction((seq) => [...document.querySelectorAll('li')].some((row) =>
          row.querySelector('button')?.textContent === `记录 ${seq}` && row.textContent?.includes('completed')),
        other.seq);
        assert.match(await branchRow().innerText(), /unknown/);
        assert.match(await branchRow().innerText(), /child_status_refresh_failed/);
        assert.doesNotMatch(await branchRow().innerText(), /读取状态中/);
      });
    } finally {
      releaseOtherStatus();
    }
  }, { childCount: 2 });
});
