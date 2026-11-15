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
import { randomUUID } from 'node:crypto';
import { KernelError } from './error.js';
import { currentKernelExecutionContext, withKernelExecutionContext } from './execution-context.js';
import type { KernelExecutionContext } from './execution-context.js';
import type { TaskBudget } from './task-budget.js';
import { dataRoot } from './config-file.js';

export interface ExtensionDiagnostic {
  code: string;
  path: string;
  detail: string;
}

export type ExtensionHookPhase = 'prepareRequest' | 'beforeTool' | 'afterTool' | 'completeRun';
export interface ExtensionHookScope {
  readonly extension: string;
  readonly hook: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly source: 'human' | 'controller';
  readonly callId?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly userSeq?: number;
  readonly signal: AbortSignal;
}
export interface ExtensionRequestPreparationContext extends ExtensionHookScope {
  readonly requestId: string;
  readonly attempt: number;
  readonly system: string;
  readonly tools: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly request: ExtensionHookRequest;
}
export type ExtensionHookRequest = (tool: string, args?: unknown) => Promise<unknown>;
export type ExtensionRequestPreparationInput = Omit<ExtensionRequestPreparationContext, 'extension' | 'hook'>;
export interface ExtensionRequestPreparationResult {
  readonly context?: string;
}
export interface ExtensionBeforeToolContext extends ExtensionHookScope {
  readonly callId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly permission: { readonly profile: string; readonly network: string };
  readonly target?: string;
}
export type ExtensionBeforeToolResult =
  | { readonly decision: 'continue' }
  | { readonly decision: 'deny'; readonly reason: string };
export interface ExtensionAfterToolContext extends ExtensionHookScope {
  readonly callId: string;
  readonly tool: string;
  readonly outcome: 'completed' | 'failed' | 'denied';
  readonly result: unknown;
  readonly durationMs: number;
  readonly eventSeq?: number;
  readonly permission: { readonly profile: string; readonly network: string };
  readonly target?: string;
  readonly verdict?: Readonly<Record<string, unknown>>;
}
export interface ExtensionCompletionContext extends ExtensionHookScope {
  readonly userSeq: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly candidate: { readonly id: string; readonly fromSeq?: number; readonly toSeq?: number };
  readonly structuredDigest?: string;
  readonly completedBy?: string;
  readonly request: ExtensionHookRequest;
}
export type ExtensionCompletionResult =
  | { readonly decision: 'accept' }
  | { readonly decision: 'continue'; readonly reason: string }
  | { readonly decision: 'fail'; readonly reason: string };
export type ExtensionCompletionDecision =
  | { readonly decision: 'accept' }
  | { readonly decision: 'continue'; readonly context: string };
export type ExtensionCompletionInput = Omit<ExtensionCompletionContext, 'extension' | 'hook'>;
type MaybePromise<T> = T | Promise<T>;
export type ExtensionHook =
  | { readonly phase: 'prepareRequest'; readonly name: string; readonly run: (context: ExtensionRequestPreparationContext) => MaybePromise<ExtensionRequestPreparationResult | void> }
  | { readonly phase: 'beforeTool'; readonly name: string; readonly run: (context: ExtensionBeforeToolContext) => MaybePromise<ExtensionBeforeToolResult | void> }
  | { readonly phase: 'afterTool'; readonly name: string; readonly run: (context: ExtensionAfterToolContext) => MaybePromise<void> }
  | { readonly phase: 'completeRun'; readonly name: string; readonly run: (context: ExtensionCompletionContext) => MaybePromise<ExtensionCompletionResult | void> };
export interface ExtensionHookRegistration {
  readonly extension: string;
  readonly hook: ExtensionHook;
}
export interface ExtensionHookRegistry {
  forPhase(phase: ExtensionHookPhase): readonly ExtensionHookRegistration[];
}

