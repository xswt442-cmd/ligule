import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKBENCH_STATE,
  closeWorkbenchTab,
  openWorkbenchResource,
  selectWorkbenchTab,
  workbenchStateFrom,
} from '../../frontend/src/workbench.ts';
import { defaultSettings, loadSettings, saveWorkbenchSettings, updateSettings } from '../../frontend/src/settings.ts';

test('opening the same file focuses its existing tab and updates only its location', () => {
  const first = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/app.tsx', line: 4 }, 'app.tsx');
  const second = openWorkbenchResource(first,
    { kind: 'file', projectRoot: 'c:/REPO', path: 'SRC\\APP.TSX', line: 18 }, 'App.tsx');

  assert.equal(second.tabs.length, 1);
  assert.equal(second.activeKey, first.activeKey);
  assert.equal(second.tabs[0].title, 'App.tsx');
  assert.equal(second.tabs[0].resource.line, 18);
});

test('resource identity separates projects, immutable diffs, executions, and child runs', () => {
  const projectA = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo-a', path: 'src/app.tsx' }, 'app.tsx');
  const projectB = openWorkbenchResource(projectA,
    { kind: 'file', projectRoot: 'C:/repo-b', path: 'src/app.tsx' }, 'app.tsx');
  const before = 'a'.repeat(64);
  const after = 'b'.repeat(64);
  const diffA = openWorkbenchResource(projectB,
    { kind: 'diff', projectRoot: 'C:/repo-a', path: 'src/app.tsx', beforeVersion: before, afterVersion: after }, 'app.tsx diff');
  const diffB = openWorkbenchResource(diffA,
    { kind: 'diff', projectRoot: 'C:/repo-a', path: 'src/app.tsx', beforeVersion: after, afterVersion: before }, 'app.tsx diff');
  const execution = openWorkbenchResource(diffB,
    { kind: 'execution', sessionId: 'session-a', runId: 'run-a', executionId: 'exec-a' }, 'check');
  const childA = openWorkbenchResource(execution,
    { kind: 'subrun', sessionId: 'session-a', parentRunId: 'run-a', subrunId: 'subrun-a', childSessionId: 'child-a', childRunId: 'child-run-a' }, 'review');
  const childB = openWorkbenchResource(childA,
    { kind: 'subrun', sessionId: 'session-b', parentRunId: 'run-b', subrunId: 'subrun-a', childSessionId: 'child-a', childRunId: 'child-run-a' }, 'review');

  assert.equal(childB.tabs.length, 7);
  assert.equal(new Set(childB.tabs.map(tab => tab.key)).size, childB.tabs.length);
});

test('file and diff resources accept Session file versions while artifact IDs remain full digests', () => {
  const before = 'a'.repeat(16);
  const after = 'b'.repeat(16);
  const file = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/app.ts', version: after }, 'app.ts');
  const diff = openWorkbenchResource(file,
    { kind: 'diff', projectRoot: 'C:/repo', path: 'src/app.ts', beforeVersion: before, afterVersion: after }, 'app.ts diff');
  const artifact = openWorkbenchResource(diff,
    { kind: 'artifact', projectRoot: 'C:/repo', sessionId: 'session-a', artifactKey: 'c'.repeat(64) }, 'delivery');
  const invalidArtifact = workbenchStateFrom({
    version: 1,
    tabs: [{ resource: { kind: 'artifact', projectRoot: 'C:/repo', sessionId: 'session-a', artifactKey: after }, title: 'invalid' }],
  });

  assert.equal(file.tabs.length, 1);
  assert.equal(diff.tabs.length, 2);
  assert.equal(diff.tabs[1].resource.kind, 'diff');
  assert.equal(artifact.tabs.length, 3);
  assert.equal(invalidArtifact.tabs.length, 0);
});

test('workbench accepts filesystem roots while keeping the file target relative', () => {
  const unixRoot = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: '/', path: 'etc/config.toml' }, 'config.toml');
  const driveRoot = openWorkbenchResource(unixRoot,
    { kind: 'file', projectRoot: 'C:\\', path: 'src/main.ts' }, 'main.ts');

  assert.equal(unixRoot.tabs[0].resource.kind, 'file');
  assert.equal(driveRoot.tabs[1].resource.kind, 'file');
  assert.equal(driveRoot.tabs[1].resource.projectRoot, 'C:/');
});

