// 扩展只从用户明确安装的目录、用户配置或命令行指定的路径加载。
// 项目配置不能控制 Host 加载可执行代码；其中的扩展路径会作为诊断报告，而不会静默忽略。
//
// 安装目录支持两种形态：单个 `.js` 文件，或一个包含 `index.js` 的子目录（一目录一包）。
// 用户可以在启停登记中停用已安装的扩展；登记只过滤安装目录，不影响配置层显式声明的路径。
//
// 扩展接口提供工具注册、提示片段注册、事件通知和能力请求。
// 扩展代码与 Host 运行在同一进程，接口不是操作系统沙箱；每次工具调用仍需经过权限判定、路径边界和参数校验。
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KernelError } from './error.js';
import { dataRoot } from './config-file.js';

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
  // 启停登记中已停用的安装名；缺省表示没有停用任何扩展。
  disabled?: readonly string[];
}

// 配置来源必须是字符串数组；其他类型返回明确错误，不尝试猜测其含义。
function entriesOf(layer: Record<string, unknown> | undefined): string[] | { invalid: string } {
  const value = layer?.extensions;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return { invalid: JSON.stringify(value) };
  return value as string[];
}

// 安装名是文件主名或目录名；启停登记与界面展示都用它，避免暴露绝对路径。
export function installNameOf(path: string): string {
  const base = basename(path);
  return base === 'index.js' ? basename(dirname(path)) : base.replace(/\.js$/u, '');
}

async function installedIn(directory: string, readDirectory: (path: string) => Promise<string[]>): Promise<{ paths: string[]; diagnostics: ExtensionDiagnostic[] }> {
  let names;
  try {
    names = await readDirectory(directory);
  } catch (error) {
    // 安装目录不存在时视为空列表；其他读取错误需报告诊断。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paths: [], diagnostics: [] };
    throw new KernelError('extension_directory_read_failed', { cause: error, detail: `${directory}: ${(error as Error).message}` });
  }
  const paths: string[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];
  for (const name of names.sort()) {
    if (name.endsWith('.js')) {
      paths.push(join(directory, name));
      continue;
    }
    if (name.endsWith('.json') || name.endsWith('.lock') || name.startsWith('.')) continue;
    const child = join(directory, name);
    let inner: string[];
    try {
      inner = await readDirectory(child);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 不是目录（普通文件）或已消失的条目按无法识别跳过；其他读取错误如实报告。
      if (code === 'ENOTDIR' || code === 'ENOENT') continue;
      throw new KernelError('extension_directory_read_failed', { cause: error, detail: `${child}: ${(error as Error).message}` });
    }
    if (inner.includes('index.js')) {
      paths.push(join(child, 'index.js'));
      continue;
    }
    diagnostics.push({
      code: 'extension_package_index_missing',
      path: child,
      detail: 'an extension directory package needs an index.js entry',
    });
  }
  return { paths, diagnostics };
}

// 返回 Host 应加载的扩展文件：安装目录内容及用户层、命令行显式指定的路径。
// 项目层和本地层中的路径列入 `ignored`，不会加载。安装目录中被停用的扩展列入 `disabled`。
export async function extensionSources(layers: SourceLayers = {}, { projectRoot, userHome = homedir(), readDirectory = readdir, disabled = [] }: SourceOptions) {
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
  const off = new Set(disabled);
  const active: string[] = [];
  const disabledEntries: { name: string; path: string }[] = [];
  const installNames: Record<string, string> = {};
  for (const path of installed.paths) {
    const installName = installNameOf(path);
    installNames[resolve(path)] = installName;
    if (off.has(installName)) {
      disabledEntries.push({ name: installName, path });
      continue;
    }
    active.push(path);
  }
  // 对路径归一后去重，避免同一扩展通过多个来源重复加载。
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of [...active, ...declared]) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(key);
  }
  return {
    paths,
    ignored: [...ignored, ...installed.diagnostics],
    installedDirectory: join(dataRoot(userHome), 'extensions'),
    installNames,
    disabled: disabledEntries,
  };
}

interface LoadOptions {
  registerTool: (tool: unknown) => () => void;
  registerFragment: (fragment: { name: string; text: string; source: string }) => () => void;
  addEventListener: (handler: (event: unknown) => void) => () => void;
  request: (tool: string, args?: unknown) => Promise<unknown>;
  importModule?: (url: string) => Promise<{ default?: unknown }>;
}

// 每个扩展只撤销自己注册的内容；加载失败时不留下部分注册，也不影响其他扩展。
export async function loadExtensions(paths: string[], options: LoadOptions) {
  const loaded: { name: string; path: string; tools: string[] }[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];
  const undo: (() => void)[] = [];

  for (const path of paths) {
    const owns: (() => void)[] = [];
    const tools: string[] = [];
    try {
      const imported = await (options.importModule ?? ((url: string) => import(url)))(pathToFileURL(path).href);
      const factory = imported.default;
      if (typeof factory !== 'function') throw new KernelError('extension_shape_invalid', { detail: 'the module has no default export to call' });
      const name = factory.name === '' ? path : factory.name;
      // 只暴露扩展 API 中声明的能力，不额外提供扩展身份或 Host 内部对象。
      const config = {
        registerTool: (tool: unknown) => {
          const remove = options.registerTool(tool);
          owns.push(remove);
          if (typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string') tools.push(tool.name);
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
              // 将扩展抛出的未知错误记录为诊断并继续处理；Kernel 自身错误仍按独立错误路径抛出。
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
      loaded.push({ name, path, tools });
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
