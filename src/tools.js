// 最小配置里的七件工具：只读的 `read`、`find`、`search` 与写的 `create`、`write`、`edit`、`delete`
// （成员与写操作语义见 architecture.md 第四节与 decisions.md D3）。
// 只读那三件交回的内容受字节与条数上限约束，超限时在文本里留下一行看得见的截断标记（I6）。
// 上限、边界与回收站目录都从配置快照读，工具不读别处：config.boundary、config.limits、config.trash。
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { KernelError } from './error.js';
import { matchesName } from './match.js';
import { versionOf } from './observe.js';
import { resolveWithin } from './paths.js';
import { resolveRecycler } from './recycle.js';
import { resolveRipgrep, searchWithRipgrep } from './ripgrep.js';

// 起点值由本项目自定，配置层可以逐键覆盖；分页单位与标记措辞没有外部来源。
export const DEFAULT_LIMITS = Object.freeze({
  readBytes: 64_000,
  resultCount: 200,
  scanBytes: 2_000_000,
  scanFiles: 5_000,
  execBytes: 32_000,
  trashDirectory: '.ligule-trash',
});

// 遍历跳过这些目录：它们的内容不是要找的东西，扫过去只会把上限用光。
const SKIPPED_DIRECTORIES = ['node_modules', '.git'];

// 回收站那个目录也在跳过之列：隐藏目录现在搜得到，删掉的东西不该再以第二次命中出现。
// 名字可以由配置改，所以两条后端都得从配置取，不能写死。
function skippedDirectories(config) {
  return [...SKIPPED_DIRECTORIES, limitsOf(config).trashDirectory];
}

export function boundaryOf(config) {
  if (typeof config.boundary !== 'string' || config.boundary === '') {
    throw new KernelError('boundary_required', { detail: 'the host configured no workspace boundary, so file tools have nowhere to work' });
  }
  return config.boundary;
}

export function limitsOf(config) {
  return { ...DEFAULT_LIMITS, ...config.limits };
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function marker(detail) {
  return `\n[${detail}]`;
}

// 深度优先遍历边界内的文件，交出相对边界、用斜杠书写的路径。
// 排序把目录名后面补一个斜杠再比，于是文件与子目录按路径的字典序交错出现：
// `src.txt` 排在 `src/app.js` 前面，与外部后端按路径排序那一条一样。
// 顺序固定下来，同一份文件树两次扫出来的结果与截断时留下的那一截才相同。
// 跳过的目录由调用方给，遍历只负责按上面的顺序走。
async function* walkFiles(root, skipped, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (orderKey(left) < orderKey(right) ? -1 : 1));
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.includes(entry.name)) yield* walkFiles(root, skipped, full);
    } else if (entry.isFile()) {
      yield toPosix(relative(root, full));
    }
  }
}

function orderKey(entry) {
  return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

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

async function readExisting(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new KernelError('path_not_found', { detail: `there is nothing to read at ${path}` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${path} failed: ${error.code ?? error.message}` });
  }
}

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

    // 有外部后端就用它：八千个文件的树上一秒出头，自己遍历要三倍耗时（数字记在 todo.md 第 6 步）。
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

async function existsOrFails(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${path} failed: ${error.code ?? error.message}` });
  }
}

// 目录还是文件，两种工具都按这个分派；不存在时给一个可以分支的码，而不是让 readdir 与 readFile 抛原始错误。
async function kindOfTarget(path) {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error.code === 'ENOENT') throw new KernelError('path_not_found', { detail: `there is nothing at ${path}` });
    throw new KernelError('path_resolve_failed', { cause: error, detail: `checking ${path} failed: ${error.code ?? error.message}` });
  }
}