test('closing or selecting a tab keeps the active key on an existing resource', () => {
  const first = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/a.ts' }, 'a.ts');
  const second = openWorkbenchResource(first,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/b.ts' }, 'b.ts');
  const selected = selectWorkbenchTab(second, first.activeKey);
  const closed = closeWorkbenchTab(selected, first.activeKey);

  assert.equal(selected.activeKey, first.activeKey);
  assert.equal(closed.tabs.length, 1);
  assert.equal(closed.activeKey, second.activeKey);
});

test('restoring bounded workbench state rejects unsafe file paths and unknown resource types', () => {
  const restored = workbenchStateFrom({
    version: 1,
    rightOpen: true,
    bottomOpen: true,
    rightWidth: 520,
    bottomHeight: 320,
    tabs: [
      { resource: { kind: 'file', projectRoot: 'C:/repo', path: '../outside.txt' }, title: 'outside' },
      { resource: { kind: 'future-resource', sessionId: 'session-a' }, title: 'unknown' },
      { resource: { kind: 'file', projectRoot: 'C:/repo', path: 'src/ok.ts' }, title: 'ok.ts' },
    ],
    activeKey: 'stale',
  });

  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.tabs[0].title, 'ok.ts');
  assert.equal(restored.activeKey, restored.tabs[0].key);
  assert.equal(restored.rightWidth, 520);
  assert.equal(restored.bottomHeight, 320);
});

test('the tab limit reports an explicit error instead of dropping a possibly edited resource', () => {
  let state = DEFAULT_WORKBENCH_STATE;
  for (let index = 0; index < 24; index += 1) {
    state = openWorkbenchResource(state,
      { kind: 'file', projectRoot: 'C:/repo', path: `src/${index}.ts` }, `${index}.ts`);
  }

  assert.throws(() => openWorkbenchResource(state,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/25.ts' }, '25.ts'), { code: 'workbench_tab_limit' });
  assert.equal(state.tabs.length, 24);
});

test('saving workbench state merges into the latest Host preferences and keeps conversation drafts', async () => {
  let stored = { ...defaultSettings, language: 'en', drafts: { 'C:/repo': { 'session-a': 'keep this draft' } } };
  let version = 'before';
  const client = {
    async call(method, params) {
      if (method === 'prefs.read') return { version, settings: stored };
      if (method === 'prefs.write') {
        assert.equal(params.version, version);
        stored = JSON.parse(params.json);
        version = 'after';
        return { version };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const workbench = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/a.ts' }, 'a.ts');

  await loadSettings(client);
  await saveWorkbenchSettings(client, workbench);

  assert.equal(stored.language, 'en');
  assert.equal(stored.drafts['C:/repo']['session-a'], 'keep this draft');
  assert.deepEqual(stored.workbench.tabs, workbench.tabs);
  assert.equal(version, 'after');
});

test('concurrent workbench and draft updates merge in the serialized Host preference writer', async () => {
  let stored = { ...defaultSettings };
  let version = 'v0';
  let reads = 0;
  const client = {
    async call(method, params) {
      if (method === 'prefs.read') { reads += 1; return { version, settings: stored }; }
      if (method === 'prefs.write') {
        assert.equal(params.version, version);
        stored = JSON.parse(params.json);
        version = `v${Number(version.slice(1)) + 1}`;
        return { version };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const workbench = openWorkbenchResource(DEFAULT_WORKBENCH_STATE,
    { kind: 'file', projectRoot: 'C:/repo', path: 'src/a.ts' }, 'a.ts');
  await loadSettings(client);

  await Promise.all([
    saveWorkbenchSettings(client, workbench),
    updateSettings(client, current => ({ ...current, drafts: { 'C:/repo': { session: 'keep me' } } })),
  ]);

  assert.equal(reads, 1);
  assert.equal(stored.workbench.tabs.length, 1);
  assert.equal(stored.drafts['C:/repo'].session, 'keep me');
  assert.equal(version, 'v2');
});
