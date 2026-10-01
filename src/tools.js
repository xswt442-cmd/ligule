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

export function boundaryOf(config) {
  if (typeof config.boundary !== 'string' || config.boundary === '') throw new KernelError('boundary_required');
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

// 深度优先遍历边界内的文件，交出相对边界、用斜杠书写的路径。目录项按名字排序，
// 这样同一份文件树两次扫出来的顺序一样，截断时留下的那一截也一样。
async function* walkFiles(root) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.includes(entry.name) && !entry.name.startsWith('.')) stack.push(full);
      } else if (entry.isFile()) {
        yield toPosix(relative(root, full));
      }
    }
  }
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
    if (error.code === 'ENOENT') throw new KernelError('path_not_found');
    throw new KernelError('path_resolve_failed', { cause: error });
  }
}

export const findTool = {
  name: 'find',
  description: 'Find files by name pattern inside the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Name pattern: * and ? stop at a path separator, ** crosses it.' },
      path: { type: 'string', description: 'Subdirectory to search from, relative to the boundary.' },
    },
    required: ['pattern'],
  },
  async run(args, { config }) {
    const { resultCount } = limitsOf(config);
    const boundary = boundaryOf(config);
    const root = args.path === undefined ? boundary : await resolveWithin(boundary, args.path);
    // 遍历的起点必须是目录：交给 walkFiles 的话，readdir 会对文件抛原始的 ENOTDIR，
    // 那一类错误没有稳定码，判定链与调用方都没法分支。
    if (await kindOfTarget(root) !== 'directory') throw new KernelError('find_path_not_directory');
    const names = [];
    let scanned = 0;
    for await (const name of walkFiles(root)) {
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

// ponytail: search 用 Node 自己遍历、逐行做字面匹配，代价是每次搜索线性扫过 scanFiles 个文件、
// scanBytes 字节。升级路线是换一个外部搜索后端（ripgrep 一类）并给它一条能力探测，
// 那条依赖属于未定的选型项，先不引入。
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
  async run(args, { config }) {
    const { resultCount, scanBytes, scanFiles } = limitsOf(config);
    const boundary = boundaryOf(config);
    const hits = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let skipped = 0;
    let exhausted = false;

    // 返回 false 表示命中数已经用完、不用再扫后面的文件。
    async function scan(target) {
      const file = toPosix(relative(boundary, target));
      const bytes = await readFile(target);
      // 含零字节的按二进制对待；超过扫描预算的文件整个跳过。两者都记进最后一行的标记里，
      // 跳过之后继续扫下一个文件。
      if (bytes.includes(0) || scannedBytes + bytes.length > scanBytes) {
        skipped += 1;
        return true;
      }
      scannedBytes += bytes.length;
      const lines = bytes.toString('utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(args.pattern)) continue;
        if (hits.length === resultCount) {
          exhausted = true;
          return false;
        }
        hits.push(`${file}:${index + 1}:${lines[index]}`);
      }
      return true;
    }

    // 描述里写的「文件或子目录」两种都成立：给定 path 时按它实际是哪种分派，
    // 把目录当文件读会抛原始的 EISDIR，没有稳定码。
    async function* candidates() {
      if (args.path === undefined) {
        for await (const file of walkFiles(boundary)) yield join(boundary, file);
        return;
      }
      const root = await resolveWithin(boundary, args.path);
      if (await kindOfTarget(root) === 'file') {
        yield root;
        return;
      }
      for await (const file of walkFiles(root)) yield join(root, file);
    }

    for await (const target of candidates()) {
      scannedFiles += 1;
      if (scannedFiles > scanFiles) {
        skipped += 1;
        break;
      }
      if (!(await scan(target))) break;
    }

    const note = exhausted
      ? marker(`truncated: ${resultCount} matches shown and more follow, narrow the pattern`)
      : skipped > 0 ? marker(`${skipped} file(s) skipped: binary, beyond the scan budget, or the file limit`) : '';
    return { text: hits.join('\n') + note };
  },
};

async function existsOrFails(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new KernelError('path_resolve_failed', { cause: error });
  }
}

// 目录还是文件，两种工具都按这个分派；不存在时给一个可以分支的码，而不是让 readdir 与 readFile 抛原始错误。
async function kindOfTarget(path) {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error.code === 'ENOENT') throw new KernelError('path_not_found');
    throw new KernelError('path_resolve_failed', { cause: error });
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
    if (await existsOrFails(target)) throw new KernelError('create_target_exists');
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
      if (error.code === 'ENOENT') throw new KernelError('write_target_missing');
      throw new KernelError('path_resolve_failed', { cause: error });
    }
    const observed = observations?.versionAt(target);
    if (observed === undefined) throw new KernelError('write_not_observed');
    if (observed !== versionOf(before)) throw new KernelError('write_version_stale');
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
    if (args.anchor.trim() === '') throw new KernelError('edit_anchor_empty');
    const target = await resolveWithin(boundary, args.path, { forWrite: true });
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      // 目标不存在时 create 才是那件成立的动作（D3）。
      if (error.code === 'ENOENT') throw new KernelError('edit_target_missing');
      throw new KernelError('path_resolve_failed', { cause: error });
    }
    const hits = text.split(args.anchor).length - 1;
    if (hits === 0) throw new KernelError('edit_anchor_not_found');
    // 多重匹配时选哪一处由模型决定是不可审计的，所以要求定位串唯一（D3）。
    if (hits > 1) throw new KernelError('edit_anchor_ambiguous');
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
    if (name === '') throw new KernelError('delete_target_is_boundary');
    if (!(await existsOrFails(target))) throw new KernelError('delete_target_missing');

    // 去处由配置的 trashBackend 定：auto 是「有系统回收站就用它，没有就用项目内那个目录」，
    // system 与 managed 各自钉死一条，钉死的那一条不成立时报错而不是悄悄换另一条。
    const backend = config.trashBackend ?? 'auto';
    if (backend !== 'auto' && backend !== 'system' && backend !== 'managed') {
      throw new KernelError('delete_trash_backend_unknown', { detail: String(backend) });
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
        throw new KernelError(code);
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
