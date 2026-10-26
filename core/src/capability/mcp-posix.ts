// Give managed browser servers their own process group before the MCP program starts.
import koffi from 'koffi';
import { isAbsolute } from 'node:path';

if (process.platform === 'win32' || typeof process.execve !== 'function') throw new Error('browser_process_group_unavailable');
const [command, ...args] = process.argv.slice(2);
if (command === undefined || !isAbsolute(command)) throw new Error('browser_launcher_command_invalid');
const libc = koffi.load(null);
const setsid = libc.func('int setsid(void)');
if (setsid() < 0) throw new Error('browser_process_group_unavailable');
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
process.execve(command, [command, ...args], environment);
