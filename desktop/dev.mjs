import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePackageBin } from './package-bin.mjs';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(desktopRoot);
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
const frontendRequire = createRequire(join(desktopRoot, 'frontend', 'package.json'));
const electronArguments = process.argv.slice(2);
const children = new Set();
const environment = { ...process.env, LIGULE_DESKTOP_CSP_NONCE: randomBytes(32).toString('base64') };
let stopping = false;

if (electronArguments.length > 1 || electronArguments.some((argument) => {
  if (!argument.startsWith('--user-data-dir=')) return true;
  return !isAbsolute(argument.slice('--user-data-dir='.length));
})) {
  throw new Error('the development entry accepts one absolute --user-data-dir argument');
}

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = start(command, args, cwd);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

async function waitForFrontend(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with status ${child.exitCode}`);
    try {
      const response = await fetch('http://localhost:5188/');
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('Vite did not become ready at http://localhost:5188/');
}

async function stopChildren() {
  if (stopping) return;
  stopping = true;
  const activeChildren = [...children];
  await Promise.all(activeChildren.map((child) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill();
    return closed;
  }));
}

process.once('SIGINT', () => void stopChildren());
process.once('SIGTERM', () => void stopChildren());

const typescript = resolvePackageBin(rootRequire, 'typescript', 'tsc');
const viteEntry = resolvePackageBin(frontendRequire, 'vite');
const electronEntry = resolvePackageBin(desktopRequire, 'electron');
await access(typescript);
await run(process.execPath, [
  typescript,
  '-p',
  join(desktopRoot, 'electron', 'tsconfig.json'),
], desktopRoot);

const vite = start(process.execPath, [
  viteEntry,
  '--host',
  'localhost',
  '--port',
  '5188',
  '--strictPort',
], join(desktopRoot, 'frontend'));
await waitForFrontend(vite);

const electron = start(process.execPath, [
  electronEntry,
  '.',
  '--dev',
  ...electronArguments,
], desktopRoot);
const result = await new Promise((resolve, reject) => {
  electron.once('error', reject);
  electron.once('close', (code) => resolve(code ?? 1));
});
await stopChildren();
if (result !== 0) process.exitCode = Number(result);
