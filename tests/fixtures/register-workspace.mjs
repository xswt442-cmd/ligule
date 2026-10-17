// 在独立进程中登记工作区，用于验证多个进程并发访问时的文件锁行为。
import { registerWorkspace } from '../../core/dist/kernel/workspace.js';

const [path, directory] = process.argv.slice(2);
try {
  const registry = await registerWorkspace(directory, { path });
  process.stdout.write(`${JSON.stringify({ registered: true, identities: registry.workspaces.map((one) => one.identity) })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ registered: false, code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
}
