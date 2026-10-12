// 一次登记的子进程入口：跨进程那一条检查要用真的两具进程，进程内那条队列证明不了锁（D110、方案 5.5.1）。
import { registerWorkspace } from '../../dist/kernel/workspace.js';

const [path, directory] = process.argv.slice(2);
try {
  const registry = await registerWorkspace(directory, { path });
  process.stdout.write(`${JSON.stringify({ registered: true, identities: registry.workspaces.map((one) => one.identity) })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ registered: false, code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
}
