// Give each managed MCP server its own process group so cleanup cannot signal unrelated processes.
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

async function executableOf(command: string): Promise<string> {
  if (isAbsolute(command)) return command;
  if (command.includes('/')) return resolve(command);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory || process.cwd(), command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('mcp_server_command_not_found');
}

if (process.platform === 'win32' || typeof process.execve !== 'function') throw new Error('mcp_process_group_unavailable');
const [requestedCommand, ...args] = process.argv.slice(2);
if (requestedCommand === undefined) throw new Error('mcp_server_command_invalid');
const command = await executableOf(requestedCommand);
const koffiModule = await import('koffi').catch(() => undefined);
if (koffiModule === undefined) throw new Error('mcp_process_group_unavailable');
const libc = koffiModule.default.load(null);
const setsid = libc.func('int setsid(void)');
if (setsid() < 0) throw new Error('mcp_process_group_unavailable');
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
process.execve(command, [command, ...args], environment);
