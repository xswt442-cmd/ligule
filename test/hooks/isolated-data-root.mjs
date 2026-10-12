// 每个测试进程一份假的个人主目录：宿主的登记、终端界面的键位与历史、技能与模式的个人层都落进这一份，
// 不碰这台机器真正的那一份（D110）。挂在 `npm test` 的 `--import` 上，因此每个测试文件的子进程起来时先经过这里。
// 这里动的是主目录那两格，`LIGULE_HOME` 反过来清掉：那些按参数注入主目录的检查照各自那一份走，
// 要验数据根覆盖的那两条自己写这个变量，不共用这一份。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ligule-test-home-'));
delete process.env.LIGULE_HOME;
// 两个都写：Node 在 Windows 上读 `USERPROFILE`，在 POSIX 上读 `HOME`。
process.env.HOME = home;
process.env.USERPROFILE = home;

// 退出时删掉：删不动就留着，那一些目录在系统临时目录里，下一次清理会带走。
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 刚退出的子进程还握着那一份目录句柄时删不掉，不影响检查结果 */
  }
});
