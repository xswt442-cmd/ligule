// 旧记录的一次性整理（D110、方案 5.5.2；合同见 `ligule-set/phase3/r55-data-root-contract.md`）：
// 把工作区目录下 `.ligule/sessions` 里的记录完整复制进数据根会话区，原件保留、逐文件比对、可重跑。
// 复制过的再跑只做比对；目标已有同名而字节不同时不自行择一，把那一份交回（真实身份无法确认的那一类）。
import { copyFile, mkdir, readdir, readFile, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SPILL_NAME } from '../kernel/result.js';

const RECORD = /\.jsonl$/;
const CHECKPOINT = /\.checkpoint\.json$/;

export interface AdoptionReport {
  copied: string[];
  already: string[];
  conflicts: string[];
  unknown: string[];
}

const wanted = (name: string): boolean => RECORD.test(name) || CHECKPOINT.test(name) || SPILL_NAME.test(name);

const digestOf = async (path: string): Promise<string | null> => {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
};

export async function adoptLegacySessions(legacy: string, target: string): Promise<AdoptionReport> {
  const report: AdoptionReport = { copied: [], already: [], conflicts: [], unknown: [] };
  let names: string[];
  try {
    names = await readdir(legacy);
  } catch {
    // 没有旧目录就没有要整理的：全新的机器与跑在临时根里的检查走这一条。
    return report;
  }
  await mkdir(target, { recursive: true });
  for (const name of names) {
    if (!wanted(name)) {
      // 锁目录是用过就撤的现场，不算记录；别的条目列进 unknown 交回，不复制。
      if (!name.endsWith('.lock')) report.unknown.push(name);
      continue;
    }
    const from = join(legacy, name);
    const to = join(target, name);
    const source = await digestOf(from);
    if (source === null) {
      report.unknown.push(name);
      continue;
    }
    const existing = await digestOf(to);
    if (existing !== null) {
      if (existing === source) report.already.push(name);
      else report.conflicts.push(name);
      continue;
    }
    const times = await stat(from);
    await copyFile(from, to);
    // 补齐的那一份要保住记录自己的时间：`updatedAt` 读的是文件时间，列表按它排序；
    // POSIX 上的 copyFile 会把时间戳改成此刻，Windows 的 CopyFileW 不会——不补这一下两边读出来不一样。
    await utimes(to, times.atime, times.mtime).catch(() => undefined);
    if ((await digestOf(to)) !== source) report.conflicts.push(name);
    else report.copied.push(name);
  }
  return report;
}

/** 缺省解析出来的记录目录才做整理：`host.sessionDirectory` 覆盖的机器自己指着位置，旧位置不算它的记录。 */
export async function adoptForSessionDirectory(
  config: { boundary: string; host?: { sessionDirectory?: unknown } },
  directory: string,
): Promise<AdoptionReport | null> {
  const configured = config.host?.sessionDirectory;
  if (typeof configured === 'string' && configured !== '') return null;
  return adoptLegacySessions(join(config.boundary, '.ligule', 'sessions'), directory);
}
