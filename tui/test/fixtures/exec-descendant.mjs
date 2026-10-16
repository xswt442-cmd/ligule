import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [operation, marker] = process.argv.slice(2);
if (operation === 'tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf', marker], { stdio: 'inherit', windowsHide: true });
  child.once('error', (error) => { throw error; });
} else if (operation === 'leaf') {
  await writeFile(`${marker}.tmp`, JSON.stringify({ processId: process.pid, parentId: process.ppid }));
  await rename(`${marker}.tmp`, marker);
  console.log('descendant is running');
  setTimeout(() => process.exit(0), 20_000);
} else {
  throw new Error('exec_descendant_operation_invalid');
}
