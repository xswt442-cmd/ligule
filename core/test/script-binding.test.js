import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createConfig, createDecisionChain, createKernel, createPermissionContext, createSessionLog } from '../dist/index.js';
import { execTool } from '../dist/capability/exec.js';
import { resolveShell } from '../dist/capability/shell.js';
import { bindScript, readBoundScript } from '../dist/capability/script-binding.js';
import { boundaryOf, workingDirectoryOf } from '../dist/capability/limits.js';

const permission = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

function kernelFor(root, ask, permissionForCall = () => permission, workspaceRoot = root, log = { debug() {}, log() {} }) {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root, workspaceRoot } }),
    permissionForCall,
    logger: log,
    policy: createDecisionChain({ mode: 'ask', ask }),
  });
  kernel.register(execTool);
  return kernel;
}

test('script approvals bind the canonical path, content digest, interpreter, workspace, and permission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(join(root, 'payload.txt'), 'relative import survived');
  await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, readFileSync(new URL('./payload.txt', import.meta.url), 'utf8'));\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let approval;
  const kernel = kernelFor(root, (question) => { approval = question; return true; });
  await kernel.call('exec', { command });
  const binding = approval?.scriptBinding;
  const canonicalRoot = await realpath(root);
  assert.ok(binding);
  assert.equal(binding.path, await realpath(script));
  assert.match(binding.sha256, /^[a-f0-9]{64}$/u);
  assert.match(binding.interpreter, /node(?:\.exe)?$/iu);
  assert.equal(binding.workspaceRoot, canonicalRoot);
  assert.deepEqual(binding.permission, { profile: 'full-access', network: 'unrestricted', capabilities: permission.capabilities });

  assert.equal(binding.interpreterSource, 'node');
  assert.equal(await readFile(target, 'utf8'), 'relative import survived');
  assert.equal((await readdir(root)).some((name) => name.startsWith('.ligule-approved-')), false);
});

test('full-access approval can bind a script outside the workspace while keeping cwd inside', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-full-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const external = join(root, 'external');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(external, { recursive: true })]);
  const marker = join(external, 'marker');
  const script = join(external, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let binding;
  const kernel = kernelFor(workspace, (question) => { binding = question.scriptBinding; return true; });
  await kernel.call('exec', { command });
  assert.ok(binding);
  assert.equal(binding.path, await realpath(script));
  assert.equal(await readFile(marker, 'utf8'), 'ran');
});

test('inline interpreter code is bound to its exact text and interpreter executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-inline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = 'node -e "console.log(42)"';
  let approval;
  const kernel = kernelFor(root, (question) => { approval = question; return true; });
  const result = await kernel.call('exec', { command });
  const binding = approval?.scriptBinding;
  assert.ok(binding);
  assert.equal(binding.sourceKind, 'inline');
  assert.equal(binding.path, '[inline code]');
  assert.equal(binding.inlineSource, 'console.log(42)');
  assert.match(result.text, /42/u);
});

