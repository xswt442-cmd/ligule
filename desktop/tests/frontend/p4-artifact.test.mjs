import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConfig, createDecisionChain, createSessionLog, createMemoryConnectionPair,
  createConnection, providerFromConfig, serveHost,
} from '../../../core/dist/index.js';
import { readFileArtifact } from '../../../core/dist/capability/artifact.js';
import { developmentCsp } from '../../electron/security.ts';

const files = [
  { name: 'report.md', body: '# First report\nVerified content.' },
  { name: 'other.md', body: '# Other report\nSecond session.' },
  { name: 'noise.png', image: true },
];
const playwrightModule = process.env.LIGULE_PLAYWRIGHT_MODULE;
const browserExecutable = process.env.LIGULE_BROWSER_EXE;
const skipReason = playwrightModule === undefined || browserExecutable === undefined
  ? 'Set LIGULE_PLAYWRIGHT_MODULE and LIGULE_BROWSER_EXE to run the optional real-host headless browser probe.'
  : false;

test('Desktop artifact card uses the real Host for preview and status transitions', { skip: skipReason }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const desktop = fileURLToPath(new URL('../../', import.meta.url));
  const frontend = join(desktop, 'frontend');
  const core = fileURLToPath(new URL('../../../core/', import.meta.url));
  const testplace = join(desktop, 'testplace');
  const requireFrontend = createRequire(join(frontend, 'package.json'));
  const requireCore = createRequire(join(core, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const sharp = requireCore('sharp');
  await mkdir(testplace, { recursive: true });
  const root = await mkdtemp(join(testplace, 'p4-artifact-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  const sessionDirectory = join(root, 'sessions');
  const previousHome = process.env.LIGULE_HOME;
  const pair = createMemoryConnectionPair();
  const sessions = files.map(() => randomUUID());
  let host;
  let vite;
  let browser;
  let releaseList;
  let listStarted;
  let holdList = false;
  let imagePreviewBytes;
  let imagePreviewBase64Length;
  const calls = [];
  try {
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot), mkdir(sessionDirectory)]);
  process.env.LIGULE_HOME = dataRoot;
  const config = createConfig({ user: {
    boundary: projectRoot, workspaceRoot: projectRoot,
    host: { sessionDirectory },
    model: { api: 'chat-completions', baseURL: 'https://unused.invalid', model: 'p4-artifact-headless' },
    policy: { mode: 'auto' },
  } });
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const content = file.image === true
      ? await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()
      : Buffer.from(file.body);
    await writeFile(join(projectRoot, file.name), content);
    if (file.image === true) {
      const metadata = await sharp(content).metadata();
      assert.equal(metadata.width, 512);
      assert.equal(metadata.height, 512);
      assert.equal(metadata.format, 'png');
    }
    const stored = await readFileArtifact({ path: file.name }, sessions[index], projectRoot, projectRoot);
    assert.equal(stored.artifact.bytes, content.byteLength);
    assert.equal(stored.artifact.mimeType, file.image === true ? 'image/png' : 'text/markdown');
    const log = createSessionLog({ directory: sessionDirectory, id: sessions[index], meta: { projectRoot } });
    await log.append({ kind: 'tool', tool: 'present', callId: `present-${index}`, args: {},
      result: { content: { artifacts: [stored.artifact] } } });
    await log.close();
  }
  host = serveHost({ ...pair.host, config, policy: createDecisionChain({ mode: 'auto' }), provider: providerFromConfig(config) });
  const client = createConnection(pair.client);

  const entry = `import { createRoot } from 'react-dom/client';
import { ResultRow } from './src/components/ResultRow';
import { createClient } from './src/protocol';
import { LocaleProvider } from './src/locale';
import './src/styles.css';
const fixture = await window.fixtureData();
let receive;
const client = createClient({
  send: text => {
    const frame = JSON.parse(text);
    window.hostCall(frame.method, frame.params).then(
      result => receive(JSON.stringify({ id: frame.id, result })),
      error => receive(JSON.stringify({ id: frame.id, error: { code: error.message } })),
    );
  },
  onFrame: handle => { receive = handle; },
  onLog: () => {},
});
receive = text => client.receive(text);
const root = createRoot(document.getElementById('root'));
window.showArtifact = index => { const item = fixture.items[index]; root.render(<LocaleProvider language="en"><ResultRow row={{ id: index + 1, kind: 'result', text: 'present', deliveries: [item.file] }} verbosity="standard" client={client} sessionId={item.sessionId} projectRoot={fixture.projectRoot} /></LocaleProvider>); };
window.showArtifact(0);`;
  const entryId = join(frontend, '__p4-artifact-entry.tsx').replaceAll('\\', '/');
  vite = await createServer({ root: frontend, configFile: join(frontend, 'vite.config.ts'),
    html: { cspNonce: `${'a'.repeat(43)}=` }, server: { port: 0, strictPort: false, host: '127.0.0.1' },
    plugins: [{ name: 'p4-artifact-fixture', enforce: 'pre',
      resolveId(id) { if (id === '/__p4-artifact-entry.tsx') return entryId; },
      load(id) { if (id === entryId) return entry; },
      configureServer(server) { server.middlewares.use('/__p4-artifact', async (_request, response, next) => {
        try { const html = await server.transformIndexHtml('/__p4-artifact', '<html><div id="root"></div><script type="module" src="/__p4-artifact-entry.tsx"></script></html>');
          response.setHeader('content-type', 'text/html'); response.setHeader('content-security-policy', developmentCsp(`${'a'.repeat(43)}=`)); response.end(html);
        } catch (error) { next(error); }
      }); },
    }] });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const items = [];
  for (let index = 0; index < files.length; index += 1) {
    const listed = await client.request('artifact.list', { projectRoot, sessionId: sessions[index] });
    assert.equal(listed.items.length, 1);
    items.push({ sessionId: sessions[index], file: listed.items[0].artifact });
  }
  await page.exposeBinding('fixtureData', () => ({ projectRoot, items }));
  await page.exposeBinding('hostCall', async (_source, method, params) => {
    calls.push({ method, sessionId: params.sessionId });
    const result = await client.request(method, params);
    if (method === 'artifact.preview' && result.preview?.type === 'image') {
      imagePreviewBytes = Buffer.from(result.preview.base64, 'base64').byteLength;
      imagePreviewBase64Length = result.preview.base64.length;
    }
    if (holdList && method === 'artifact.list' && params.sessionId === sessions[0]) {
      holdList = false;
      listStarted();
      await new Promise(resolve => { releaseList = resolve; });
    }
    return result;
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__p4-artifact`);
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await page.getByText('available', { exact: true }).waitFor();
  await page.getByText('# First report', { exact: false }).waitFor();

  holdList = true;
  const started = new Promise(resolve => { listStarted = resolve; });
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await started;
  await page.evaluate(() => window.showArtifact(1));
  await page.getByText('other.md', { exact: true }).waitFor();
  releaseList();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.file-delivery small').filter({ hasText: 'available' }).count(), 0,
    'late response from the old session must not overwrite the new artifact card');

  await page.evaluate(() => window.showArtifact(0));
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await page.getByText('# First report', { exact: false }).waitFor();
  await writeFile(join(projectRoot, files[0].name), '# changed');
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await page.getByText('modified', { exact: true }).waitFor();
  await unlink(join(projectRoot, files[0].name));
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await page.getByText('missing', { exact: true }).waitFor();

  await page.evaluate(() => window.showArtifact(2));
  await page.getByRole('button', { name: 'Verify and preview' }).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.file-delivery img');
    return image?.naturalWidth === 512 && image.naturalHeight === 512;
  });
  assert.equal(await page.locator('.file-delivery small').filter({ hasText: 'available' }).count(), 1);
  assert.equal(await page.getByRole('status').count(), 0, 'real image preview should not render an unavailable/error status');
  assert.ok(imagePreviewBytes > 0);
  assert.equal(imagePreviewBase64Length, 4 * Math.ceil(imagePreviewBytes / 3));
  assert.ok(imagePreviewBase64Length <= 4 * Math.ceil(256 * 1024 / 3));
  assert.deepEqual(errors, []);
  assert.ok(calls.some(call => call.method === 'artifact.preview'));
  console.log(JSON.stringify({ probe: 'p4-desktop-artifact-real-host-headless', passed: true,
    statuses: ['available', 'modified', 'missing'], textPreview: true,
    image: { source: '512x512 random PNG', previewBytes: imagePreviewBytes, base64Chars: imagePreviewBase64Length,
      decodedInRenderer: true }, staleSessionReplyIgnored: true,
    browser: 'headless', visibleWindows: 0, nativeReveal: 'not tested' }));
} finally {
  releaseList?.();
  await browser?.close();
  await vite?.close();
  pair.client.output.end();
  await host?.release();
  if (previousHome === undefined) delete process.env.LIGULE_HOME;
  else process.env.LIGULE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
});