export const createTool = {
  name: 'create',
  description: 'Create a new text file inside the workspace boundary. Fails when the file already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace boundary.' },
      content: { type: 'string', description: 'The whole file content.' },
    },
    required: ['path', 'content'],
  },
  async run(args, { config, observations }) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true });
    // 已存在就报错、一个字节都不写：覆盖是 write 的动作，分开才让判定链看得见差别（D3）。
    if (await existsOrFails(target)) {
      throw new KernelError('create_target_exists', { detail: `${args.path} already exists; use write to replace its whole content or edit to change one part of it` });
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, args.content, 'utf8');
    observations?.observe(target, versionOf(Buffer.from(args.content, 'utf8')));
    return { text: `created ${toPosix(relative(boundary, target))} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
  },
};

export const writeTool = {
  name: 'write',
  description: 'Replace the whole content of an existing text file inside the workspace boundary. The file must have been read in this run and must not have changed since. Use create for a file that does not exist yet.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace boundary.' },
      content: { type: 'string', description: 'The whole new file content.' },
    },
    required: ['path', 'content'],
  },
  // 与 create 互斥：这一件只在目标已存在时成立，新建走 create，判定链因此分得开两种动作（D3）。
  // 覆盖之前必须对上一次完整观察的版本令牌，令牌对不上就说明文件在读过之后变了。
  // ponytail: 校验与写入之间有一个竞态窗口，并发写者能钻进去；这一层挡的是模型拿着过时的内容覆盖，
  // 不是并发控制。升级路线是把「按版本替换」下沉到能力提供者的后端原子地做。
  async run(args, { config, observations }) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true });
    let before;
    try {
      before = await readFile(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new KernelError('write_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${error.code ?? error.message}` });
    }
    const observed = observations?.versionAt(target);
    if (observed === undefined) {
      throw new KernelError('write_not_observed', { detail: `${args.path} has not been read in this run; read it in full first, then write` });
    }
    if (observed !== versionOf(before)) {
      throw new KernelError('write_version_stale', { detail: `${args.path} changed since it was read; read it again before replacing its content` });
    }
    await writeFile(target, args.content, 'utf8');
    observations?.observe(target, versionOf(Buffer.from(args.content, 'utf8')));
    return { text: `wrote ${toPosix(relative(boundary, target))} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
  },
};

export const editTool = {
  name: 'edit',
  description: 'Replace one unique occurrence of an anchor in an existing file inside the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace boundary.' },
      anchor: { type: 'string', description: 'Text to locate; it must appear exactly once in the file.' },
      replacement: { type: 'string', description: 'Text to put in place of the anchor.' },
    },
    required: ['path', 'anchor', 'replacement'],
  },
  async run(args, { config, observations }) {
    const boundary = boundaryOf(config);
    if (args.anchor.trim() === '') {
      throw new KernelError('edit_anchor_empty', { detail: 'an anchor of only whitespace would match anywhere; give the text to locate' });
    }
    const target = await resolveWithin(boundary, args.path, { forWrite: true });
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      // 目标不存在时 create 才是那件成立的动作（D3）。
      if (error.code === 'ENOENT') throw new KernelError('edit_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${error.code ?? error.message}` });
    }
    const hits = text.split(args.anchor).length - 1;
    if (hits === 0) throw new KernelError('edit_anchor_not_found', { detail: `the anchor does not appear in ${args.path}` });
    // 多重匹配时选哪一处由模型决定是不可审计的，所以要求定位串唯一（D3）。
    if (hits > 1) {
      throw new KernelError('edit_anchor_ambiguous', { detail: `the anchor appears ${hits} times in ${args.path}; widen it until one occurrence is left` });
    }
    const updated = text.replace(args.anchor, args.replacement);
    await writeFile(target, updated, 'utf8');
    observations?.observe(target, versionOf(Buffer.from(updated, 'utf8')));
    return { text: `edited ${toPosix(relative(boundary, target))}` };
  },
};

export const deleteTool = {
  name: 'delete',
  description: 'Move a file or directory inside the workspace boundary into the trash: the system recycle bin where there is one, otherwise a trash directory inside the boundary. Nothing is deleted in place.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace boundary.' },
    },
    required: ['path'],
  },
  async run(args, { config, logger, observations }) {
    const { trashDirectory } = limitsOf(config);
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true });
    const name = toPosix(relative(boundary, target));
    if (name === '') throw new KernelError('delete_target_is_boundary', { detail: 'the workspace boundary itself cannot be moved into the trash; name a file or directory inside it' });
    if (!(await existsOrFails(target))) throw new KernelError('delete_target_missing', { detail: `there is nothing at ${args.path} to move into the trash` });

    // 去处由配置的 trashBackend 定：auto 是「有系统回收站就用它，没有就用项目内那个目录」，
    // system 与 managed 各自钉死一条，钉死的那一条不成立时报错而不是悄悄换另一条。
    const backend = config.trashBackend ?? 'auto';
    if (backend !== 'auto' && backend !== 'system' && backend !== 'managed') {
      throw new KernelError('delete_trash_backend_unknown', { detail: `"${backend}" is not a trash backend; the choices are auto, system and managed` });
    }
    if (backend !== 'managed') {
      const { recycler, code } = await resolveRecycler();
      if (recycler) {
        try {
          await recycler.send(target);
          observations?.forget(target);
          return { text: `sent ${name} to the ${recycler.name}` };
        } catch (error) {
          // 送不进去（例如回收站与目标不在同一个文件系统上）就回落，并把原因写进日志（I8）。
          if (backend === 'system') throw error;
          logger.log(`the ${recycler.name} refused this deletion, falling back to ${trashDirectory}`, { tool: 'delete', code: error.code });
        }
      } else if (backend === 'system') {
        throw new KernelError(code, { detail: `no system recycle bin is available here (${code}), and trashBackend is pinned to system` });
      } else {
        logger.debug(`no system recycle bin on this platform, using ${trashDirectory}`, { tool: 'delete', code });
      }
    }
    await mkdir(join(boundary, trashDirectory), { recursive: true });
    // 回收站里的名字带上时间戳与一段随机后缀，避免同一毫秒内两次删除同名撞车。
    await rename(target, join(boundary, trashDirectory, `${Date.now()}-${randomUUID().slice(0, 8)}--${name.split('/').join('__')}`));
    observations?.forget(target);
    return { text: `moved ${name} into ${trashDirectory}` };
  },
};

export const readOnlyTools = Object.freeze([readTool, findTool, searchTool]);
export const writeTools = Object.freeze([createTool, writeTool, editTool, deleteTool]);
