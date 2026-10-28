import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpRegistry, mcpServerConfigs } from '../dist/index.js';

const serverEntry = fileURLToPath(new URL('./fixtures/mcp-owned-process.mjs', import.meta.url));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`fixture did not write ${path}`);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processExists(pid), false, `process ${pid} remained alive after MCP cleanup`);
}

test('Windows MCP revoke and registry close terminate owned stdio server trees', { skip: process.platform !== 'win32' }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-owned-process-'));
  const servers = {};
  const markers = new Map();
  for (const name of ['revoke', 'close']) {
    const rootPidPath = join(root, `${name}-root.pid`);
    const childPidPath = join(root, `${name}-child.pid`);
    markers.set(name, { rootPidPath, childPidPath });
    servers[name] = { command: process.execPath, args: [serverEntry, rootPidPath, childPidPath], cwd: root };
  }
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers } }, {}, root));
  try {
    await registry.toolsOf('revoke');
    const revokedRoot = await waitForFile(markers.get('revoke').rootPidPath);
    const revokedChild = await waitForFile(markers.get('revoke').childPidPath);
    assert.equal(processExists(revokedRoot), true);
    assert.equal(processExists(revokedChild), true);
    await registry.revoke('revoke');
    await Promise.all([waitForExit(revokedRoot), waitForExit(revokedChild)]);

    await registry.toolsOf('close');
    const closedRoot = await waitForFile(markers.get('close').rootPidPath);
    const closedChild = await waitForFile(markers.get('close').childPidPath);
    assert.equal(processExists(closedRoot), true);
    assert.equal(processExists(closedChild), true);
    await registry.close();
    await Promise.all([waitForExit(closedRoot), waitForExit(closedChild)]);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows MCP connection failure cleans the captured server process tree', { skip: process.platform !== 'win32' }, async () => {
  const scratch = join(process.cwd(), 'testplace');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'mcp-owned-connect-failure-'));
  const rootPidPath = join(root, 'root.pid');
  const childPidPath = join(root, 'child.pid');
  const registry = createMcpRegistry(mcpServerConfigs({ mcp: { servers: { broken: {
    command: process.execPath, args: [serverEntry, rootPidPath, childPidPath, 'true'], cwd: root,
  } } } }, {}, root));
  try {
    await assert.rejects(() => registry.toolsOf('broken'), (error) => error.code === 'mcp_connect_failed');
    const rootPid = await waitForFile(rootPidPath);
    const childPid = await waitForFile(childPidPath);
    await Promise.all([waitForExit(rootPid), waitForExit(childPid)]);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
