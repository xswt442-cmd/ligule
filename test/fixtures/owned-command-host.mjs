import { spawnWindowsCommand } from '../../dist/capability/windows-command.js';
import { resolveShell, withNativeExitCode } from '../../dist/capability/shell.js';

const [program, marker, directory] = process.argv.slice(2);
const command = `node "${program.replace(/\\/g, '/')}" tree "${marker.replace(/\\/g, '/')}"`;
const shell = withNativeExitCode(resolveShell({}), command);
const owned = spawnWindowsCommand(shell.executable, [...shell.prefix, `${command}${shell.tail}`], directory);
owned.child.stdout.resume();
owned.child.stderr.resume();
await owned.completion;