export type ExtensionHookInvocationContext =
  | Omit<ExtensionRequestPreparationContext, 'extension' | 'hook'>
  | Omit<ExtensionBeforeToolContext, 'extension' | 'hook'>
  | Omit<ExtensionAfterToolContext, 'extension' | 'hook'>
  | Omit<ExtensionCompletionContext, 'extension' | 'hook'>;

function abortReason(signal: AbortSignal): KernelError {
  return signal.reason instanceof KernelError ? signal.reason : new KernelError('loop_cancelled', { cause: signal.reason });
}

function freezeSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot));
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) snapshot[key] = freezeSnapshot(item);
    return Object.freeze(snapshot);
  }
  return value;
}

/** Invoke one owned Hook under P10 execution scope and the existing per-request TaskBudget deadline. */
export async function runExtensionHook(registration: ExtensionHookRegistration, context: ExtensionHookInvocationContext,
  budget?: TaskBudget): Promise<unknown> {
  if (context.signal.aborted) throw abortReason(context.signal);
  let request: ReturnType<TaskBudget['request']> | undefined;
  try { request = budget?.request(context.signal); }
  catch (error) {
    if (context.signal.aborted) throw abortReason(context.signal);
    throw error;
  }
  const signal = request?.signal ?? context.signal;
  if (signal.aborted) {
    request?.dispose();
    throw abortReason(signal);
  }
  const parent = currentKernelExecutionContext();
  const scope = { active: true };
  const executionContext: KernelExecutionContext = {
    signal,
    callId: context.callId ?? parent?.callId ?? randomUUID(),
    sessionId: context.sessionId,
    runId: context.runId,
    source: context.source,
    executionId: context.executionId ?? parent?.executionId,
    parentRunId: context.parentRunId ?? parent?.parentRunId,
    parentExecutionId: context.parentExecutionId ?? parent?.parentExecutionId,
    userSeq: context.userSeq ?? parent?.userSeq,
    parentCallId: context.parentCallId ?? parent?.parentCallId,
    extensionHookPhase: registration.hook.phase,
    scope,
  };
  const contextData: Record<string, unknown> = { ...context };
  delete contextData.signal;
  const requestCapability = 'request' in context ? context.request : undefined;
  delete contextData.request;
  const contextSnapshot = freezeSnapshot(structuredClone(contextData)) as Record<string, unknown>;
  const hookContext = Object.freeze({
    ...contextSnapshot,
    extension: registration.extension,
    hook: registration.hook.name,
    signal,
    ...(requestCapability === undefined ? {} : { request: requestCapability }),
  });
  const invoke = () => {
    switch (registration.hook.phase) {
      case 'prepareRequest': return registration.hook.run(hookContext as ExtensionRequestPreparationContext);
      case 'beforeTool': return registration.hook.run(hookContext as ExtensionBeforeToolContext);
      case 'afterTool': return registration.hook.run(hookContext as ExtensionAfterToolContext);
      case 'completeRun': return registration.hook.run(hookContext as ExtensionCompletionContext);
    }
  };
  let onAbort: (() => void) | undefined;
  try {
    if (signal.aborted) throw abortReason(signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([
      Promise.resolve().then(() => withKernelExecutionContext(executionContext, invoke)),
      aborted,
    ]);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw new KernelError('extension_hook_failed', { detail: `${registration.extension}/${registration.hook.name}` });
  } finally {
    scope.active = false;
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    request?.dispose();
  }
}

/** Run request-preparation Hooks in registration order and fit their labeled context to the existing prompt budget. */
export async function prepareExtensionRequest(registry: ExtensionHookRegistry, context: ExtensionRequestPreparationInput,
  maxBytes: number, budget?: TaskBudget): Promise<ExtensionRequestPreparationResult | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new KernelError('extension_hook_limit_invalid');
  const contexts: string[] = [];
  let totalBytes = 0;
  for (const registration of registry.forPhase('prepareRequest')) {
    const result = await runExtensionHook(registration, context, budget);
    if (result === undefined) continue;
    if (!isRecord(result) || Object.keys(result).some((key) => key !== 'context')
      || (result.context !== undefined && typeof result.context !== 'string')) {
      throw new KernelError('extension_hook_result_invalid', { detail: `${registration.extension}/${registration.hook.name}` });
    }
    if (result.context === undefined || result.context.trim() === '') continue;
    const labelled = `[${registration.extension}/${registration.hook.name}]\n${result.context}`;
    totalBytes += Buffer.byteLength(labelled, 'utf8');
    if (totalBytes > maxBytes) {
      throw new KernelError('extension_hook_context_too_large', { detail: `${registration.extension}/${registration.hook.name}` });
    }
    contexts.push(labelled);
  }
  return contexts.length === 0 ? undefined : { context: contexts.join('\n\n') };
}

