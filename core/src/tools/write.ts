// 写操作包括 `create`、`write`、`edit` 和 `delete`。
// 每种操作在工具内部执行语义校验并返回稳定错误码；删除目标由能力提供方选择去处。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { KernelError } from '../kernel/error.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import { boundaryOf, limitsOf, workingDirectoryOf } from '../capability/limits.js';
import { resolveWithin } from '../capability/paths.js';
import { resolveRecycler } from '../capability/recycle.js';
import { versionOf } from '../session/observe.js';
import { errorCode, errorMessage, existsOrFails, toPosix } from './common.js';

interface CreateArguments { path: string; content: string }
interface WriteArguments { path: string; content: string }
interface EditArguments { path: string; anchor: string; replacement: string }
interface DeleteArguments { path: string }
type WriteToolContext = Pick<ToolContext, 'config' | 'observations' | 'logger'>;

export const createTool = {
  name: 'create',
  access: 'write',
  description: 'Create a new text file relative to the working directory, within the workspace boundary. Fails when the file already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      content: { type: 'string', description: 'The whole file content.' },
    },
    required: ['path', 'content'],
  },
  async run(args: CreateArguments, { config, observations }: WriteToolContext) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, args.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new KernelError('create_target_exists', { detail: `${args.path} already exists; use write to replace its whole content or edit to change one part of it` });
      }
      throw error;
    }
    observations?.observe(target, versionOf(Buffer.from(args.content, 'utf8')));
    return { text: `created ${toPosix(relative(boundary, target))} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
  },
} satisfies ToolDefinition<CreateArguments>;

export const writeTool = {
  name: 'write',
  access: 'write',
  description: 'Replace the whole content of an existing text file relative to the working directory, within the workspace boundary. The file must have been read in this run and must not have changed since. Use create for a file that does not exist yet.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      content: { type: 'string', description: 'The whole new file content.' },
    },
    required: ['path', 'content'],
  },
  // `write` 仅修改已存在文件；新建由 `create` 处理。
  // 覆盖前必须匹配此前完整读取时记录的版本，拒绝使用过时内容覆盖文件。
  // 版本检查与写入不是底层原子操作，不能防止并发写入之间的竞态。
  async run(args: WriteArguments, { config, observations }: WriteToolContext) {
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    let before;
    try {
      before = await readFile(target);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') throw new KernelError('write_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${code ?? errorMessage(error)}` });
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
} satisfies ToolDefinition<WriteArguments>;

export const editTool = {
  name: 'edit',
  access: 'write',
  description: 'Replace one unique occurrence of an anchor in an existing file relative to the working directory, within the workspace boundary.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory, within the workspace boundary.' },
      anchor: { type: 'string', description: 'Text to locate; it must appear exactly once in the file.' },
      replacement: { type: 'string', description: 'Text to put in place of the anchor.' },
    },
    required: ['path', 'anchor', 'replacement'],
  },
  async run(args: EditArguments, { config, observations }: WriteToolContext) {
    const boundary = boundaryOf(config);
    if (args.anchor.trim() === '') {
      throw new KernelError('edit_anchor_empty', { detail: 'an anchor of only whitespace would match anywhere; give the text to locate' });
    }
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      // 目标不存在时应使用 `create`。
      const code = errorCode(error);
      if (code === 'ENOENT') throw new KernelError('edit_target_missing', { detail: `${args.path} does not exist; create is the tool for a file that is not there yet` });
      throw new KernelError('path_resolve_failed', { cause: error, detail: `reading ${args.path} failed: ${code ?? errorMessage(error)}` });
    }
    const hits = text.split(args.anchor).length - 1;
    if (hits === 0) throw new KernelError('edit_anchor_not_found', { detail: `the anchor does not appear in ${args.path}` });
    // 定位字符串必须唯一匹配，避免模型在多个位置中任意选择修改目标。
    if (hits > 1) {
      throw new KernelError('edit_anchor_ambiguous', { detail: `the anchor appears ${hits} times in ${args.path}; widen it until one occurrence is left` });
    }
    const updated = text.replace(args.anchor, args.replacement);
    await writeFile(target, updated, 'utf8');
    observations?.observe(target, versionOf(Buffer.from(updated, 'utf8')));
    return { text: `edited ${toPosix(relative(boundary, target))}` };
  },
} satisfies ToolDefinition<EditArguments>;

export const deleteTool = {
  name: 'delete',
  access: 'write',
  description: 'Move a file or directory relative to the working directory, within the workspace boundary, into the trash: the system recycle bin where there is one, otherwise a trash directory inside the boundary. Nothing is deleted in place.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory, within the workspace boundary.' },
    },
    required: ['path'],
  },
  async run(args: DeleteArguments, { config, logger, observations }: WriteToolContext) {
    const { trashDirectory } = limitsOf(config);
    const boundary = boundaryOf(config);
    const target = await resolveWithin(boundary, args.path, { forWrite: true, cwd: workingDirectoryOf(config) });
    const name = toPosix(relative(boundary, target));
    if (name === '') throw new KernelError('delete_target_is_boundary', { detail: 'the workspace boundary itself cannot be moved into the trash; name a file or directory inside it' });
    if (!(await existsOrFails(target))) throw new KernelError('delete_target_missing', { detail: `there is nothing at ${args.path} to move into the trash` });

    // 删除去处由 `trashBackend` 配置决定。`auto` 优先使用系统回收站，否则使用项目回收目录。
    // `system` 和 `managed` 固定使用指定后端；后端不可用时返回错误，不自动切换。
    const backend = config.trashBackend ?? 'auto';
    if (backend !== 'auto' && backend !== 'system' && backend !== 'managed') {
      throw new KernelError('delete_trash_backend_unknown', { detail: `"${backend}" is not a trash backend; the choices are auto, system and managed` });
    }
    if (backend !== 'managed') {
      const resolution = await resolveRecycler();
      if (resolution.recycler !== undefined) {
        const { recycler } = resolution;
        try {
          await recycler.send(target);
          observations?.forget(target);
          return { text: `sent ${name} to the ${recycler.name}` };
        } catch (error) {
          // 系统回收站无法接收目标时，回退到项目回收目录并记录原因。
          if (backend === 'system') throw error;
          logger.log(`the ${recycler.name} refused this deletion, falling back to ${trashDirectory}`, { tool: 'delete', code: errorCode(error) });
        }
      } else if (backend === 'system') {
        throw new KernelError(resolution.code, { detail: `no system recycle bin is available here (${resolution.code}), and trashBackend is pinned to system` });
      } else {
        logger.debug(`no system recycle bin on this platform, using ${trashDirectory}`, { tool: 'delete', code: resolution.code });
      }
    }
    const trash = await resolveWithin(boundary, trashDirectory, { forWrite: true, cwd: boundary });
    await mkdir(trash, { recursive: true });
    const destination = await resolveWithin(boundary, trashDirectory, { forWrite: true, cwd: boundary });
    // 使用时间戳和随机后缀生成回收文件名，避免同名目标同时删除时冲突。
    await rename(target, join(destination, `${Date.now()}-${randomUUID().slice(0, 8)}--${name.split('/').join('__')}`));
    observations?.forget(target);
    return { text: `moved ${name} into ${trashDirectory}` };
  },
} satisfies ToolDefinition<DeleteArguments>;

export const writeTools = Object.freeze([createTool, writeTool, editTool, deleteTool]);
