import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 此入口与 CLI 一样运行在独立的 Node 24 进程中，stdout 专用于 Host 协议。
async function boot(): Promise<void> {
  const hostEntry = process.argv[2];
  if (hostEntry === undefined || !process.connected) throw new Error('desktop_host_entry_invalid');
  const absoluteHostEntry = resolve(hostEntry);
  process.once('disconnect', () => {
    const orphanTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        process.exit(1);
        return;
      }
      // POSIX 上 HostController 以 detached 模式启动进程，PID 同时标识工具后代共用的进程组。
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch (error) {
        if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error;
        process.exit(1);
      }
    }, 12_000);
    orphanTimer.unref();
  });
  if (process.platform === 'win32') {
    const helper = await import(pathToFileURL(join(dirname(absoluteHostEntry), '..', 'capability', 'win32-job.js')).href) as { createOwnedProcessJob: () => Promise<{ close(): void }> };
    // Job 句柄由 Host 持有；Host 终止后操作系统会关闭句柄并结束其后代进程。
    await helper.createOwnedProcessJob();
  }
  process.argv = [process.execPath, absoluteHostEntry];
  await import(pathToFileURL(absoluteHostEntry).href);
}

void boot().catch(() => { console.error('desktop_host_start_failed'); process.exitCode = 1; });
