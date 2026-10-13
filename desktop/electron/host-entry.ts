import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 此包装和 CLI 运行在同一个独立 Node 24 进程内，stdout 保持原有 Host 协议。
async function boot(): Promise<void> {
  const cli = process.argv[2];
  if (cli === undefined || !process.connected) throw new Error('desktop_host_entry_invalid');
  const absoluteCli = resolve(cli);
  process.once('disconnect', () => {
    const orphanTimer = setTimeout(() => process.exit(1), 12_000);
    orphanTimer.unref();
  });
  if (process.platform === 'win32') {
    const helper = await import(pathToFileURL(join(dirname(absoluteCli), 'capability', 'win32-job.js')).href) as { createOwnedProcessJob: () => Promise<{ close(): void }> };
    // Job 句柄由 Host 持有；Host 被终止时操作系统关闭句柄并结束其后代。
    await helper.createOwnedProcessJob();
  }
  process.argv = [process.execPath, absoluteCli, 'host'];
  await import(pathToFileURL(absoluteCli).href);
}

void boot().catch(() => { console.error('desktop_host_start_failed'); process.exitCode = 1; });
