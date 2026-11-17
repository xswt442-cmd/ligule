import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { versionOf } from '../dist/kernel/observe.js';
import { withTuiHost } from './helpers/tui-host.ts';

type DirectoryPage = {
  path: string;
  entries: { name: string; path: string; kind: 'directory' | 'file' | 'link' }[];
  offset: number;
  nextOffset: number | null;
  incomplete: boolean;
};

type SearchPage = {
  query: string;
  matches: { path: string }[];
  offset: number;
  nextOffset: number | null;
  incomplete: boolean;
};

type FilePreview = {
  path: string;
  size: number;
  version: string | null;
  encoding: 'utf8' | 'image' | 'binary' | 'invalid_utf8' | 'too_large';
  mimeType?: string;
  imagePreview?: { mimeType: 'image/webp'; base64: string };
  text?: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
};

function hostError(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}

test('trusted UI lists and searches project files and reads bounded UTF-8 pages without starting a Run', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory, providerRequests }) => {
    await mkdir(join(projectDirectory, 'src'), { recursive: true });
    await mkdir(join(projectDirectory, 'tree', 'sub'), { recursive: true });
    await mkdir(join(projectDirectory, '.git'), { recursive: true });
    await mkdir(join(projectDirectory, 'node_modules', 'package'), { recursive: true });
    const text = '\uFEFFalpha 😀\r\nomega\r\n';
    await writeFile(join(projectDirectory, 'alpha.txt'), 'alpha');
    await writeFile(join(projectDirectory, 'beta.txt'), 'beta');
    await writeFile(join(projectDirectory, 'tree', 'a.txt'), 'a');
    await writeFile(join(projectDirectory, 'tree', 'b.txt'), 'b');
    await writeFile(join(projectDirectory, 'tree', 'sub', 'nested.txt'), 'nested');
    await writeFile(join(projectDirectory, 'src', 'Alpha.ts'), text);
    await writeFile(join(projectDirectory, '.git', 'hidden.txt'), 'hidden');
    await writeFile(join(projectDirectory, 'node_modules', 'package', 'hidden.ts'), 'hidden');
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(projectDirectory, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    const before = await client.request('session.read', { sessionId }) as { events: { kind?: string }[] };
    const first = await client.request('project.files.list', { sessionId, path: 'tree', limit: 2 }) as DirectoryPage;
    assert.equal(first.path, 'tree');
    assert.deepEqual(first.entries.map(entry => entry.name), ['a.txt', 'b.txt']);
    assert.deepEqual(first.entries.map(entry => entry.path), ['tree/a.txt', 'tree/b.txt']);
    assert.deepEqual(first.entries.map(entry => entry.kind), ['file', 'file']);
    assert.equal(JSON.stringify(first).includes(projectDirectory), false, 'Host responses contain relative project paths only');
    assert.equal(first.nextOffset, 2);
    const next = await client.request('project.files.list', { sessionId, path: 'tree', offset: first.nextOffset, limit: 2 }) as DirectoryPage;
    assert.deepEqual(next.entries.map(entry => entry.name), ['sub']);
    assert.deepEqual(next.entries.map(entry => entry.kind), ['directory']);
    assert.equal(next.offset, 2);
    assert.equal(next.nextOffset, null);

    const matches = await client.request('project.files.search', { sessionId, query: 'alpha', limit: 1 }) as SearchPage;
    assert.deepEqual(matches.matches.map(match => match.path), ['alpha.txt']);
    assert.equal(matches.nextOffset, 1);
    const remaining = await client.request('project.files.search', {
      sessionId, query: 'alpha', offset: matches.nextOffset, limit: 2,
    }) as SearchPage;
    assert.deepEqual(remaining.matches.map(match => match.path), ['src/Alpha.ts']);
    const skipped = await client.request('project.files.search', { sessionId, query: 'hidden' }) as SearchPage;
    assert.deepEqual(skipped.matches, [], 'dependency and Git directories stay outside file-name search');

    const content: string[] = [];
    let page = await client.request('project.file.read', {
      sessionId, path: 'src/Alpha.ts', offsetBytes: 0, limitBytes: 4,
    }) as FilePreview;
    const version = page.version;
    while (true) {
      assert.equal(page.encoding, 'utf8');
      assert.equal(page.version, version);
      if (page.text !== undefined) content.push(page.text);
      if (page.nextOffsetBytes === null) break;
      page = await client.request('project.file.read', {
        sessionId, path: 'src/Alpha.ts', offsetBytes: page.nextOffsetBytes, limitBytes: 4,
      }) as FilePreview;
    }
    assert.equal(content.join(''), text);
    assert.equal(version, versionOf(Buffer.from(text, 'utf8')));

    const after = await client.request('session.read', { sessionId }) as { events: { kind?: string }[] };
    assert.equal(after.events.length, before.events.length, 'file browsing does not append Session events');
    assert.equal(after.events.some(event => event.kind === 'user' || event.kind === 'tool'), false);
    assert.equal(providerRequests.length, 0, 'file browsing does not call the model');
  }, { permissionControl: true });
});

test('project file reads reject traversal and symlink escape and identify binary and over-limit files', async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, directory }) => {
    await writeFile(join(projectDirectory, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(join(projectDirectory, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
    await writeFile(join(projectDirectory, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(projectDirectory, 'pixel.png'), await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#4269ed' },
    }).png().toBuffer());
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(projectDirectory, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    const traversal = await client.request('project.file.read', { sessionId, path: '../outside/secret.txt' }).then(() => null, error => error);
    assert.equal((traversal as { code?: string }).code, 'project_file_path_invalid');
    assert.equal(JSON.stringify(traversal).includes(projectDirectory), false, 'path failures do not reveal absolute project paths');
    const linked = await client.request('project.file.read', { sessionId, path: 'outside-link/secret.txt' }).then(() => null, error => error);
    assert.equal((linked as { code?: string }).code, 'path_escapes_through_link');
    assert.equal(JSON.stringify(linked).includes(directory), false, 'link failures do not reveal target paths');

    const binary = await client.request('project.file.read', { sessionId, path: 'binary.bin' }) as FilePreview;
    assert.equal(binary.encoding, 'binary');
    assert.equal(binary.text, undefined);
    const invalid = await client.request('project.file.read', { sessionId, path: 'invalid-utf8.txt' }) as FilePreview;
    assert.equal(invalid.encoding, 'invalid_utf8');
    assert.equal(invalid.text, undefined);
    const large = await client.request('project.file.read', { sessionId, path: 'large.txt' }) as FilePreview;
    assert.equal(large.encoding, 'too_large');
    assert.equal(large.size, 256 * 1024 + 1);
    assert.equal(large.text, undefined);
    const image = await client.request('project.file.read', { sessionId, path: 'pixel.png' }) as FilePreview;
    assert.equal(image.encoding, 'image');
    assert.deepEqual(image.imagePreview?.mimeType, 'image/webp');
    assert.ok((image.imagePreview?.base64.length ?? 0) > 0);
  }, { permissionControl: true });
});

test('non-UI Host clients cannot browse project files', async () => {
  await withTuiHost(async ({ client, sessionId }) => {
    await assert.rejects(client.request('project.files.list', { sessionId, path: '.' }), hostError('project_files_control_unavailable'));
    await assert.rejects(client.request('project.files.search', { sessionId, query: 'src' }), hostError('project_files_control_unavailable'));
    await assert.rejects(client.request('project.file.read', { sessionId, path: 'secret.txt' }), hostError('project_files_control_unavailable'));
  });
});
