// 只读三件（最小配置的成员，D3）：`read`、`find`、`search`。
// 每一条交回的内容受字节与条数上限约束，超限时在文本里留下一行看得见的标记（I6）。
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { matchesName } from '../kernel/match.js';
import { boundaryOf, limitsOf, skippedDirectories } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { resolveRipgrep, searchWithRipgrep } from '../capability/ripgrep.js';
import { versionOf } from '../session/observe.js';
import { existsOrFails, kindOfTarget, marker, readExisting, toPosix, walkFiles } from './common.js';

export const readTool = {
  name: 'read',
  description: 'Read a text file inside the workspace boundary, up to a byte limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace boundary.' },
      offsetBytes: { type: 'integer', minimum: 0, description: 'Byte offset to continue from after a truncation.' },
    },
    required: ['path'],
  },
  async run(args, { config, observations }) {
    const { readBytes } = limitsOf(config);
    const target = await resolveWithin(boundaryOf(config), args.path);
    const bytes = await readExisting(target);
    const offset = args.offsetBytes ?? 0;
    const slice = bytes.subarray(offset, offset + readBytes);
    const left = bytes.length - offset - slice.length;
    // 只有从头完整读到尾才算一次观察：截断那一份没看见的部分会在覆盖时丢掉。
    if (offset === 0 && left <= 0) observations?.observe(target, versionOf(bytes));
    const text = slice.toString('utf8')
      + (left > 0 ? marker(`truncated: ${slice.length} of ${bytes.length - offset} bytes shown, continue with offsetBytes=${offset + slice.length}`) : '');
    return { text };
  },
};

export const findTool = {
  name: 'find',
  description: 'Find files by name pattern inside the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Name pattern: * and ? stop at a path separator, ** crosses it, and **/ may match no directory at all.' },
      path: { type: 'string', description: 'Subdirectory to search from, relative to the boundary.' },
    },
    required: ['pattern'],
  },
  async run(args, { config, signal }) {
    // 取消边界（D20）：先判一次，再在每一份文件之前判一次，两条后端交回的码相同。
    if (signal?.aborted) throw new KernelError('find_cancelled', { detail: 'the file listing was cancelled before it finished' });
    const { resultCount } = limitsOf(config);
    const boundary = boundaryOf(config);
    const root = args.path === undefined ? boundary : await resolveWithin(boundary, args.path);
    // 遍历的起点必须是目录：交给 walkFiles 的话，readdir 会对文件抛原始的 ENOTDIR，
    // 那一类错误没有稳定码，判定链与调用方都没法分支。
    if (await kindOfTarget(root) !== 'directory') {
      throw new KernelError('find_path_not_directory', { detail: `find starts from a directory, but ${args.path} is a file` });
    }
    const names = [];
    let scanned = 0;
    for await (const name of walkFiles(root, skippedDirectories(config))) {
      if (signal?.aborted) throw new KernelError('find_cancelled', { detail: 'the file listing was cancelled before it finished' });
      scanned += 1;
      if (!matchesName(name, args.pattern)) continue;
      if (names.length === resultCount) {
        return { text: `${names.join('\n')}${marker(`truncated: ${resultCount} matches shown and more follow, narrow the pattern`)}` };
      }
      names.push(name);
    }
    return { text: names.join('\n') + (names.length === 0 ? '(no matches)' : '') };
  },
};

