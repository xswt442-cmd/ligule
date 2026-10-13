import spawn from 'cross-spawn';
import { basename } from 'node:path';

export function spawnNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath !== undefined && /^npm-cli\.js$/i.test(basename(npmExecPath))
    ? process.execPath
    : 'npm';
  const npmArgs = command === process.execPath ? [npmExecPath, ...args] : args;
  return spawn.sync(command, npmArgs, options);
}

export function execNpm(args, options = {}) {
  const result = spawnNpm(args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`npm ${args[0] ?? 'command'} exited with status ${result.status ?? 'unknown'}`);
    error.status = result.status;
    error.signal = result.signal;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.output = result.output;
    throw error;
  }
  return result.stdout;
}