/** Run every completion check in order; any failure takes precedence over continuation. */
export async function completeExtensionRun(registry: ExtensionHookRegistry, context: ExtensionCompletionInput,
  maxBytes: number, budget?: TaskBudget, previousContext = ''): Promise<ExtensionCompletionDecision> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new KernelError('extension_hook_limit_invalid');
  const contexts = previousContext === '' ? [] : [previousContext];
  let totalBytes = Buffer.byteLength(previousContext, 'utf8');
  let failure: KernelError | undefined = totalBytes > maxBytes ? new KernelError('extension_hook_context_too_large') : undefined;
  let continued = false;
  for (const registration of registry.forPhase('completeRun')) {
    let result: unknown;
    try { result = await runExtensionHook(registration, context, budget); }
    catch (error) {
      if (context.signal.aborted) throw abortReason(context.signal);
      failure ??= error instanceof KernelError ? error : new KernelError('extension_hook_failed');
      continue;
    }
    if (result === undefined) continue;
    if (!isRecord(result) || typeof result.decision !== 'string') {
      failure ??= new KernelError('extension_hook_result_invalid', { detail: `${registration.extension}/${registration.hook.name}` });
      continue;
    }
    if (result.decision === 'accept') {
      if (Object.keys(result).some((key) => key !== 'decision')) {
        failure ??= new KernelError('extension_hook_result_invalid', { detail: `${registration.extension}/${registration.hook.name}` });
      }
      continue;
    }
    if ((result.decision !== 'continue' && result.decision !== 'fail')
      || Object.keys(result).some((key) => key !== 'decision' && key !== 'reason')
      || typeof result.reason !== 'string' || result.reason.trim() === ''
      || Buffer.byteLength(result.reason, 'utf8') > 512
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.reason)) {
      failure ??= new KernelError('extension_hook_result_invalid', { detail: `${registration.extension}/${registration.hook.name}` });
      continue;
    }
    if (result.decision === 'fail') {
      failure ??= new KernelError('extension_completion_rejected', {
        detail: `${registration.extension}/${registration.hook.name}: ${result.reason}`,
      });
      continue;
    }
    const labelled = `[${registration.extension}/${registration.hook.name}]\n${result.reason}`;
    const bytes = Buffer.byteLength(labelled, 'utf8') + (contexts.length === 0 ? 0 : Buffer.byteLength('\n\n', 'utf8'));
    if (totalBytes + bytes > maxBytes) {
      failure ??= new KernelError('extension_hook_context_too_large', { detail: `${registration.extension}/${registration.hook.name}` });
      continue;
    }
    contexts.push(labelled);
    totalBytes += bytes;
    continued = true;
  }
  if (failure !== undefined) throw failure;
  return continued ? { decision: 'continue', context: contexts.join('\n\n') } : { decision: 'accept' };
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
  // 传入 `null` 表示登记不可读：停用名单不可信，全部已安装扩展退出活动路径
  // （fail-safe 偏向停用），配置层显式声明的路径不受影响。
  disabled?: readonly string[] | null;
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
        detail: `${entries.length} extension path(s) in the ${layer} layer are not loaded: a repository does not decide what code this process runs`,
      });
    } else if (!Array.isArray(entries)) {
      ignored.push({ code: 'extension_entries_invalid', path: layer, detail: `extensions must be an array of paths, got ${entries.invalid}` });
    }
  }
  const installed = await installedIn(join(dataRoot(userHome), 'extensions'), readDirectory);
  // `null` 表示登记不可读：全部已安装扩展视为停用，名单按实际安装名生成供界面展示。
  const off = disabled === null ? null : new Set(disabled);
  const active: string[] = [];
  const disabledEntries: { name: string; path: string }[] = [];
  const installNames: Record<string, string> = {};
  for (const path of installed.paths) {
    const installName = installNameOf(path);
    installNames[resolve(path)] = installName;
    if (off === null || off.has(installName)) {
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

const HOOK_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const HOOK_PHASES: readonly ExtensionHookPhase[] = ['prepareRequest', 'beforeTool', 'afterTool', 'completeRun'];
const MAX_EXTENSION_DIAGNOSTICS = 128;
const MAX_EXTENSION_DIAGNOSTIC_DETAIL = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedExtensionHook(value: unknown): ExtensionHook {
  if (!isRecord(value) || Object.keys(value).some((key) => !['phase', 'name', 'run'].includes(key))) {
    throw new KernelError('extension_hook_shape_invalid');
  }
  if (typeof value.phase !== 'string' || !HOOK_PHASES.includes(value.phase as ExtensionHookPhase)) {
    throw new KernelError('extension_hook_phase_invalid');
  }
  if (typeof value.name !== 'string' || !HOOK_NAME.test(value.name)) throw new KernelError('extension_hook_name_invalid');
  if (typeof value.run !== 'function') throw new KernelError('extension_hook_handler_required');
  return Object.freeze({ phase: value.phase, name: value.name, run: value.run }) as ExtensionHook;
}

function extensionIdentityOf(factoryName: string, path: string): string {
  const candidate = factoryName === '' ? installNameOf(path) : factoryName;
  const normalized = candidate.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80);
  return normalized === '' ? 'extension' : normalized;
}

// 每个扩展只撤销自己注册的内容；加载失败时不留下部分注册，也不影响其他扩展。
export async function loadExtensions(paths: string[], options: LoadOptions) {
  const loaded: { name: string; path: string; tools: string[] }[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];
  const undo: (() => void | Promise<void>)[][] = [];
  const registeredHooks: ExtensionHookRegistration[] = [];
  const hookNames = new Set<string>();
  const owners = new Set<{ active: boolean }>();
  let acceptingRegistrations = true;
  let diagnosticsTruncated = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const hookRegistry: ExtensionHookRegistry = Object.freeze({
    forPhase(phase: ExtensionHookPhase) {
      return Object.freeze(registeredHooks.filter((registration) => registration.hook.phase === phase));
    },
  });

  function addDiagnostic(diagnostic: ExtensionDiagnostic): void {
    if (diagnostics.length < MAX_EXTENSION_DIAGNOSTICS) {
      diagnostics.push({ ...diagnostic, detail: diagnostic.detail.slice(0, MAX_EXTENSION_DIAGNOSTIC_DETAIL) });
      return;
    }
    if (!diagnosticsTruncated) {
      diagnosticsTruncated = true;
      diagnostics.push({ code: 'extension_diagnostics_truncated', path: '', detail: 'additional extension diagnostics were omitted' });
    }
  }

  async function clean(owns: (() => void | Promise<void>)[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (owns.length > 0) {
      try {
        await owns.pop()?.();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  for (const path of paths) {
    const owns: (() => void | Promise<void>)[] = [];
    const owner = { active: true };
    owners.add(owner);
    const tools: string[] = [];
    try {
      const imported = await (options.importModule ?? ((url: string) => import(url)))(pathToFileURL(path).href);
      const factory = imported.default;
      if (typeof factory !== 'function') throw new KernelError('extension_shape_invalid', { detail: 'the module has no default export to call' });
      const name = factory.name === '' ? path : factory.name;
      const hookOwner = extensionIdentityOf(factory.name, path);
      const assertActive = () => {
        if (!acceptingRegistrations || !owner.active) throw new KernelError('extension_inactive');
      };
      const registerHook = (value: unknown) => {
        assertActive();
        const hook = checkedExtensionHook(value);
        const key = `${hook.phase}:${hook.name}`;
        if (hookNames.has(key)) throw new KernelError('extension_hook_duplicate', { detail: key });
        const registration = Object.freeze({ extension: hookOwner, hook });
        hookNames.add(key);
        registeredHooks.push(registration);
        let registered = true;
        const remove = () => {
          if (!registered) return;
          registered = false;
          hookNames.delete(key);
          const index = registeredHooks.indexOf(registration);
          if (index >= 0) registeredHooks.splice(index, 1);
        };
        owns.push(remove);
        return remove;
      };
      // 只暴露扩展 API 中声明的能力，不额外提供扩展身份或 Host 内部对象。
      const config = {
        registerTool: (tool: unknown) => {
          assertActive();
          const remove = options.registerTool(tool);
          owns.push(remove);
          if (typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string') tools.push(tool.name);
          return remove;
        },
        registerPrompt: (fragment: { name: string; text: string }) => {
          assertActive();
          if (typeof fragment?.name !== 'string' || fragment.name === '') throw new KernelError('extension_fragment_name_required');
          if (typeof fragment.text !== 'string') throw new KernelError('extension_fragment_text_required');
          const remove = options.registerFragment({ name: fragment.name, text: fragment.text, source: path });
          owns.push(remove);
          return remove;
        },
        onEvent: (handler: (event: unknown) => void) => {
          assertActive();
          if (typeof handler !== 'function') throw new KernelError('extension_handler_required');
          const remove = options.addEventListener((event) => {
            if (!owner.active) return;
            try {
              handler(event);
            } catch (error) {
              // 观察器错误不改变 Host 结果；错误正文可能包含提示词/路径，只保留稳定分类。
              addDiagnostic({ code: 'extension_handler_failed', path, detail: 'extension event observer failed; details omitted' });
            }
          });
          owns.push(remove);
          return remove;
        },
        registerHook,
        request: async (tool: string, args?: unknown) => {
          assertActive();
          return await options.request(tool, args);
        },
      };
      const disposer = await factory(Object.freeze(config));
      if (disposer !== undefined && typeof disposer !== 'function') {
        throw new KernelError('extension_dispose_invalid', { detail: 'the setup returned something that is not a function' });
      }
      owns.push(() => {
        if (typeof disposer === 'function') return disposer();
      });
      undo.push(owns);
      loaded.push({ name, path, tools });
    } catch (error) {
      owner.active = false;
      owners.delete(owner);
      const cleanupErrors = await clean(owns);
      const failure = error instanceof KernelError ? error : new KernelError('extension_load_failed', { cause: error });
      const detail = failure.detail ?? (error instanceof Error ? error.message : String(error));
      const cleanupDetail = cleanupErrors.map((item) => item instanceof Error ? item.message : String(item));
      addDiagnostic({
        code: failure.code,
        path,
        detail: cleanupDetail.length === 0 ? detail : `${detail}; cleanup failed: ${cleanupDetail.join('; ')}`,
      });
    }
  }

  return {
    loaded,
    diagnostics,
    hooks: hookRegistry,
    async dispose() {
      if (disposed) return;
      if (disposePromise !== undefined) return await disposePromise;
      acceptingRegistrations = false;
      for (const owner of owners) owner.active = false;
      disposePromise = (async () => {
        const errors: unknown[] = [];
        while (undo.length > 0) errors.push(...await clean(undo.pop()!));
        owners.clear();
        disposed = true;
        if (errors.length === 1) throw errors[0];
        if (errors.length > 0) throw new AggregateError(errors, 'extension cleanup failed');
      })();
      try { await disposePromise; }
      finally { if (disposed) disposePromise = undefined; }
    },
  };
}
