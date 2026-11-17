import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

test('background steering and new conversations preserve session-owned drafts', {
  skip: skipReason,
  timeout: 40_000,
}, async () => {
  let releaseProvider;
  let reportProviderStarted;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const providerStarted = new Promise((resolve) => { reportProviderStarted = resolve; });
  let providerRequestCount = 0;
  let releaseFileSave = () => {};
  let reportFileSaveStarted = () => {};
  const fileSaveGate = new Promise((resolve) => { releaseFileSave = resolve; });
  const fileSaveStarted = new Promise((resolve) => { reportFileSaveStarted = resolve; });
  let holdFileSave = false;
  const preferenceWrites = [];
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests, requests }) => {
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    const requireCore = createRequire(join(repositoryRoot, 'core', 'package.json'));
    const sharp = requireCore('sharp');
    await writeFile(join(projectDirectory, 'src', 'app.ts'), '\uFEFFexport const answer = 42;\r\n');
    await writeFile(join(projectDirectory, 'README.md'), '# Safe heading\n\n<script>window.__filePreviewExecuted = true</script>\n');
    await writeFile(join(projectDirectory, 'unsafe.html'), '<script>window.__htmlPreviewExecuted = true</script>');
    await writeFile(join(projectDirectory, 'pixel.png'), await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#4269ed' },
    }).png().toBuffer());
    git(projectDirectory, 'init', '--quiet');
    git(projectDirectory, 'config', 'user.name', 'Ligule browser test');
    git(projectDirectory, 'config', 'user.email', 'ligule-browser-test@example.invalid');
    git(projectDirectory, 'add', '--', '.');
    git(projectDirectory, '-c', 'user.name=Ligule browser test', '-c', 'user.email=ligule-browser-test@example.invalid',
      'commit', '--quiet', '-m', 'baseline');
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
      if (method === 'project.file.save' && holdFileSave) {
        holdFileSave = false;
        reportFileSaveStarted();
        await fileSaveGate;
      }
      const result = await client.request(method, params);
      if (method === 'run.steer' && params.sessionId === sessionId) {
        reportSteeringAccepted();
        await steeringReplyGate;
      }
      if (method === 'prefs.write') {
        const saved = JSON.parse(params.json);
        preferenceWrites.push(saved.drafts ?? {});
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
      server: { port: 5190, strictPort: false, host: '127.0.0.1' },
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

      await page.getByRole('button', { name: 'Workbench' }).click();
      const beforeFileBrowse = await client.request('session.read', { sessionId });
      const providerRequestsBeforeFileBrowse = providerRequests.length;
      await page.getByRole('button', { name: 'Browse files', exact: true }).click();
      const fileSearch = page.getByRole('searchbox', { name: 'Search file names' });
      await page.getByRole('button', { name: 'src', exact: true }).click();
      await page.getByRole('button', { name: 'app.ts', exact: true }).click();
      await page.locator('[data-file-preview]').getByText('export const answer = 42;').waitFor();
      assert.ok(requests.some(request => request.method === 'project.files.list' && request.params.path === 'src'),
        'the tree loads nested folders only when expanded');
      await page.getByRole('button', { name: 'Close app.ts' }).click();

      await fileSearch.fill('README.md');
      await page.getByRole('button', { name: /README\.md/u }).click();
      await page.getByRole('heading', { name: 'Safe heading' }).waitFor();
      assert.equal(await page.evaluate(() => window.__filePreviewExecuted === true), false,
        'Markdown source is parsed into safe React elements');
      await page.getByRole('button', { name: 'Close README.md' }).click();

      await fileSearch.fill('unsafe.html');
      await page.getByRole('button', { name: /unsafe\.html/u }).click();
      await page.locator('[data-file-preview]').getByText('window.__htmlPreviewExecuted = true').waitFor();
      assert.equal(await page.evaluate(() => window.__htmlPreviewExecuted === true), false,
        'HTML files are shown as source rather than executed');
      await page.getByRole('button', { name: 'Close unsafe.html' }).click();

      await fileSearch.fill('pixel.png');
      await page.getByRole('button', { name: /pixel\.png/u }).click();
      await page.getByRole('img', { name: 'pixel.png' }).waitFor();
      await page.getByRole('button', { name: 'Close pixel.png' }).click();

      await fileSearch.fill('app.ts');
      await page.getByRole('button', { name: /app\.ts/u }).click();
      await page.locator('.project-file-source').getByText('export const answer = 42;').waitFor();
      await page.getByRole('button', { name: 'Edit file' }).click();
      const editor = page.locator('.project-code-editor .cm-content');
      await editor.waitFor();
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('// first edit');
      await page.getByRole('button', { name: 'Undo edit' }).click();
      assert.doesNotMatch(await editor.innerText(), /first edit/u);
      await page.getByRole('button', { name: 'Redo edit' }).click();
      assert.match(await editor.innerText(), /first edit/u);
      await page.getByRole('button', { name: 'Find in file' }).click();
      const searchPanel = page.locator('.cm-search');
      await searchPanel.waitFor();
      await searchPanel.locator('input').first().fill('answer');
      await page.keyboard.press('Escape');
      holdFileSave = true;
      await page.getByRole('button', { name: 'Save file' }).click();
      await within(fileSaveStarted, 'project file save request');
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('// second edit');
      releaseFileSave();
      await page.getByText('Saved; newer edits remain unsaved').waitFor();
      const savedFirstRevision = await readFile(join(projectDirectory, 'src', 'app.ts'), 'utf8');
      assert.ok(savedFirstRevision.startsWith('\uFEFF'), 'the UTF-8 BOM is preserved');
      assert.ok(savedFirstRevision.includes('\r\n\r\n// first edit'), 'the inserted line uses the file CRLF separator');
      assert.equal(savedFirstRevision.replaceAll('\r\n', '').includes('\n'), false, 'the save contains no bare LF');
      assert.equal(savedFirstRevision.replaceAll('\r\n', '').includes('\r'), false, 'the save contains no bare CR');
      assert.doesNotMatch(savedFirstRevision, /second edit/u, 'the earlier save does not overwrite newer editor input');
      await waitFor(async () => {
        const stored = await client.request('prefs.read', {});
        const fileTab = stored.settings.workbench?.tabs?.find(tab => tab.resource?.kind === 'file' && tab.resource.path === 'src/app.ts');
        return fileTab?.fileDraft?.text.includes('// second edit') === true;
      }, { within: 5_000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.project-code-editor .cm-content').waitFor();
      assert.match(await page.locator('.project-code-editor .cm-content').innerText(), /second edit/u,
        'the unsaved file draft is restored after the App reloads');
      await page.getByRole('button', { name: 'Save file' }).click();
      await page.getByText('Saved to disk').waitFor();
      const savedLatestRevision = await readFile(join(projectDirectory, 'src', 'app.ts'), 'utf8');
      assert.ok(savedLatestRevision.includes('\r\n\r\n// first edit\r\n// second edit'));
      assert.equal(savedLatestRevision.replaceAll('\r\n', '').includes('\n'), false);
      assert.equal(savedLatestRevision.replaceAll('\r\n', '').includes('\r'), false);
      const savedHistory = await client.request('session.read', { sessionId });
      assert.equal(savedHistory.events.filter(event => event.kind === 'workspaceFileChange').length, 2);

      await writeFile(join(projectDirectory, 'src', 'app.ts'), '\uFEFFexport const answer = 7;\r\n');
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('// keep this conflicting draft');
      await page.getByRole('button', { name: 'Save file' }).click();
      await page.getByRole('alert').filter({ hasText: 'Save failed; the draft was preserved.' }).waitFor();
      await page.getByRole('button', { name: 'Discard stale draft' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save file' }).isDisabled(), true);
      assert.match(await editor.innerText(), /keep this conflicting draft/u);
      await page.getByRole('button', { name: 'Discard stale draft' }).click();
      const refreshedEditor = page.locator('.project-code-editor .cm-content');
      await waitFor(async () => (await refreshedEditor.innerText()).includes('answer = 7'));
      const afterConflict = await client.request('session.read', { sessionId });
      assert.equal(afterConflict.events.filter(event => event.kind === 'workspaceFileChange').length, 2,
        'a conflicted save neither overwrites the external edit nor records a successful change');
      const gitAfterConflict = await client.request('project.git.status', { sessionId });
      assert.equal(gitAfterConflict.state, 'ready');
      assert.ok(gitAfterConflict.files.some(file => file.path === 'src/app.ts' && file.unstaged));
      await page.getByRole('button', { name: 'Close app.ts' }).click();
      await page.getByRole('button', { name: 'Close Files' }).click();
      await page.getByRole('button', { name: 'Workbench' }).click();
      const afterFileBrowse = await client.request('session.read', { sessionId });
      assert.equal(afterFileBrowse.events.length, afterConflict.events.length,
        'opening and reading project files does not add Session events');
      assert.equal(providerRequests.length, providerRequestsBeforeFileBrowse,
        'project file browsing does not call the model');
      assert.ok(requests.some(request => request.method === 'project.files.list'));
      assert.ok(requests.some(request => request.method === 'project.files.search'));
      assert.ok(requests.some(request => request.method === 'project.file.read'));

      await page.getByRole('button', { name: 'Project changes' }).click();
      await page.locator('.project-git-panel').waitFor();
      await page.locator('.project-git-files').waitFor();
      const gitFile = page.locator('.project-git-files').getByRole('button', { name: /app\.ts/u });
      assert.equal(await gitFile.count(), 1, `Git panel contents: ${await page.locator('.project-git-panel').innerText()}`);
      await gitFile.click();
      await page.locator('.project-git-patches pre').getByText(/answer = 7/u).waitFor();
      await page.getByText('Desktop save', { exact: false }).first().waitFor();
      assert.ok(requests.some(request => request.method === 'project.git.status'));
      assert.ok(requests.some(request => request.method === 'project.git.diff'));
      assert.equal(providerRequests.length, providerRequestsBeforeFileBrowse,
        'Git and P13 change views do not call the model');
      const afterGitRead = await client.request('session.read', { sessionId });
      assert.equal(afterGitRead.events.length, afterConflict.events.length,
        'Git and P13 change views do not append Session events');
      await page.getByRole('button', { name: 'Close Project changes' }).click();
      await page.getByRole('button', { name: 'Workbench' }).click();

      await page.getByRole('button', { name: 'Subtasks', exact: true }).click();
      await page.getByRole('button', { name: 'Help', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Diagnostics', exact: true }).click();
      const subtasksTab = page.getByRole('tab', { name: 'Subtasks' });
      const diagnosticsTab = page.getByRole('tab', { name: 'Diagnostics' });
      await diagnosticsTab.waitFor();
      assert.equal(await diagnosticsTab.getAttribute('aria-selected'), 'true');
      await subtasksTab.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await diagnosticsTab.getAttribute('aria-selected'), 'true');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await subtasksTab.getAttribute('aria-selected'), 'true');
      await page.keyboard.press('ArrowRight');
      assert.equal(await diagnosticsTab.getAttribute('aria-selected'), 'true');
      await page.getByRole('button', { name: 'Command workspace' }).click();
      await page.getByRole('region', { name: 'Command workspace' }).waitFor();
      const welcomeBounds = await page.getByRole('heading', { name: 'Start with an idea' }).boundingBox();
      const composerBounds = await page.locator('.composer').boundingBox();
      assert.ok(welcomeBounds !== null && composerBounds !== null && welcomeBounds.y + welcomeBounds.height <= composerBounds.y,
        JSON.stringify({ welcomeBounds, composerBounds }));
      if (process.env.LIGULE_TEST_SCREENSHOT_PATH !== undefined) {
        await page.screenshot({ path: process.env.LIGULE_TEST_SCREENSHOT_PATH, fullPage: true });
      }
      const dockBefore = await page.locator('.workbench-dock').boundingBox();
      const dockHandle = await page.getByRole('separator', { name: 'Workbench width' }).boundingBox();
      assert.ok(dockBefore !== null && dockHandle !== null);
      await page.mouse.move(dockHandle.x + dockHandle.width / 2, dockHandle.y + 20);
      await page.mouse.down();
      await page.mouse.move(dockHandle.x - 50, dockHandle.y + 20);
      await page.mouse.up();
      const dockAfter = await page.locator('.workbench-dock').boundingBox();
      assert.ok(dockAfter !== null && dockAfter.width > dockBefore.width + 20, JSON.stringify({ dockBefore, dockAfter }));

      const commandBefore = await page.locator('.bottom-workbench').boundingBox();
      const commandHandle = await page.getByRole('separator', { name: 'Command workspace height' }).boundingBox();
      assert.ok(commandBefore !== null && commandHandle !== null);
      await page.mouse.move(commandHandle.x + 20, commandHandle.y + commandHandle.height / 2);
      await page.mouse.down();
      await page.mouse.move(commandHandle.x + 20, commandHandle.y - 40);
      await page.mouse.up();
      const commandAfter = await page.locator('.bottom-workbench').boundingBox();
      assert.ok(commandAfter !== null && commandAfter.height > commandBefore.height + 20,
        JSON.stringify({ commandBefore, commandAfter }));
      await page.getByRole('button', { name: 'Hide command workspace' }).click();
      await page.getByRole('button', { name: 'Hide workbench' }).waitFor();
      await subtasksTab.click();
      assert.equal(await subtasksTab.getAttribute('aria-selected'), 'true');
      await page.getByRole('button', { name: 'Hide workbench' }).click();
      await page.getByRole('button', { name: 'Workbench' }).click();
      assert.equal(await subtasksTab.getAttribute('aria-selected'), 'true');
      assert.equal(await diagnosticsTab.getAttribute('aria-selected'), 'false');
      await diagnosticsTab.click();
      await page.getByRole('button', { name: 'Close Diagnostics' }).click();
      await page.getByRole('button', { name: 'Hide workbench' }).click();
      await waitFor(async () => {
        const saved = await client.request('prefs.read', {});
        const tabs = saved.settings.workbench?.tabs ?? [];
        return tabs.length === 1 && tabs[0].title === 'Subtasks'
          && tabs[0].resource.sessionId === sessionId && saved.settings.workbench.rightOpen === false
          && saved.settings.workbench.rightWidth > 440 && saved.settings.workbench.bottomHeight > 240
          && saved.settings.workbench.bottomOpen === false;
      }, { within: 5_000 });
      await page.setViewportSize({ width: 700, height: 720 });
      await page.getByRole('button', { name: 'Workbench' }).click();
      const narrowDock = await page.locator('.workbench-dock').boundingBox();
      assert.ok(narrowDock !== null && narrowDock.width > 0 && narrowDock.width <= 700, JSON.stringify(narrowDock));
      await page.getByRole('button', { name: 'Hide workbench' }).click();
      await page.setViewportSize({ width: 1280, height: 720 });

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
      try { await within(sentDraftCleared, 'sent draft persistence'); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; writes=${JSON.stringify(preferenceWrites)}`); }
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

      const savedDraft = async (id) => {
        const preferences = await client.request('prefs.read', {});
        return preferences.settings.drafts?.[projectDirectory]?.[id];
      };
      const waitForDraft = async (id, expected) => await waitFor(async () => await savedDraft(id) === expected, { within: 5_000 });
      await page.getByRole('button', { name: 'SESSION_A' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      await input.fill('A draft survives new sessions');
      await waitForDraft(sessionId, 'A draft survives new sessions');

      const newConversation = page.locator('button.new-run');
      await newConversation.click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), '', 'an absent $new draft opens empty');
      await page.getByRole('button', { name: 'SESSION_A' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), 'A draft survives new sessions', 'opening a blank new conversation leaves A unchanged');

      await newConversation.click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      await input.fill('saved $new draft');
      await waitForDraft('$new', 'saved $new draft');
      await page.getByRole('button', { name: 'SESSION_A' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), 'A draft survives new sessions');
      await newConversation.click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), 'saved $new draft', 'a saved $new draft is restored');
      await page.getByRole('button', { name: 'SESSION_A' }).click();
      await page.waitForFunction(() => {
        const field = document.querySelector('.composer-input');
        return field instanceof HTMLTextAreaElement && !field.readOnly;
      });
      assert.equal(await input.inputValue(), 'A draft survives new sessions', 'restoring $new does not replace A');
      assert.deepEqual(errors, []);
    } finally {
      releaseProvider();
      releaseSteeringReply?.();
      releaseFileSave();
      if (runningRunId !== undefined) await client.request('run.wait', { sessionId, runId: runningRunId }).catch(() => undefined);
      await context?.close();
      await vite.close();
    }
  }, {
    beforeResponse: async () => {
      providerRequestCount += 1;
      if (providerRequestCount === 1) {
        reportProviderStarted();
        await providerGate;
      }
    },
    permission: fullAccess,
    permissionControl: true,
    testDirectory,
  });
});
