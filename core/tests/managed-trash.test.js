import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createManagedTrash } from '../dist/capability/managed-trash.js';
import { isWindowsReparsePoint, renameNoReplace } from '../dist/capability/rename-no-replace.js';
import { workspaceIdentity } from '../dist/kernel/workspace.js';
import { workspaceDataDirectory } from '../dist/session/list.js';

const renameIdentity = (info) => ({ dev: info.dev, ino: info.ino, mode: info.mode });

test('managed trash isolates workspaces and restores files and directories without overwriting conflicts', async (t) => {
  const previousDataRoot = process.env.LIGULE_HOME;
  const testplace = join(process.cwd(), 'testplace');
  await mkdir(testplace, { recursive: true });
  const testRoot = await mkdtemp(join(testplace, 'managed-trash-'));
  const home = join(testRoot, 'home');
  const workspace = join(testRoot, 'workspace');
  const otherWorkspace = join(testRoot, 'other-workspace');
  const dataDirectory = join(home, '.ligule');
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(otherWorkspace)]);
  process.env.LIGULE_HOME = dataDirectory;
  t.after(async () => {
    if (previousDataRoot === undefined) delete process.env.LIGULE_HOME;
    else process.env.LIGULE_HOME = previousDataRoot;
    await rm(testRoot, { recursive: true, force: true });
  });

  const trash = createManagedTrash({ userHome: home });
  const managedTrashRoot = join(workspaceDataDirectory({ boundary: workspace, workspaceRoot: workspace, userHome: home }), 'managed-trash');
  const filePath = join(workspace, 'notes.txt');
  await writeFile(filePath, 'original file contents');
  if (process.platform !== 'win32') await chmod(filePath, 0o640);
  const originalMode = (await lstat(filePath)).mode & 0o777;
  const fileEntry = await trash.trash(workspace, workspace, filePath);
  assert.equal(fileEntry.workspace, workspaceIdentity(workspace));
  assert.equal(fileEntry.relativePath, 'notes.txt');
  assert.equal(fileEntry.objectType, 'file');
  assert.equal(fileEntry.status, 'recoverable');
  const trashRootInfo = await lstat(managedTrashRoot);
  assert.equal(trashRootInfo.isDirectory(), true, 'items live below the shared workspace data directory');
  const entryDirectory = join(managedTrashRoot, fileEntry.id);
  const manifestPath = join(entryDirectory, 'manifest.json');
  if (process.platform !== 'win32') {
    assert.equal(trashRootInfo.mode & 0o077, 0, 'the managed trash root is private');
    assert.equal((await lstat(entryDirectory)).mode & 0o077, 0, 'entry directories are private');
    assert.equal((await lstat(manifestPath)).mode & 0o077, 0, 'manifests are private');
    assert.equal((await lstat(join(entryDirectory, 'payload'))).mode & 0o777, originalMode, 'moving the payload preserves its original mode');
  }
  assert.equal(await lstat(filePath).then(() => true, () => false), false, 'a successful move takes the file out of the workspace');
  assert.deepEqual((await trash.list(otherWorkspace, otherWorkspace)).entries, [], 'another workspace cannot see this item');

  await writeFile(filePath, 'new conflicting contents');
  await assert.rejects(() => trash.restore(workspace, workspace, fileEntry.id), { code: 'managed_trash_restore_conflict' });
  assert.equal(await readFile(filePath, 'utf8'), 'new conflicting contents', 'restore leaves the conflicting target untouched');
  assert.equal((await trash.list(workspace, workspace)).entries[0]?.id, fileEntry.id, 'a conflict leaves the trash item recoverable');
  await unlink(filePath);
  await trash.restore(workspace, workspace, fileEntry.id);
  assert.equal(await readFile(filePath, 'utf8'), 'original file contents');
  assert.equal((await lstat(filePath)).mode & 0o777, originalMode, 'restoration preserves the original mode');
  assert.deepEqual((await trash.list(workspace, workspace)).entries, []);

  const directoryPath = join(workspace, 'removed-directory');
  await mkdir(join(directoryPath, 'nested'), { recursive: true });
  await writeFile(join(directoryPath, 'nested', 'inside.txt'), 'directory contents');
  const directoryEntry = await trash.trash(workspace, workspace, directoryPath);
  assert.equal(directoryEntry.objectType, 'directory');
  await mkdir(directoryPath);
  await writeFile(join(directoryPath, 'conflict.txt'), 'directory conflict');
  await assert.rejects(() => trash.restore(workspace, workspace, directoryEntry.id), { code: 'managed_trash_restore_conflict' });
  assert.equal(await readFile(join(directoryPath, 'conflict.txt'), 'utf8'), 'directory conflict');
  await rm(directoryPath, { recursive: true });
  const restoredDirectory = await trash.restore(workspace, workspace, directoryEntry.id);
  assert.equal(restoredDirectory.status, 'restored');
  assert.equal(await readFile(join(directoryPath, 'nested', 'inside.txt'), 'utf8'), 'directory contents');

  const targetDirectory = join(workspace, 'link-target');
  const linkedTree = join(workspace, 'linked-tree');
  await Promise.all([mkdir(targetDirectory), mkdir(linkedTree)]);
  const linkPath = join(linkedTree, 'junction');
  await symlink(targetDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform === 'win32') {
    assert.equal(await isWindowsReparsePoint(linkPath), true, 'the native tag query identifies a junction without following it');
    assert.equal(await isWindowsReparsePoint(targetDirectory), false, 'the native tag query accepts an ordinary directory');
  }
  await assert.rejects(() => trash.trash(workspace, workspace, linkedTree), { code: 'managed_trash_link_unsupported' });
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true, 'a rejected tree keeps its link in place');
  assert.equal(await lstat(linkedTree).then(info => info.isDirectory()), true, 'a rejected tree stays in the workspace');

  const hardLinkedFile = join(workspace, 'hard-linked.txt');
  const hardLinkAlias = join(workspace, 'hard-linked-alias.txt');
  await writeFile(hardLinkedFile, 'shared inode');
  await link(hardLinkedFile, hardLinkAlias);
  await assert.rejects(() => trash.trash(workspace, workspace, hardLinkedFile), { code: 'managed_trash_hard_link_unsupported' });
  assert.equal(await readFile(hardLinkedFile, 'utf8'), 'shared inode');
  assert.equal(await readFile(hardLinkAlias, 'utf8'), 'shared inode');

  const interruptedDirectory = join(workspace, 'interrupted-directory');
  await mkdir(interruptedDirectory);
  await writeFile(join(interruptedDirectory, 'after-crash.txt'), 'persisted directory');
  const interruptedEntry = await trash.trash(workspace, workspace, interruptedDirectory);
  const payloadPath = join(managedTrashRoot, interruptedEntry.id, 'payload');
  await renameNoReplace(payloadPath, interruptedDirectory, {
    sourceRoot: join(managedTrashRoot, interruptedEntry.id),
    destinationRoot: workspace,
    expectedSource: renameIdentity(await lstat(payloadPath)),
  });
  const interruptedListing = (await trash.list(workspace, workspace)).entries.find(entry => entry.id === interruptedEntry.id);
  assert.equal(interruptedListing?.status, 'interrupted');
  assert.equal(interruptedListing?.issue, 'managed_trash_source_present');
  const recovered = await trash.restore(workspace, workspace, interruptedEntry.id);
  assert.equal(recovered.status, 'restored', 'retry recognizes a completed move whose manifest cleanup was interrupted');
  assert.equal(await readFile(join(interruptedDirectory, 'after-crash.txt'), 'utf8'), 'persisted directory');
  assert.equal((await trash.list(workspace, workspace)).entries.some(entry => entry.id === interruptedEntry.id), false);

  const racingPath = join(workspace, 'racing-target.txt');
  await writeFile(racingPath, 'payload that must be restored');
  const racingEntry = await trash.trash(workspace, workspace, racingPath);
  const [restoreOutcome, competingCreate] = await Promise.all([
    trash.restore(workspace, workspace, racingEntry.id).then(value => ({ status: 'restored', value }), error => ({ status: 'error', error })),
    writeFile(racingPath, 'concurrent target', { flag: 'wx' }).then(
      () => ({ status: 'created' }),
      error => error?.code === 'EEXIST' ? ({ status: 'conflict' }) : Promise.reject(error),
    ),
  ]);
  const racingContents = await readFile(racingPath, 'utf8');
  if (competingCreate.status === 'created') {
    assert.equal(racingContents, 'concurrent target');
    assert.equal(restoreOutcome.status, 'error');
    assert.equal(restoreOutcome.error.code, 'managed_trash_restore_conflict');
    assert.equal((await trash.list(workspace, workspace)).entries.some(entry => entry.id === racingEntry.id), true);
  } else {
    assert.equal(competingCreate.status, 'conflict');
    assert.equal(restoreOutcome.status, 'restored');
    assert.equal(racingContents, 'payload that must be restored');
    assert.equal((await trash.list(workspace, workspace)).entries.some(entry => entry.id === racingEntry.id), false);
  }

  const pageFiles = ['page-a.txt', 'page-b.txt'];
  const expectedPageTotal = 2 + (competingCreate.status === 'created' ? 1 : 0);
  const pageEntries = [];
  for (const name of pageFiles) {
    const path = join(workspace, name);
    await writeFile(path, name);
    pageEntries.push(await trash.trash(workspace, workspace, path));
  }
  const page = await trash.list(workspace, workspace, { offset: 0, limit: 1 });
  assert.equal(page.total, expectedPageTotal);
  assert.equal(page.entries.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 1);
  assert.equal((await trash.list(workspace, workspace, { offset: 1, limit: 1 })).entries.length, 1);
  for (const entry of pageEntries) await trash.restore(workspace, workspace, entry.id);

  const changedSource = join(workspace, 'rename-identity.txt');
  const preservedOriginal = join(workspace, 'rename-identity-original.txt');
  const changedDestination = join(workspace, 'rename-identity-destination.txt');
  await writeFile(changedSource, 'original object');
  const expectedSource = renameIdentity(await lstat(changedSource));
  await rename(changedSource, preservedOriginal);
  await writeFile(changedSource, 'replacement object');
  await assert.rejects(() => renameNoReplace(changedSource, changedDestination, {
    sourceRoot: workspace,
    destinationRoot: workspace,
    expectedSource,
  }), { code: 'managed_trash_source_changed' });
  assert.equal(await readFile(preservedOriginal, 'utf8'), 'original object');
  assert.equal(await readFile(changedSource, 'utf8'), 'replacement object');
  assert.equal(await lstat(changedDestination).then(() => true, () => false), false);

  const noReplaceSource = join(workspace, 'rename-no-replace-source.txt');
  const noReplaceDestination = join(workspace, 'rename-no-replace-destination.txt');
  await Promise.all([writeFile(noReplaceSource, 'source'), writeFile(noReplaceDestination, 'destination')]);
  const noReplaceIdentity = renameIdentity(await lstat(noReplaceSource));
  await assert.rejects(() => renameNoReplace(noReplaceSource, noReplaceDestination, {
    sourceRoot: workspace,
    destinationRoot: workspace,
    expectedSource: noReplaceIdentity,
  }), { code: 'managed_trash_target_exists' });
  assert.equal(await readFile(noReplaceSource, 'utf8'), 'source');
  assert.equal(await readFile(noReplaceDestination, 'utf8'), 'destination');

  const narrowBoundary = join(workspace, 'narrow-boundary');
  await mkdir(narrowBoundary);
  const inBoundary = join(narrowBoundary, 'inside.txt');
  const outsideBoundary = join(workspace, 'outside-boundary.txt');
  await Promise.all([writeFile(inBoundary, 'inside'), writeFile(outsideBoundary, 'outside')]);
  await assert.rejects(() => trash.trash(workspace, undefined, inBoundary), { code: 'managed_trash_boundary_invalid' });
  assert.equal(await readFile(inBoundary, 'utf8'), 'inside', 'an omitted boundary cannot widen access');
  const insideEntry = await trash.trash(workspace, narrowBoundary, inBoundary);
  await assert.rejects(() => trash.trash(workspace, narrowBoundary, outsideBoundary), { code: 'managed_trash_target_outside_boundary' });
  assert.equal(await readFile(outsideBoundary, 'utf8'), 'outside', 'a rejected target stays in place');
  const outsideEntry = await trash.trash(workspace, workspace, outsideBoundary);
  const narrowListing = await trash.list(workspace, narrowBoundary);
  assert.ok(narrowListing.entries.some(entry => entry.id === insideEntry.id));
  assert.equal(narrowListing.entries.some(entry => entry.id === outsideEntry.id), false, 'listing does not expose entries outside the current boundary');
  await assert.rejects(() => trash.restore(workspace, narrowBoundary, outsideEntry.id), { code: 'managed_trash_target_outside_boundary' });
  await trash.restore(workspace, narrowBoundary, insideEntry.id);
  await trash.restore(workspace, workspace, outsideEntry.id);

  const survivingFile = join(workspace, 'surviving-entry.txt');
  await writeFile(survivingFile, 'still listed');
  const survivingEntry = await trash.trash(workspace, workspace, survivingFile);
  const damagedId = '00000000-0000-4000-8000-000000000001';
  const incompleteId = '00000000-0000-4000-8000-000000000002';
  const damagedDirectory = join(managedTrashRoot, damagedId);
  const incompleteDirectory = join(managedTrashRoot, incompleteId);
  await Promise.all([mkdir(damagedDirectory), mkdir(incompleteDirectory)]);
  await writeFile(join(damagedDirectory, 'manifest.json'), '{"version":1');
  await writeFile(join(incompleteDirectory, '.manifest-interrupted.tmp'), '{"version":1');
  const damagedListing = await trash.list(workspace, workspace);
  assert.ok(damagedListing.entries.some(entry => entry.id === survivingEntry.id && entry.status === 'recoverable'));
  assert.deepEqual(
    damagedListing.entries.filter(entry => entry.id === damagedId || entry.id === incompleteId).map(entry => [entry.id, entry.status, entry.issue]).sort(),
    (process.platform === 'win32'
      ? [[damagedId, 'damaged', 'managed_trash_entry_invalid'], [incompleteId, 'damaged', 'managed_trash_manifest_missing']]
      : [[damagedId, 'damaged', 'managed_trash_permissions_invalid'], [incompleteId, 'damaged', 'managed_trash_permissions_invalid']]).sort(),
  );

  if (process.platform === 'linux') {
    await chmod(managedTrashRoot, 0o755);
    await assert.rejects(() => trash.list(workspace, workspace), { code: 'managed_trash_permissions_invalid' });
    assert.equal((await lstat(managedTrashRoot)).mode & 0o077, 0o055, 'an existing directory is rejected without being widened or silently repaired');
  }
});
