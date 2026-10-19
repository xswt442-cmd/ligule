// 模式是具名装配清单：`tools` 选择交给模型的已登记工具，`prompt` 选择提示词片段。
// 模式不定义技能、扩展或权限策略；这些分别由对应登记表和 Policy 管理。固定的 `skill` 披露入口不受模式筛选。
// 每个 TOML 文件定义一个模式，文件名就是模式名。查找顺序为随包、用户、项目；同名时采用优先级最高的整份文件，不跨层合并。
// 这里负责解析并校验提示词片段名称；实际名称会在扩展注册完成后由 Host 验证。
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { CONFIG_DIRECTORY, dataRoot } from './config-file.js';
import { KernelError } from './error.js';

export const MODE_DIRECTORY = 'modes';
// 未指定模式时使用随包提供的默认模式。
export const DEFAULT_MODE = 'minimal';
const MODE_FIELDS = ['tools', 'prompt'];

export type ModeLayer = 'shipped' | 'user' | 'project';

export interface ModeFile {
  name: string;
  layer: ModeLayer;
  path: string;
  tools: string[] | '*';
  prompt: string[] | '*';
  // 恢复会话时用摘要确认同名模式文件是否仍与打开会话时相同。
  // 摘要覆盖完整文件内容，包括注释和空白。
  digest: string;
}

export interface ModeDirectories {
  shipped: string;
  user: string;
  project: string;
}

// Host 使用解析结果选择可用工具和提示词片段；模式只能缩小工具集合。
// 固定披露入口不在可选清单中，不能由模式隐藏。
export interface ModeTarget {
  list(): string[];
  selectable(): string[];
  restrict(names: string[]): () => void;
}

export function modeDirectories(projectRoot: string, shippedDirectory: string, userHome = homedir()): ModeDirectories {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('mode_project_root_required');
  return {
    shipped: shippedDirectory,
    user: join(dataRoot(userHome), MODE_DIRECTORY),
    project: join(projectRoot, CONFIG_DIRECTORY, MODE_DIRECTORY),
  };
}

// 模式名会拼入搜索路径，因此校验字符和长度，避免目录穿越或无效文件名。
function checkedName(name: string): string {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new KernelError('mode_name_invalid', { detail: String(name) });
  }
  return name;
}

// 按优先级从高到低查找；第一个存在的文件完整定义该模式。
async function readDocument(name: string, directories: ModeDirectories): Promise<{ layer: ModeLayer; path: string; text: string }> {
  const order: { layer: ModeLayer; directory: string }[] = [
    { layer: 'project', directory: directories.project },
    { layer: 'user', directory: directories.user },
    { layer: 'shipped', directory: directories.shipped },
  ];
  const tried: string[] = [];
  for (const candidate of order) {
    const path = join(candidate.directory, `${name}.toml`);
    tried.push(path);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      // 某一层没有该模式时继续查找下一层；其他读取错误都应直接返回。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new KernelError('mode_file_read_failed', { cause: error, detail: `${candidate.layer}: ${path}` });
    }
    return { layer: candidate.layer, path, text };
  }
  throw new KernelError('mode_unknown', { detail: `${name} (looked in ${tried.join(', ')})` });
}

function readNameList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new KernelError('mode_field_invalid', { detail: `${field} must be an array of names: ${path}` });
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new KernelError('mode_field_invalid', { detail: `${field} takes non-empty strings only: ${path}` });
    }
    // 重复的工具或提示片段名称没有有效含义，因此拒绝该清单。
    if (names.includes(item)) throw new KernelError('mode_field_duplicate', { detail: `${field} names ${item} twice: ${path}` });
    names.push(item);
  }
  return names;
}

function readNames(value: unknown, field: string, path: string, allowStar: boolean): string[] | '*' {
  if (allowStar && value === '*') return '*';
  return readNameList(value, field, path);
}

export async function loadMode(name: string, directories: ModeDirectories): Promise<ModeFile> {
  const file = await readDocument(checkedName(name), directories);
  let document: unknown;
  try {
    document = parse(file.text);
  } catch (error) {
    // 模式字段格式错误时应报错，不能静默忽略。
    throw new KernelError('mode_file_invalid', { cause: error, detail: `${file.layer}: ${file.path}` });
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new KernelError('mode_file_invalid', { detail: file.path });
  }
  const fields = document as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    // 未知字段会导致校验失败，避免配置作者误以为该字段已生效。
    if (!MODE_FIELDS.includes(key)) throw new KernelError('mode_field_unknown', { detail: `${key}: ${file.path}` });
  }
  for (const key of MODE_FIELDS) {
    if (fields[key] === undefined) throw new KernelError('mode_field_missing', { detail: `${key} (required by every mode): ${file.path}` });
  }
  const tools = readNames(fields.tools, 'tools', file.path, true);
  // `prompt` 选择扩展登记的提示词片段。此处只校验名称格式；Host 会在扩展加载后确认名称是否存在，缺失时返回 `mode_prompt_unavailable`。
  const prompt = readNames(fields.prompt, 'prompt', file.path, true);
  // 摘要根据规范化后的工具和提示词名称顺序计算，用于检测同名模式内容是否改变。
  const digest = createHash('sha256').update(JSON.stringify({ tools, prompt })).digest('hex').slice(0, 12);
  return { name, layer: file.layer, path: file.path, tools, prompt, digest };
}

/** 返回客户端可选择的模式名称和无路径诊断。 */
export async function listModes(directories: ModeDirectories): Promise<{
  readonly modes: { readonly name: string; readonly layer: ModeLayer }[];
  readonly invalid: { readonly name: string; readonly code: string }[];
  readonly truncated: boolean;
}> {
  const names = new Set<string>();
  const ordered = [directories.project, directories.user, directories.shipped];
  for (const directory of ordered) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new KernelError('mode_directory_read_failed', { cause: error, detail: 'a mode directory could not be read' });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
      const name = entry.name.slice(0, -'.toml'.length);
      if (/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) names.add(name);
    }
  }
  const modes: { name: string; layer: ModeLayer }[] = [];
  const invalid: { name: string; code: string }[] = [];
  for (const name of [...names].sort()) {
    try {
      const mode = await loadMode(name, directories);
      modes.push({ name: mode.name, layer: mode.layer });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'mode_invalid';
      invalid.push({ name, code });
    }
  }
  return { modes: modes.slice(0, 128), invalid: invalid.slice(0, 128), truncated: modes.length > 128 || invalid.length > 128 };
}

// 模式引用未登记的工具时返回错误，不静默删去该项，以免实际工具清单与配置不符。
// 返回的撤销函数用于切换模式时移除本次限制，不会撤销其他调用添加的拒绝规则。
export function applyMode(kernel: ModeTarget, mode: ModeFile): { tools: string[]; undo: () => void } {
  const registered = kernel.list();
  const selectable = kernel.selectable();
  const selected = mode.tools;
  if (selected === '*') return { tools: registered, undo: () => {} };
  for (const name of selected) {
    if (!registered.includes(name)) {
      throw new KernelError('mode_tool_unregistered', { detail: `${name} (mode ${mode.name}; registered: ${registered.join(', ') || 'none'})` });
    }
    // 模式不能选择固定披露工具；若清单包含其名称，按无效配置处理。
    if (!selectable.includes(name)) {
      throw new KernelError('mode_tool_not_selectable', { detail: `${name} is a fixed disclosure tool (mode ${mode.name})` });
    }
  }
  const hidden = selectable.filter((name) => !selected.includes(name));
  const undo = hidden.length > 0 ? kernel.restrict(hidden) : () => {};
  return { tools: selected, undo };
}
