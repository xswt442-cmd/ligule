import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
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

function within(promise, label, timeoutMs = 8_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not happen within ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

test('background steering clears only its sent session draft and preserves another session draft', {
  skip: skipReason,
  timeout: 40_000,
}, async () => {
  let releaseProvider;
  let reportProviderStarted;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const providerStarted = new Promise((resolve) => { reportProviderStarted = resolve; });
  let providerRequests = 0;
  await withTuiHost(async ({ client, sessionId, projectDirectory }) => {
    const second = await client.request('session.create', { projectRoot: projectDirectory, workspaceOrigin: 'explicit' });
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    await client.request('session.label', { sessionId, name: 'SESSION_A' });
    await client.request('session.label', { sessionId: second.sessionId, name: 'SESSION_B' });
    const preferences = await client.request('prefs.read', {});
    const current = preferences.settings;
    await client.request('prefs.write', {
      version: preferences.version,
      json: JSON.stringify({
        ...current,
        language: 'en',
        projects: [...new Set([...(current.projects ?? []), projectDirectory])],
        lastSession: { id: sessionId, projectRoot: projectDirectory },
      }),
    });

    let releaseSteeringReply;
    let reportSteeringAccepted;
    let reportBackgroundDraftSaved;
    let reportSentDraftCleared;
    const steeringReplyGate = new Promise((resolve) => { releaseSteeringReply = resolve; });
    const steeringAccepted = new Promise((resolve) => { reportSteeringAccepted = resolve; });
    const backgroundDraftSaved = new Promise((resolve) => { reportBackgroundDraftSaved = resolve; });
    const sentDraftCleared = new Promise((resolve) => { reportSentDraftCleared = resolve; });
    let sawBackgroundDraft = false;
    let sawClearedDraft = false;
    const hostCall = async (method, params) => {
      const result = await client.request(method, params);
      if (method === 'run.steer' && params.sessionId === sessionId) {
        reportSteeringAccepted();
        await steeringReplyGate;
      }
      if (method === 'prefs.write') {
        const saved = JSON.parse(params.json);
        const drafts = saved.drafts?.[projectDirectory] ?? {};
        if (drafts[second.sessionId] === 'draft from B' && !sawBackgroundDraft) {
          sawBackgroundDraft = true;
          reportBackgroundDraftSaved();
        }
        if (drafts[second.sessionId] === 'draft from B' && drafts[sessionId] === undefined && !sawClearedDraft) {
          sawClearedDraft = true;
          reportSentDraftCleared();
        }
      }
      return result;
    };

    const requireFrontend = createRequire(join(frontend, 'package.json'));
    const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    const entryPath = join(frontend, '__session-draft-steering-entry.tsx').replaceAll('\\', '/');
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
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__session-draft-steering-entry.tsx"></script></body></html>';
    const vite = await createServer({
      root: frontend,
      configFile: join(frontend, 'vite.config.ts'),
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
      plugins: [{
        name: 'session-draft-steering-entry',
        enforce: 'pre',
        resolveId(id) { return id === '/__session-draft-steering-entry.tsx' ? entryPath : undefined; },
        load(id) { return id === entryPath ? entry : undefined; },
        configureServer(server) {
          server.middlewares.use('/__session-draft-steering', async (_request, response, next) => {
            try {
              response.setHeader('content-type', 'text/html');
              response.end(await server.transformIndexHtml('/__session-draft-steering', html));
            } catch (error) { next(error); }
          });
        },
      }],
    });
    let context;
    let runningRunId;
    try {
      await vite.listen();
      context = await chromium.launchPersistentContext(join(testDirectory, `session-draft-${Date.now()}`), {
        headless: true,
        executablePath: browserExecutable,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(12_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.exposeBinding('hostCall', (_source, method, params) => hostCall(method, params));
      await page.exposeBinding('projectRoot', () => projectDirectory);
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__session-draft-steering`, { waitUntil: 'domcontentloaded' });
      const input = page.locator('.composer-input');
      await page.getByRole('button', { name: 'SESSION_A' }).waitFor();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });

      await input.fill('task in A');
      await page.getByRole('button', { name: 'Send' }).click();
      await within(providerStarted, 'initial provider request');
      const status = await client.request('status.get', { sessionId });
      runningRunId = status.activeRunId;
      assert.equal(typeof runningRunId, 'string');

      await input.fill('steer sent from A');
      await page.getByRole('button', { name: 'Active run' }).click();
      await within(steeringAccepted, 'steering acceptance');
      await page.getByRole('button', { name: 'SESSION_B' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      await input.fill('draft from B');
      await within(backgroundDraftSaved, 'background draft persistence');

      releaseSteeringReply();
      await within(sentDraftCleared, 'sent draft persistence');
      assert.equal(await input.inputValue(), 'draft from B', 'the response for A does not change B');
      await page.getByRole('button', { name: 'SESSION_A' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), '', 'A does not restore the already-sent draft');
      await page.getByRole('button', { name: 'SESSION_B' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), 'draft from B', 'B retains its own unsent draft');
      assert.deepEqual(errors, []);
    } finally {
      releaseProvider();
      releaseSteeringReply?.();
      if (runningRunId !== undefined) await client.request('run.wait', { sessionId, runId: runningRunId }).catch(() => undefined);
      await context?.close();
      await vite.close();
    }
  }, {
    beforeResponse: async () => {
      providerRequests += 1;
      if (providerRequests === 1) {
        reportProviderStarted();
        await providerGate;
      }
    },
    permission: fullAccess,
    permissionControl: true,
    testDirectory,
  });
});
