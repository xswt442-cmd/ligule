// 写操作四件（D3）：`create`、`write`、`edit`、`delete`。
// 四条语义约束落在工具内部，每条带一个稳定错误码；`delete` 的去处由能力提供者那一层给（D18）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { boundaryOf, limitsOf } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { resolveRecycler } from '../capability/recycle.js';
import { versionOf } from '../session/observe.js';
import { existsOrFails, kindOfTarget, toPosix } from './common.js';

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
    // system 与 managed 各自固定一条路径，那条路径不成立时报错，不悄悄换另一条。
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

export const writeTools = Object.freeze([createTool, writeTool, editTool, deleteTool]);