// 检索有两条后端：外部的 ripgrep（随包分发的那一份，或者配置里指明的可执行文件）与 Node 自己遍历。
// ponytail: 回落那一条是逐行做字面匹配，代价是每次搜索线性扫过 scanFiles 个文件、scanBytes 字节，
// 而且这两个扫描预算只在回落那条上生效；外部后端可用时只有命中数上限参与。
export const searchTool = {
  name: 'search',
  description: 'Search file contents for a literal string inside the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Literal text to look for, matched case sensitively per line.' },
      path: { type: 'string', description: 'File or subdirectory to search, relative to the boundary.' },
    },
    required: ['pattern'],
  },
  async run(args, { config, logger, signal }) {
    // 取消边界（D20）：外部后端那一条把同一个信号交给子进程，这一条在每份文件之前判一次。
    if (signal?.aborted) throw new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' });
    const { resultCount, scanBytes, scanFiles } = limitsOf(config);
    const boundary = boundaryOf(config);

    // 有外部后端就用它：八千个文件的树上一秒出头，自己遍历要三倍耗时（本机实测）。
    // 探测不到就回落到自己遍历，回落的原因写进日志（I8）。
    const backend = await resolveRipgrep({ path: config.ripgrepPath });
    if (backend.executable !== undefined) {
      // 目标要先判存在：ripgrep 对着不存在的路径以自己的退出码报错，
      // 那条路走会交出一个说「后端故障」的码，而回落那条给的是 path_not_found。
      const root = args.path === undefined ? boundary : await resolveWithin(boundary, args.path);
      if (args.path !== undefined) await kindOfTarget(root);
      const found = await searchWithRipgrep({
        executable: backend.executable,
        boundary,
        target: toPosix(relative(boundary, root)) || '.',
        pattern: args.pattern,
        limit: resultCount,
        excludes: skippedDirectories(config),
        signal,
      });
      return {
        text: (found.hits.length === 0 ? '(no matches)' : found.hits.join('\n'))
          + (found.truncated ? marker(`truncated: ${resultCount} matches shown and more follow, narrow the pattern`) : ''),
      };
    }
    logger.debug('ripgrep is not available, walking the tree instead', { tool: 'search', code: backend.code, detail: backend.detail });

    const hits = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let binaries = 0;
    let stopped = '';

    // 返回 false 表示这一趟该停了：命中数用完，或者扫描预算见底。
    async function scan(target) {
      const file = toPosix(relative(boundary, target));
      const bytes = await readFile(target);
      // 含零字节的按二进制对待，跳过去看下一份：外部后端那种文件也不交命中。
      if (bytes.includes(0)) {
        binaries += 1;
        return true;
      }
      // 预算按累计扫过的字节算，这一份放不下时后面的每一份都放不下，
      // 继续读下去只是把文件一份份读进内存再丢掉。
      if (scannedBytes + bytes.length > scanBytes) {
        stopped = `incomplete: ${scanBytes} bytes scanned, the rest of the tree was not read`;
        return false;
      }
      scannedBytes += bytes.length;
      // 行尾的回车属于换行符本身，不属于行的内容：外部后端也不把它交回来，两边都去掉。
      const lines = bytes.toString('utf8').split('\n').map((line) => line.replace(/\r$/, ''));
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(args.pattern)) continue;
        if (hits.length === resultCount) {
          stopped = `truncated: ${resultCount} matches shown and more follow, narrow the pattern`;
          return false;
        }
        hits.push(`${file}:${index + 1}:${lines[index]}`);
      }
      return true;
    }

    // 描述里写的「文件或子目录」两种都成立：给定 path 时按它实际是哪种分派，
    // 把目录当文件读会抛原始的 EISDIR，没有稳定码。
    async function* candidates() {
      const skipped = skippedDirectories(config);
      if (args.path === undefined) {
        for await (const file of walkFiles(boundary, skipped)) yield join(boundary, file);
        return;
      }
      const root = await resolveWithin(boundary, args.path);
      if (await kindOfTarget(root) === 'file') {
        // 点名到文件就搜这一个文件：外部后端对显式给出的文件不套排除项，两边要一样。
        yield root;
        return;
      }
      // 点名到目录时，落在跳过的那几棵里面就不搜——外部后端那种情况下也不交命中，
      // 因为它按相对边界的路径套排除项。要读那些路径里的文件用 `read`。
      if (toPosix(relative(boundary, root)).split('/').some((part) => skipped.includes(part))) return;
      for await (const file of walkFiles(root, skipped)) yield join(root, file);
    }

    for await (const target of candidates()) {
      if (signal?.aborted) throw new KernelError('search_cancelled', { detail: 'the content search was cancelled before it finished' });
      scannedFiles += 1;
      if (scannedFiles > scanFiles) {
        // 剩下没走的那一截没数过，所以标记里说「没读完」而不是报一个数不清的数。
        stopped = `incomplete: ${scanFiles} file(s) scanned, the rest of the tree was not read`;
        break;
      }
      if (!(await scan(target))) break;
    }

    // 标记里分开说三件事：命中数用完、扫描预算或文件数见底、跳过了几份二进制。
    const notes = stopped === '' ? [] : [stopped];
    if (binaries > 0) notes.push(`${binaries} binary file(s) skipped`);
    return { text: (hits.length === 0 ? '(no matches)' : hits.join('\n')) + (notes.length === 0 ? '' : marker(notes.join('; '))) };
  },
};

export const readOnlyTools = Object.freeze([readTool, findTool, searchTool]);
