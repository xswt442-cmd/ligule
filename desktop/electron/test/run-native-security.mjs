import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const electronDirectory = dirname(testDirectory);
const desktopDirectory = dirname(electronDirectory);
const repositoryRoot = dirname(desktopDirectory);
const testRoot = join(desktopDirectory, 'testplace');
const temporaryParent = join(testRoot, 'tmp');
const evidenceParent = join(testRoot, 'readings');
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron');
const electronPackagePath = join(desktopDirectory, 'node_modules', 'electron', 'package.json');
const harnessPath = join(testDirectory, 'native-security.cjs');
const nodeExecutable = join(desktopDirectory, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const hostCli = join(repositoryRoot, 'dist', 'cli.js');
const hostEntry = join(electronDirectory, 'dist', 'host-entry.js');
const frontend = join(desktopDirectory, 'frontend', 'dist', 'index.html');
const buildFiles = [electronExecutable, harnessPath, nodeExecutable, hostCli, hostEntry, frontend];
const missing = buildFiles.filter(path => !existsSync(path));
if (missing.length > 0) throw new Error(`native_security_prerequisite_missing:${missing.map(path => basename(path)).join(',')}`);

await mkdir(temporaryParent, { recursive: true });
await mkdir(evidenceParent, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, '-');
const temporaryRoot = await mkdtemp(join(temporaryParent, `electron-security-${runId}-`));
const evidenceRoot = join(evidenceParent, `electron-security-${runId}`);
const userData = join(temporaryRoot, 'user-data');
const isolatedHome = join(temporaryRoot, 'ligule-home');
const workspace = join(temporaryRoot, 'workspaces', 'project');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(isolatedHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
await mkdir(evidenceRoot, { recursive: true });

const environment = { ...process.env };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LIGULE_API_KEY']) delete environment[name];
for (const name of Object.keys(environment)) {
  if (/(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_PASSWORD)$/iu.test(name)) delete environment[name];
}
environment.LIGULE_HOME = isolatedHome;
environment.LIGULE_SECURITY_TEMP_ROOT = temporaryRoot;
environment.LIGULE_SECURITY_EVIDENCE_ROOT = evidenceRoot;
environment.LIGULE_SECURITY_USER_DATA = userData;
environment.LIGULE_SECURITY_WORKSPACE = workspace;

const args = [`--user-data-dir=${userData}`, harnessPath];
await writeFile(join(evidenceRoot, 'command.txt'), `${basename(electronExecutable)} ${args.map(value => value.startsWith('--user-data-dir=') ? '--user-data-dir=<isolated desktop/testplace/tmp>' : 'desktop/electron/test/native-security.cjs').join(' ')}\n`, 'utf8');
const stdout = createWriteStream(join(evidenceRoot, 'stdout.log'));
const stderr = createWriteStream(join(evidenceRoot, 'stderr.log'));
const child = spawn(electronExecutable, args, {
  cwd: repositoryRoot,
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: process.platform === 'win32',
});
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);

const timeoutMs = 150_000;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, timeoutMs);
const { code, signal } = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('close', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
});
clearTimeout(timer);
stdout.end();
stderr.end();

let harnessReport;
try {
  harnessReport = JSON.parse(await readFile(join(evidenceRoot, 'native-security.json'), 'utf8'));
} catch {
  harnessReport = null;
}
const status = {
  command: `${basename(electronExecutable)} --user-data-dir=<isolated> desktop/electron/test/native-security.cjs`,
  electron: JSON.parse(await readFile(electronPackagePath, 'utf8')).version,
  exitCode: code,
  signal,
  timedOut,
  harness: harnessReport,
};
await writeFile(join(evidenceRoot, 'run.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');

const relativeTemporary = relative(testRoot, temporaryRoot);
if (relativeTemporary === '' || relativeTemporary === '..' || relativeTemporary.startsWith(`..${sep}`) || resolve(testRoot, relativeTemporary) !== temporaryRoot) {
  throw new Error('native_security_temp_path_escaped_testplace');
}
if (!timedOut && code === 0) {
  await rm(temporaryRoot, { recursive: true, force: true });
} else {
  console.error(`temporary security harness data retained at ${relative(testRoot, temporaryRoot)}`);
}

if (timedOut || code !== 0 || harnessReport === null || harnessReport.results?.some(result => result.status !== '通过')) {
  console.error(`native Electron security harness failed; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
  process.exitCode = 1;
} else {
  console.log(`native Electron security harness passed; evidence: ${relative(repositoryRoot, evidenceRoot)}`);
}
