// 扩展的装载与窄接口（D37、D68、第 29 步）。
//
// 来源只有两处：使用者明确安装进来的目录，与用户层配置或命令行写出来的路径。项目层与本地层里写的扩展路径不算
// （D68：仓库里的东西不该决定宿主进程加载什么代码），它们变成一条看得见的诊断而不是静默丢掉。
//
// 递给扩展的是宿主交出的那四件（D37）：注册工具、注册提示词片段、收事件、请求一次能力操作。这一份对象就是
// 契约承诺的全部暴露面；它不是「限制」——进程内加载的模块技术上能做任何 Node 代码能做的事，所以判定链、路径边界
// 与参数校验对每一次调用照常生效，不把安全建立在扩展的自我约束上。
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KernelError } from './error.js';
import { dataRoot } from './config-file.js';

interface ExtensionConfig {
  registerTool?: (tool: unknown) => () => void;
  registerPrompt?: (fragment: { name: string; text: string }) => () => void;
  onEvent?: (handler: (event: unknown) => void) => () => void;
  request?: (tool: string, args?: unknown) => Promise<unknown>;
}

export interface ExtensionDiagnostic {
  code: string;
  path: string;
  detail: string;
}

interface SourceLayers {
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
  local?: Record<string, unknown>;
  flag?: Record<string, unknown>;
  managed?: Record<string, unknown>;
}

interface SourceOptions {
  projectRoot: string;
  userHome?: string;
  readDirectory?: (path: string) => Promise<string[]>;
}

// 配置里那一格只认字符串数组：写成一个对象或一个字符串都是清单读不出来的东西，报出去而不是猜。
function entriesOf(layer: Record<string, unknown> | undefined): string[] | { invalid: string } {
  const value = layer?.extensions;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return { invalid: JSON.stringify(value) };
  return value as string[];
}

async function installedIn(directory: string, readDirectory: (path: string) => Promise<string[]>): Promise<string[]> {
  let names;
  try {
    names = await readDirectory(directory);
  } catch (error) {
    // 没有这个目录是正常状态：一行都没装过，与「装过但读不了」是两回事，后者才要一条诊断。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new KernelError('extension_directory_read_failed', { cause: error, detail: `${directory}: ${(error as Error).message}` });
  }
  return names.filter((name) => name.endsWith('.js')).sort().map((name) => join(directory, name));
}

// 交回这一具 Host 该加载哪些文件：安装目录里的每一份，加上用户层与命令行显式写出来的路径。
// 项目层与本地层里写的路径进 ignored，一条都不加载（D68）。
export async function extensionSources(layers: SourceLayers = {}, { projectRoot, userHome = homedir(), readDirectory = readdir }: SourceOptions) {
  const relativeTo = (entry: string) => (isAbsolute(entry) ? entry : resolve(projectRoot, entry));
  const ignored: ExtensionDiagnostic[] = [];
  const declared: string[] = [];
  for (const layer of ['managed', 'user', 'flag'] as const) {
    const entries = entriesOf(layers[layer]);
    if (!Array.isArray(entries)) {
      ignored.push({ code: 'extension_entries_invalid', path: layer, detail: `extensions must be an array of paths, got ${entries.invalid}` });
      continue;
    }
    declared.push(...entries.map(relativeTo));
  }
  for (const layer of ['project', 'local'] as const) {
    const entries = entriesOf(layers[layer]);
    if (Array.isArray(entries) && entries.length > 0) {
      ignored.push({
        code: 'extension_source_ignored',
        path: layer,
        detail: `${entries.length} extension path(s) in the ${layer} layer are not loaded: a repository does not decide what code this process runs (D68)`,
      });
    } else if (!Array.isArray(entries)) {
      ignored.push({ code: 'extension_entries_invalid', path: layer, detail: `extensions must be an array of paths, got ${entries.invalid}` });
    }
  }
  const installed = await installedIn(join(dataRoot(userHome), 'extensions'), readDirectory);
  // 同一个文件被安装目录与配置各写一次时只加载一次：路径先归一，再看谁先出现。
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of [...installed, ...declared]) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(key);
  }
  return { paths, ignored, installedDirectory: join(dataRoot(userHome), 'extensions') };
}

interface LoadOptions {
  config: { limits?: Record<string, unknown> };
  registerTool: (tool: unknown) => () => void;
  registerFragment: (fragment: { name: string; text: string; source: string }) => () => void;
  addEventListener: (handler: (event: unknown) => void) => () => void;
  request: (tool: string, args?: unknown) => Promise<unknown>;
  importModule?: (url: string) => Promise<{ default?: unknown }>;
}

// 一件扩展装上了什么，撤的时候只撤它自己那一份：坏掉的那一件不该留下半截，也不该带走别人已经装上的东西。
export async function loadExtensions(paths: string[], options: LoadOptions) {
  const loaded: { name: string; path: string }[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];
  const undo: (() => void)[] = [];

  for (const path of paths) {
    const owns: (() => void)[] = [];
    try {
      const imported = await (options.importModule ?? ((url: string) => import(url)))(pathToFileURL(path).href);
      const factory = imported.default;
      if (typeof factory !== 'function') throw new KernelError('extension_shape_invalid', { detail: 'the module has no default export to call' });
      const name = factory.name === '' ? path : factory.name;
      // 递出去的就是这四件（D37）：连「你是哪一个扩展」都不给，扩展能做的全部事情都在这张表里。
      const config = {
        registerTool: (tool: unknown) => {
          const remove = options.registerTool(tool);
          owns.push(remove);
          return remove;
        },
        registerPrompt: (fragment: { name: string; text: string }) => {
          if (typeof fragment?.name !== 'string' || fragment.name === '') throw new KernelError('extension_fragment_name_required');
          if (typeof fragment.text !== 'string') throw new KernelError('extension_fragment_text_required');
          const remove = options.registerFragment({ name: fragment.name, text: fragment.text, source: path });
          owns.push(remove);
          return remove;
        },
        onEvent: (handler: (event: unknown) => void) => {
          if (typeof handler !== 'function') throw new KernelError('extension_handler_required');
          const remove = options.addEventListener((event) => {
            try {
              handler(event);
            } catch (error) {
              // 半成品扩展抛的未知错误不该停住这一轮：记一条，继续跑（内核自己的故障是另一类，走另一条码）。
              diagnostics.push({ code: 'extension_handler_failed', path, detail: error instanceof Error ? error.message : String(error) });
            }
          });
          owns.push(remove);
          return remove;
        },
        request: (tool: string, args?: unknown) => options.request(tool, args),
      };
      const disposer = await factory(Object.freeze(config));
      if (disposer !== undefined && typeof disposer !== 'function') {
        throw new KernelError('extension_dispose_invalid', { detail: 'the setup returned something that is not a function' });
      }
      owns.push(() => {
        if (typeof disposer === 'function') disposer();
      });
      undo.push(() => {
        for (const remove of owns.reverse()) remove();
      });
      loaded.push({ name, path });
    } catch (error) {
      for (const remove of owns.reverse()) remove();
      const failure = error instanceof KernelError ? error : new KernelError('extension_load_failed', { cause: error });
      diagnostics.push({ code: failure.code, path, detail: failure.detail ?? (error as Error).message });
    }
  }

  return {
    loaded,
    diagnostics,
    dispose() {
      while (undo.length > 0) undo.pop()!();
    },
  };
}