test('script content changes after approval are refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`;
  await writeFile(script, source);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, async () => {
    await writeFile(script, `${source}// changed while approval was pending\n`);
    return true;
  });
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('a permission change while approval is pending is refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-permission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
  const command = `node "${script.replaceAll('\\', '/')}"`;
  let current = permission;
  const changed = createPermissionContext('full-access', 'unrestricted', {
    filesystemRead: 'partial', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const kernel = kernelFor(root, () => { current = changed; return true; }, () => current);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('replacing the interpreter at the same path after approval is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-interpreter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executableDirectory = join(root, 'bin');
  await mkdir(executableDirectory, { recursive: true });
  const executable = join(executableDirectory, process.platform === 'win32' ? 'node.EXE' : 'node');
  await writeFile(executable, 'approved interpreter identity');
  const previousPath = process.env.PATH;
  process.env.PATH = [executableDirectory, previousPath ?? ''].filter(Boolean).join(delimiter);
  try {
    const target = join(root, 'marker');
    const script = join(root, 'approved.js');
    await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
    const command = `node "${script.replaceAll('\\', '/')}"`;
    const kernel = kernelFor(root, async () => {
      await writeFile(executable, 'changed interpreter identity');
      return true;
    });
    await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('replacing a script path symlink after approval is refused before either target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const alias = join(root, 'selected');
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  const firstMarker = join(root, 'first-marker');
  const secondMarker = join(root, 'second-marker');
  await writeFile(join(first, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(firstMarker)}, 'ran');\n`);
  await writeFile(join(second, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(secondMarker)}, 'ran');\n`);
  try {
    await symlink(first, alias, 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('the platform does not permit creating a temporary directory link');
    throw error;
  }
  const command = `node "${join(alias, 'approved.js').replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, async () => {
    await unlink(alias);
    await symlink(second, alias, 'junction');
    return true;
  });
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_changed' });
  await assert.rejects(readFile(firstMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
});

test('replacing the resolved script file with an outside link is refused before reading it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boundary = join(root, 'workspace');
  const outside = join(root, 'outside.js');
  const script = join(boundary, 'approved.js');
  await mkdir(boundary, { recursive: true });
  await writeFile(script, 'console.log("inside")\n');
  await writeFile(outside, 'console.log("outside")\n');
  const canonical = await realpath(script);
  await rename(script, join(boundary, 'original.js'));
  try { await symlink(outside, script, 'file'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('the platform does not permit creating a temporary file link');
    throw error;
  }
  await assert.rejects(readBoundScript(boundary, canonical), (error) =>
    error.code === 'exec_script_binding_changed' || error.code === 'exec_script_binding_unavailable');
});

test('changing the workspace target while approval is pending refuses execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  const firstMarker = join(root, 'first-marker');
  const secondMarker = join(root, 'second-marker');
  await writeFile(join(first, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(firstMarker)}, 'ran');\n`);
  await writeFile(join(second, 'approved.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(secondMarker)}, 'ran');\n`);
  try { await symlink(first, workspace, 'junction'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('the platform does not permit creating a temporary directory link');
    throw error;
  }
  const command = 'node "approved.js"';
  const config = createConfig({ user: { boundary: workspace, workspaceRoot: workspace } });
  const boundary = boundaryOf(config);
  const workspaceRoot = workingDirectoryOf(config);
  assert.ok(await bindScript({ command, shell: resolveShell({}), boundary, workspaceRoot, cwd: workspaceRoot, permission }));
  let asked = false;
  const denied = [];
  const log = { debug() {}, log(_message, fields) { if (typeof fields?.reason === 'string') denied.push(fields.reason); } };
  const kernel = kernelFor(workspace, async () => {
    asked = true;
    await unlink(workspace);
    await symlink(second, workspace, 'junction');
    return true;
  }, () => permission, workspace, log);
  let failure;
  try { await kernel.call('exec', { command }); } catch (error) { failure = error; }
  assert.equal(asked, true, `the call failed before approval with ${failure?.code ?? 'no error'}: ${denied.at(-1) ?? ''}`);
  assert.equal(failure?.code, 'exec_script_binding_changed');
  assert.equal(asked, true);
  await assert.rejects(readFile(firstMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
});

test('read-only approval refuses file scripts without writing a snapshot into the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'marker');
  const script = join(root, 'approved.js');
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(target)}, 'ran');\n`);
  const readonly = createPermissionContext('read-only', 'policy', {
    filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
  });
  const command = `node "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, () => true, () => readonly);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_unavailable' });
  assert.equal((await readdir(root)).some((name) => name.startsWith('.ligule-approved-')), false);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('simple interpreter version queries remain ordinary approval-gated commands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let asked;
  const kernel = kernelFor(root, (question) => { asked = question; return false; });
  await assert.rejects(kernel.call('exec', { command: 'node --version' }), { code: 'ask_declined' });
  assert.equal(asked?.scriptBinding, undefined);
  assert.equal(asked?.command, 'node --version');
});

test('a workspace cwd escape keeps its Kernel error and records failure before approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-exec-cwd-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let asked = false;
  const session = createSessionLog({ directory: root, id: 'cwd-escape' });
  const kernel = createKernel({
    config: createConfig({ user: { boundary: root, workspaceRoot: root } }),
    permission,
    policy: createDecisionChain({ mode: 'ask', ask: () => { asked = true; return true; } }),
    session,
  });
  kernel.register(execTool);
  await assert.rejects(kernel.call('exec', { command: 'node --version', cwd: '..' }), { code: 'path_escapes_boundary' });
  assert.equal(asked, false);
  const event = (await session.read()).find((item) => item.kind === 'tool');
  assert.equal(event.result.kind, 'failure');
  assert.equal(event.result.code, 'path_escapes_boundary');
});

test('shell scripts that stream their source are refused before the target starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ligule-script-binding-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'marker');
  const script = join(root, 'approved.sh');
  await writeFile(script, `printf ran > '${marker.replaceAll("'", "'\\''")}'\n`);
  const command = `bash "${script.replaceAll('\\', '/')}"`;
  const kernel = kernelFor(root, () => true);
  await assert.rejects(kernel.call('exec', { command }), { code: 'exec_script_binding_unavailable' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
