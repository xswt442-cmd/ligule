#!/usr/bin/env node
// CLI 在当前进程中直接调用 Host，不会开启网络端口。
// 默认任务只装载显式选择的工具清单；`host` 命令则以独立进程启动 Host，并等待 stdio 客户端连接。
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadProjectConfig } from '@ligule/core/host/environment.js';
import { languageOf, textOf, type Locale } from '@ligule/core/kernel/locale.js';
import { loadConfigLayers } from '@ligule/core/kernel/config-file.js';
import { createConfigStore } from '@ligule/core/kernel/config-store.js';
import { createKernel } from '@ligule/core/kernel/kernel.js';
import { loadAssembly } from '@ligule/core/kernel/assembly.js';
import { DEFAULT_MODE, modeDirectories } from '@ligule/core/kernel/modes.js';
import { extensionSources } from '@ligule/core/kernel/extensions.js';
import { readRegistry, registryPathOf } from '@ligule/core/kernel/workspace.js';
import { discoverSkills, skillDirectories } from '@ligule/core/kernel/skills.js';
import { createSessionLog } from '@ligule/core/session/session.js';
import { listSessions, sessionDirectory } from '@ligule/core/session/list.js';
import { adoptForSessionDirectory } from '@ligule/core/session/adopt.js';
import { summarizeVerdicts } from '@ligule/core/session/verdicts.js';
import { minimalPlugin } from '@ligule/core/tools/minimal.js';
import { networkPlugin } from '@ligule/core/tools/network.js';
import { createHost, providerFromConfig, hostProviderFromConfig, serveHost } from '@ligule/core/host/host.js';
import { KernelError } from '@ligule/core/kernel/error.js';
import { runtimeFailureText } from './tui/errors.js';
import type { ConfigSnapshot } from '@ligule/core/kernel/config.js';
import { isPolicyRule, type PolicyMode, type PolicyThresholds } from '@ligule/core/kernel/policy.js';
import type { PolicyRule } from '@ligule/core/kernel/config-edit.js';
import type { Connection } from '@ligule/core/host/connection.js';
import type { ModeDirectories } from '@ligule/core/kernel/modes.js';
type HostProvider = ReturnType<typeof providerFromConfig>;

interface CliPolicy extends Record<string, unknown> {
  readonly mode?: PolicyMode;
  readonly rules?: PolicyRule[];
  readonly thresholds?: PolicyThresholds;
}

interface CliConfig extends ConfigSnapshot {
  readonly boundary: string;
  readonly workspaceRoot: string;
  readonly model?: Record<string, unknown>;
  readonly loop?: Record<string, unknown>;
  readonly limits?: Record<string, unknown>;
  readonly policy?: CliPolicy;
  readonly mode?: string;
  readonly prompt?: { readonly static?: string };
  readonly instructions?: Record<string, unknown> & { readonly maxBytes?: number; readonly current?: string };
  readonly ui?: { readonly language?: unknown };
  readonly host?: { readonly sessionDirectory?: unknown };
}

interface CliErrorFields {
  readonly code?: string;
  readonly detail?: string;
  readonly message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFields(error: unknown): CliErrorFields {
  if (!isRecord(error)) return {};
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.detail === 'string' ? { detail: error.detail } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
  };
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new KernelError('host_response_invalid');
  return value;
}

function responseString(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string') throw new KernelError('host_response_invalid', { detail: `${field} must be a string` });
  return value[field];
}

function responseCount(value: Record<string, unknown>, field: string): number {
  if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) throw new KernelError('host_response_invalid', { detail: `${field} must be a number` });
  return value[field];
}

function policyOf(value: unknown): CliPolicy | undefined {
  if (value === undefined || !isRecord(value)) return undefined;
  const mode = value.mode;
  if (mode !== undefined && mode !== 'ask' && mode !== 'auto' && mode !== 'never') throw new KernelError('policy_mode_unknown');
  let rules: PolicyRule[] | undefined;
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules) || !value.rules.every(isPolicyRule)) throw new KernelError('policy_rules_invalid');
    rules = value.rules;
  }
  let thresholds: PolicyThresholds | undefined;
  if (value.thresholds !== undefined) {
    if (!isRecord(value.thresholds)
      || typeof value.thresholds.consecutive !== 'number'
      || typeof value.thresholds.total !== 'number') throw new KernelError('policy_thresholds_required');
    thresholds = { consecutive: value.thresholds.consecutive, total: value.thresholds.total };
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(rules === undefined ? {} : { rules }),
    ...(thresholds === undefined ? {} : { thresholds }),
  };
}

const packageValue: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!isRecord(packageValue) || typeof packageValue.version !== 'string') throw new KernelError('cli_package_version_invalid');
const pkg = { version: packageValue.version };
// 随包模式目录与 `dist/` 同级；此相对路径在源码检出和 npm 安装包中保持一致。
const shippedModes = dirname(fileURLToPath(import.meta.resolve('@ligule/core/modes/minimal.toml')));

// `--config a.b=c` 可重复；`--mode <名字>` 和 `--project <根>` 各接受一个值；`--json` 不接受值。
// 这些选项都从位置参数中解析。
const flags: string[] = [];
const positional: string[] = [];
const argv = process.argv.slice(2);
let missingConfigValue = false;
let missingLangValue = false;
let missingModeValue = false;
let missingProjectValue = false;
let modeFlag: string | undefined;
let projectFlag: string | undefined;
let langFlag: string | undefined;
let jsonFlag = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--json') {
    jsonFlag = true;
    continue;
  }
  if (arg === '--lang') {
    const value = argv[index + 1];
    if (value === undefined) {
      missingLangValue = true;
      break;
    }
    langFlag = value;
    index += 1;
    continue;
  }
  if (arg === '--project') {
    // 按项目根过滤列表。选项已出现但没有值时返回错误，不把它当成未指定。
    const value = argv[index + 1];
    if (value === undefined) {
      missingProjectValue = true;
      break;
    }
    projectFlag = value;
    index += 1;
    continue;
  }
  if (arg === '--config' || arg === '--mode') {
    const value = argv[index + 1];
    if (value === undefined) {
      if (arg === '--config') missingConfigValue = true;
      else missingModeValue = true;
      break;
    }
    if (arg === '--config') flags.push(value);
    else modeFlag = value;
    index += 1;
    continue;
  }
  positional.push(arg);
}
const [command, ...rest] = positional;
let invalidLanguage = false;
let locale: Locale | undefined;
try { if (langFlag !== undefined) locale = languageOf(langFlag); } catch { invalidLanguage = true; }

const t = (zh: string, en: string) => textOf(locale ?? languageOf('auto'), zh, en);

function setLocale(config?: CliConfig): Locale {
  locale = languageOf(langFlag ?? config?.ui?.language);
  return locale;
}

function cliConfig(snapshot: ConfigSnapshot, projectRoot: string): CliConfig {
  const boundary = snapshot.boundary;
  if (typeof boundary !== 'string' || boundary === '') throw new KernelError('boundary_required');
  if (snapshot.mode !== undefined && typeof snapshot.mode !== 'string') throw new KernelError('mode_name_invalid', { detail: String(snapshot.mode) });
  const model = isRecord(snapshot.model) ? snapshot.model : undefined;
  const loop = isRecord(snapshot.loop) ? snapshot.loop : undefined;
  const limits = isRecord(snapshot.limits) ? snapshot.limits : undefined;
  const policy = policyOf(snapshot.policy);
  let prompt: CliConfig['prompt'];
  if (snapshot.prompt !== undefined) {
    if (!isRecord(snapshot.prompt) || (snapshot.prompt.static !== undefined && typeof snapshot.prompt.static !== 'string')) {
      throw new KernelError('host_prompt_invalid');
    }
    prompt = { ...(typeof snapshot.prompt.static === 'string' ? { static: snapshot.prompt.static } : {}) };
  }
  let instructions: CliConfig['instructions'];
  if (snapshot.instructions !== undefined) {
    if (!isRecord(snapshot.instructions)) throw new KernelError('instructions_config_invalid');
    if (snapshot.instructions.maxBytes !== undefined && typeof snapshot.instructions.maxBytes !== 'number') {
      throw new KernelError('instructions_max_bytes_required');
    }
    if (snapshot.instructions.current !== undefined && typeof snapshot.instructions.current !== 'string') {
      throw new KernelError('instructions_current_invalid');
    }
    instructions = {
      ...snapshot.instructions,
      ...(typeof snapshot.instructions.maxBytes === 'number' ? { maxBytes: snapshot.instructions.maxBytes } : {}),
      ...(typeof snapshot.instructions.current === 'string' ? { current: snapshot.instructions.current } : {}),
    };
  }
  const ui = isRecord(snapshot.ui) ? { language: snapshot.ui.language } : undefined;
  const host = isRecord(snapshot.host) ? { sessionDirectory: snapshot.host.sessionDirectory } : undefined;
  return Object.freeze({
    ...snapshot,
    boundary,
    workspaceRoot: resolve(projectRoot),
    ...(model === undefined ? {} : { model }),
    ...(loop === undefined ? {} : { loop }),
    ...(limits === undefined ? {} : { limits }),
    ...(policy === undefined ? {} : { policy }),
    ...(typeof snapshot.mode === 'string' ? { mode: snapshot.mode } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(ui === undefined ? {} : { ui }),
    ...(host === undefined ? {} : { host }),
  });
}

async function configSnapshot(projectRoot = process.cwd()): Promise<{ config: CliConfig; extensions: Awaited<ReturnType<typeof extensionSources>>; layers: Awaited<ReturnType<typeof loadConfigLayers>> }> {
  const { config: snapshot, extensions, layers } = await loadProjectConfig(projectRoot, flags);
  const config = cliConfig(snapshot, projectRoot);
  setLocale(config);
  return { config, extensions, layers };
}

// `--mode` 优先于配置中的 `mode`；两者都未设置时使用随包的 minimal 模式。
// 将模式名称和搜索目录交给 Host 加载，使启动和运行时切换使用相同规则。
function resolveMode(config: CliConfig): { modeName: string; modePaths: ModeDirectories } {
  return { modeName: modeFlag ?? config.mode ?? DEFAULT_MODE, modePaths: modeDirectories(process.cwd(), shippedModes) };
}

// Host 可按项目根为多个项目分别加载环境，复用 CLI 启动时相同的配置、提供方、模式和扩展解析逻辑。
// `--mode` 只覆盖本次运行；切换到其他项目时需通过 `session.open` 的 `mode` 参数选择模式。
async function projectEnvironment(projectRoot: string) {
  const { config: snapshot, layers, extensions } = await loadProjectConfig(projectRoot, flags);
  const config = cliConfig(snapshot, projectRoot);
  return {
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    // 原样传递四层配置；Host 为每个项目创建独立的可写层存储。
    layers,
    modeName: config.mode ?? DEFAULT_MODE,
    modePaths: modeDirectories(projectRoot, shippedModes),
    extensions,
  };
}

async function installedKernel() {
  const { config } = await configSnapshot();
  const kernel = createKernel({ config });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  return kernel;
}

// 错误码供脚本分支判断，后面的文字供终端用户阅读。
function printFailure(code: string, detail?: string): void {
  const guidance = runtimeFailureText(code, locale ?? languageOf('auto'));
  console.error(guidance === undefined ? (detail === undefined || detail === '' ? code : `${code}: ${detail}`) : `${code}: ${guidance}`);
  process.exitCode = 1;
}

function formatPolicyCounts(counts: ReturnType<typeof summarizeVerdicts>): string[] {
  return counts.map((item) => {
    const rules = Object.entries(item.rules).map(([rule, count]) => `"${rule}"×${count}`).join(' ');
    const codes = Object.entries(item.codes).map(([code, count]) => `${code}×${count}`).join(' ');
    const levels = Object.entries(item.levels).map(([level, count]) => `${level}×${count}`).join(' ');
    return `${item.capability}  ${t('自动', 'Automatic')} ${item.auto}  ${t('问过', 'Asked')} ${item.asked}  ${t('拒绝', 'Denied')} ${item.denied}`
      + `  ${t('档位', 'Levels')} ${levels}`
      + (rules === '' ? '' : `  ${t('命中规则', 'Matched rules')} ${rules}`)
      + (codes === '' ? '' : `  ${t('错误码', 'Error codes')} ${codes}`);
  });
}

async function kernelOrFail(): Promise<ReturnType<typeof createKernel> | undefined> {
  try {
    return await installedKernel();
  } catch (error: unknown) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_kernel_failed', fields.detail);
    return undefined;
  }
}

// 在当前进程中通过 Host 协议运行一轮任务，将事件和审批请求交给终端处理。
function printNotification(message: Record<string, unknown>): void {
  const event = isRecord(message.event) ? message.event : undefined;
  if (message.notify === 'delta') {
    if (event?.type === 'text' && typeof event.text === 'string') process.stdout.write(event.text);
    // 将推理内容写入标准错误，标准输出保留给管道另一端的脚本读取。
    if (event?.type === 'reasoning' && typeof event.text === 'string') process.stderr.write(event.text);
  } else if (message.notify === 'event' && event?.kind === 'reasoning') {
    process.stderr.write('\n');
  } else if (message.notify === 'event' && event?.kind === 'assistant') {
    // 只有收到文本内容时才结束输出行，纯工具调用不会留下空行。
    if (event.text !== '') process.stdout.write('\n');
  } else if (message.notify === 'event' && event?.kind === 'tool') {
    const result = isRecord(event.result) ? event.result : {};
    console.log(`· ${String(event.tool ?? '')}: ${result.failed ? String(result.code ?? '') : t('成功', 'ok')}`);
  } else if (message.notify === 'event' && event?.kind === 'user') {
    // 模板展开后仍显示用户输入的原文，保持终端回显与实际输入一致。
    console.log(`> ${String(event.raw ?? event.text ?? '')}`);
  } else if (message.notify === 'fault') {
    console.error(message.detail === undefined ? message.code : `${message.code}: ${message.detail}`);
  }
}

// 审批在终端中处理。进程启动时就开始读取输入，以免 `echo y | ligule run` 在问题出现前发送的答复丢失。
function terminalApprovals(): { ask(question: string): Promise<string | undefined>; close(): void } {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const queued: string[] = [];
  let ended = false;
  let waiter: ((line: string | undefined) => void) | undefined;
  const answer = (line: string | undefined): void => {
    if (waiter === undefined) {
      if (line !== undefined) queued.push(line);
      return;
    }
    const settle = waiter;
    waiter = undefined;
    settle(line);
  };
  reader.on('line', (line: string) => answer(line));
  reader.on('close', () => {
    ended = true;
    answer(undefined);
  });
  return {
    // 返回 undefined 表示用户未作答，调用方会按拒绝处理。
    async ask(question: string): Promise<string | undefined> {
      process.stderr.write(question);
      let line: string | undefined;
      if (queued.length > 0) line = queued.shift();
      else if (ended) line = undefined;
      else line = await new Promise<string | undefined>((resolve) => {
        waiter = resolve;
      });
      // 终端会回显用户输入的换行；管道输入不会回显，因此需要在这里补一个换行。
      if (!process.stdin.isTTY) process.stderr.write(`${line ?? ''}\n`);
      return line;
    },
    close() {
      reader.close();
    },
  };
}

async function runOneRound(
  config: CliConfig,
  selection: ReturnType<typeof resolveMode>,
  extensions: Awaited<ReturnType<typeof extensionSources>>,
  text: string,
  sessionId?: string,
): Promise<void> {
  const host = createHost({ config, provider: providerFromConfig(config), policy: config.policy, extensions, ...selection });
  const approvals = terminalApprovals();
  const connection: Pick<Connection, 'notify' | 'request'> = {
    notify: printNotification,
    // 该终端输入通道只处理允许或拒绝审批。普通命令行没有可回答模型提问的交互界面。
    request: async (method, params) => {
      if (method !== 'approval.request') throw new KernelError('protocol_method_unknown', { detail: method });
      const fields = isRecord(params) ? params : {};
      const described = typeof fields.command === 'string' ? fields.command : JSON.stringify(fields.args);
      // 同时展示命令使用的语法和可执行文件，帮助用户判断命令会如何运行。
      const backend = typeof fields.shell !== 'string' ? '' : ` (${fields.shell}: ${typeof fields.executable === 'string' ? fields.executable : ''})`;
      const tool = typeof fields.tool === 'string' ? fields.tool : 'tool';
      const answer = await approvals.ask(t(`允许 ${tool} ${described}${backend}？[y/N] `, `Allow ${tool} ${described}${backend}? [y/N] `));
      return { decision: /^y(es)?$/i.test(String(answer).trim()) ? 'allow' : 'deny' };
    },
  };
  try {
    // 指定会话编号时只能恢复已有记录；记录不存在就返回错误，不创建空会话。
    // `--mode` 有值时传给 Host；否则由 Host 从记录恢复模式并校验其摘要。
    const opened = responseRecord(await (sessionId === undefined
      ? await host.handle({ method: 'session.create', params: {} }, connection)
      : await host.handle({ method: 'session.open', params: { sessionId, ...(modeFlag === undefined ? {} : { mode: modeFlag }) } }, connection)));
    const openedId = responseString(opened, 'sessionId');
    const result = responseRecord(await host.handle({ method: 'run.start', params: { sessionId: openedId, input: text } }, connection));
    const iterations = responseCount(result, 'iterations');
    const modelCalls = responseCount(result, 'modelCalls');
    console.error(t(`会话 ${openedId}：${iterations} 轮，调用模型 ${modelCalls} 次`, `Session ${openedId}: ${iterations} iterations, ${modelCalls} model calls`));
  } finally {
    approvals.close();
    await host.release();
  }
}

if (invalidLanguage) {
  printFailure('language_invalid', t('--lang 只接受 zh、en 或 auto', '--lang accepts only zh, en, or auto'));
} else if (missingLangValue) {
  printFailure('language_invalid', t('--lang 需要 zh、en 或 auto', '--lang needs zh, en, or auto'));
} else if (missingConfigValue) {
  printFailure('cli_config_needs_a_value', t('--config 需要一个值', '--config needs a value'));
} else if (missingModeValue) {
  printFailure('cli_mode_needs_a_value', t('--mode 需要模式名称，例如 --mode full', '--mode needs a mode name, for example --mode full'));
} else if (missingProjectValue) {
  printFailure('cli_project_needs_a_value', t('--project 需要项目根目录，用于筛选列表', '--project needs a project root to filter the listing'));
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === 'tools') {
  // 默认任务只装载明确配置的最小工具清单。
  const kernel = await kernelOrFail();
  if (kernel) for (const name of kernel.list()) console.log(name);
} else if (command === 'extensions') {
  // 只读列出 CLI 会加载的扩展文件和被过滤的路径，不导入扩展代码。
  try {
    const { extensions } = await configSnapshot();
    for (const path of extensions.paths) console.log(path);
    if (extensions.paths.length === 0) {
      console.log(t('没有已加载的扩展', 'No extensions loaded'));
      console.log(t(`  已检查 ${extensions.installedDirectory}`, `  Looked in ${extensions.installedDirectory}`));
    }
    for (const diagnostic of extensions.ignored) console.error(`${diagnostic.code}\t${diagnostic.path}\t${diagnostic.detail}`);
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_extensions_failed', fields.detail);
  }
} else if (command === 'skills') {
  // 只读扫描配置的技能目录，报告成功加载和被忽略的条目；不启动 Kernel，也不读取模型配置。
  // 完整诊断留在日志中，提示词仅包含计数摘要。
  try {
    const directories = skillDirectories(process.cwd());
    const registry = await discoverSkills(directories);
    for (const skill of registry.skills) console.log(`${skill.name}\t${skill.root}`);
    if (registry.skills.length === 0) {
      // 没有发现技能时也列出已扫描的位置，便于排查技能为何未加载。
      console.log(t('没有已加载的技能', 'No skills loaded'));
      for (const directory of directories) console.log(t(`  已检查 ${directory}`, `  Looked in ${directory}`));
    }
    if (registry.diagnostics.length > 0) {
      console.error(t(`未加载：${registry.diagnostics.length}`, `Not loaded: ${registry.diagnostics.length}`));
      for (const diagnostic of registry.diagnostics) console.error(`${diagnostic.code}\t${diagnostic.detail}`);
    }
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_skills_failed', fields.detail);
  }
} else if (command === 'call') {
  const [name, argsJson] = rest;
  if (name === undefined) {
    printFailure('cli_call_needs_a_tool_name', t('call 需要工具名称', 'call needs a tool name'));
  } else {
    let args: unknown = {};
    try {
      args = argsJson === undefined ? {} : JSON.parse(argsJson);
    } catch {
      printFailure('cli_args_invalid_json', t('参数必须是有效的 JSON', 'arguments must be valid JSON'));
      args = undefined;
    }
    if (args !== undefined) {
      const kernel = await kernelOrFail();
      if (kernel) {
        try {
          const result = await kernel.call(name, args);
          console.log(isRecord(result) && typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2));
        } catch (error) {
          const fields = errorFields(error);
          printFailure(fields.code ?? 'cli_call_failed', fields.detail);
        }
      }
    }
  }
} else if (command === 'run') {
  const text = rest.join(' ').trim();
  if (text === '') {
    printFailure('cli_run_needs_the_user_text', t('run 需要用户消息，例如 ligule run "read the note"', 'run needs a user message, for example ligule run "read the note"'));
  } else {
    try {
      const { config, extensions } = await configSnapshot();
      await runOneRound(config, resolveMode(config), extensions, text);
    } catch (error) {
      const fields = errorFields(error);
      printFailure(fields.code ?? 'cli_run_failed', fields.detail);
    }
  }
} else if (command === 'resume') {
  // 恢复已有会话；记录不存在时返回错误，模式清单从记录中最后生效的设置恢复。
  const [sessionId, ...textParts] = rest;
  const text = textParts.join(' ').trim();
  if (sessionId === undefined) {
    printFailure('cli_resume_needs_the_session_id', t('resume 需要会话编号和用户消息，例如 ligule resume 5f3c "keep going"', 'resume needs a session ID and a user message, for example ligule resume 5f3c "keep going"'));
  } else if (text === '') {
    printFailure('cli_run_needs_the_user_text', t('resume 还需要用户消息，例如 ligule resume 5f3c "keep going"', 'resume also needs a user message, for example ligule resume 5f3c "keep going"'));
  } else {
    try {
      const { config, extensions } = await configSnapshot();
      await runOneRound(config, resolveMode(config), extensions, text, sessionId);
    } catch (error) {
      const fields = errorFields(error);
      printFailure(fields.code ?? 'cli_resume_failed', fields.detail);
    }
  }
} else if (command === 'sessions') {
  // 只读扫描会话记录目录，不创建索引或打开会话，并报告扫描耗时。
  try {
    // `--project <根>` 指定项目后，读取该项目配置的记录目录；只在当前目录中过滤无法读取其他项目记录。
    const { config } = await configSnapshot(projectFlag);
    const directory = sessionDirectory(config);
    // 数据根目录中没有该项目的新记录时，先从旧位置迁移记录和附属文件并保留原件。
    // 迁移失败时明确报告错误，不把读取失败误报为空列表。
    const adopted = await adoptForSessionDirectory(config, directory);
    if (adopted !== null && (adopted.copied.length > 0 || adopted.conflicts.length > 0)) {
      console.error(t(`已整理旧会话：复制 ${adopted.copied.length} 项，冲突 ${adopted.conflicts.length}${adopted.conflicts.length === 0 ? '' : `（${adopted.conflicts.join(', ')}）`}`, `Legacy sessions adopted: copied ${adopted.copied.length}, conflicts ${adopted.conflicts.length}${adopted.conflicts.length === 0 ? '' : ` (${adopted.conflicts.join(', ')})`}`));
    }
    const started = Date.now();
    const listed = await listSessions(directory, { projectRoot: projectFlag });
    if (jsonFlag) console.log(JSON.stringify(listed));
    else if (listed.length === 0) {
      console.log(t('没有会话记录', 'No sessions'));
      console.log(t(`  已检查 ${directory}`, `  Looked in ${directory}`));
    } else {
      for (const item of listed) {
        const open = item.unanswered > 0 ? t(`  ${item.unanswered} 个调用尚无结果`, `  ${item.unanswered} calls without a result`) : '';
        console.log(`${item.updatedAt}  ${item.id}  ${t(`${item.events} 个事件`, `${item.events} events`)}  ${t('模式', 'mode')}:${item.mode?.name ?? '-'}${item.name === '' ? '' : `  "${item.name}"`}${item.archived ? t('  已归档', '  archived') : ''}${open}`);
      }
      console.error(t(`${listed.length} 个会话，目录 ${directory}，扫描耗时 ${Date.now() - started} 毫秒`, `${listed.length} sessions in ${directory}, scanned in ${Date.now() - started} ms`));
    }
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_sessions_failed', fields.detail);
  }
} else if (command === 'workspaces') {
  // 只读 Host 持久化的工作区登记表，不启动 Kernel。
  // 登记表保留所有已登记工作区，不会因界面显示条数受限而丢失条目。
  try {
    const path = registryPathOf();
    const registry = await readRegistry(path);
    if (jsonFlag) console.log(JSON.stringify(registry));
    else if (registry.workspaces.length === 0) {
      console.log(t('没有已登记的工作区', 'No workspaces registered'));
      console.log(t(`  已检查 ${path}`, `  Looked in ${path}`));
    } else {
      for (const one of registry.workspaces) {
        console.log(`${one.lastSeen}  ${one.name}  ${one.directory}${one.identity === registry.default ? t('  默认', '  default') : ''}`);
      }
      console.error(t(`${registry.workspaces.length} 个工作区，清单位于 ${path}`, `${registry.workspaces.length} workspaces in ${path}`));
    }
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_workspaces_failed', fields.detail);
  }
} else if (command === 'policy') {
  // 从会话记录中汇总权限判定结果；不启动 Kernel 或打开会话。
  const [sessionId] = rest;
  if (sessionId === undefined) {
    printFailure('cli_policy_needs_the_session_id', t('policy 需要会话编号，例如 ligule policy 5f3c', 'policy needs a session ID, for example ligule policy 5f3c'));
  } else {
    try {
      const { config } = await configSnapshot();
      const directory = sessionDirectory(config);
      await adoptForSessionDirectory(config, directory);
      if (!existsSync(join(directory, `${sessionId}.jsonl`))) {
        printFailure('session_not_found', t(`找不到会话 ${sessionId} 的记录：${directory}`, `no record for session ${sessionId} in ${directory}`));
      } else {
        const counts = summarizeVerdicts(await createSessionLog({ directory, id: sessionId }).read());
        if (jsonFlag) console.log(JSON.stringify(counts));
        else if (counts.length === 0) console.log(t(`会话 ${sessionId} 没有判定记录`, `No decision records in session ${sessionId}`));
        else for (const line of formatPolicyCounts(counts)) console.log(line);
      }
    } catch (error) {
      const fields = errorFields(error);
      printFailure(fields.code ?? 'cli_policy_failed', fields.detail);
    }
  }
} else if (command === 'mcp-server') {
  try {
    if (projectFlag === undefined || rest.length > 0 || jsonFlag) throw new KernelError('control_project_required');
    const { serveMcp } = await import('@ligule/core/host/mcp-server.js');
    await serveMcp({ projectRoot: projectFlag, version: pkg.version, flags, modeName: modeFlag });
  } catch (error) {
    const { controlErrorCode } = await import('@ligule/core/host/control.js');
    process.stderr.write(`${controlErrorCode(error)}\n`);
    process.exitCode = 1;
  }
} else if (command === 'host') {
  // Desktop 或脚本启动此进程后，双方通过 stdio 逐行交换 JSON；本地不开放网络端口。
  try {
    const { config, extensions, layers } = await configSnapshot();
    // 启动端负责解析可写配置层的路径；Host 只接收层名、允许字段和读取版本。
    // 同时传入四层配置以便报告值的来源；`--config` 层只读。
    // `ligule host` 提供配置写入接口，普通 TUI 和 `ligule run` 不开放此入口。
    serveHost({
      config,
      // 模型尚未配置时仍启动 Host，以便客户端先写入设置；提交任务时再报告缺少的字段。
      provider: hostProviderFromConfig(config),
      policy: config.policy,
      extensions,
      loadEnvironment: projectEnvironment,
      // 由 Desktop 或脚本启动时，客户端可以回答模型提问和审批请求。
      interactive: true,
      // 将四层配置交给 Host，由 Host 为每个项目环境创建可写层的存储。
      // 启动端解析路径和文件名；Host 只接收层名、允许字段和读取版本。
      configLayers: layers,
      configStoreFor: (projectRoot, ownLayers) => createConfigStore({ projectRoot, layers: ownLayers }),
      ...resolveMode(config),
    });
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_host_failed', fields.detail);
  }
} else if (command === 'tui' || command === undefined) {
  // TUI 是另一个 Host 协议客户端，在同一进程中通过内存连接通信，只处理协议帧。
  // TUI 需要交互式终端；管道不支持 raw mode、按键输入或屏幕重绘。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printFailure('tui_terminal_required', t('tui 需要交互式终端；在脚本中请使用 ligule run', 'tui needs an interactive terminal; use ligule run from a script'));
  } else {
    try {
      // React 和 Ink 会在首次导入时根据 NODE_ENV 选择构建版本，因此必须先设置环境再动态导入。
      process.env.NODE_ENV = 'production';
      const { confirmWorkspaceTrust } = await import('./tui/trust.js');
      // 在读取项目配置和资源前确认目录信任；用户拒绝时不创建 Host 或会话。
      if (await confirmWorkspaceTrust(process.cwd(), { locale: locale ?? languageOf('auto') })) {
        const { config, extensions } = await configSnapshot();
        const { runTui } = await import('./tui/start.js');
        await runTui({ config, provider: hostProviderFromConfig(config), policy: config.policy, extensions, locale, ...resolveMode(config) });
      }
    } catch (error) {
      const fields = errorFields(error);
      const missing = fields.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package '(ink|react|marked|highlight\.js|string-width)'/.test(fields.message ?? String(error));
      printFailure(missing ? 'tui_dependency_missing' : fields.code ?? 'cli_tui_failed',
        missing ? t('tui 需要可选依赖：npm install ink react marked highlight.js string-width', 'the terminal UI requires optional dependencies: npm install ink react marked highlight.js string-width') : fields.detail);
    }
  }
} else if (command === '--help' || command === '-h') {
  if (locale === undefined) {
    try { setLocale((await configSnapshot()).config); } catch { setLocale(undefined); }
  }
  console.log(t(`ligule ${pkg.version} - 开发版本，请勿用于正式环境。`, `ligule ${pkg.version} - development build; do not use in production.`));
  console.log(t('命令：tools、skills、extensions、sessions、workspaces、policy <session-id>、run <text>、resume <id> <text>、call <tool> [json-args]、tui、host、--version', 'Commands: tools, skills, extensions, sessions, workspaces, policy <session-id>, run <text>, resume <id> <text>, call <tool> [json-args], tui, host, --version'));
  console.log(t('直接运行 ligule 打开终端界面；tui 子命令仍可使用。', 'Run ligule without a command to open the terminal UI; the tui subcommand remains available.'));
  console.log(t('mcp-server --project <绝对目录>：启动本地 stdio MCP 外控；审批请求直接拒绝。', 'mcp-server --project <absolute-directory>: start local stdio MCP control; approval requests are denied.'));
  console.log(t('选项：--config <key.path=value>（可重复）、--mode <name>、--lang <zh|en|auto>', 'Options: --config <key.path=value> (repeatable), --mode <name>, --lang <zh|en|auto>'));
  console.log(t('run、tui 和 host 从配置读取 model.api、model.baseURL 与 model.model；密钥由 model.apiKeyEnv 指定，未设置时读取 LIGULE_API_KEY。', 'run, tui and host read model.api, model.baseURL and model.model from config; the key uses model.apiKeyEnv, or LIGULE_API_KEY when unset.'));
  console.log(t('run、tui 和 host 默认使用 minimal 模式；--mode 可覆盖 mode 配置。tools 和 call 不读取模式。', 'run, tui and host use the minimal mode by default; --mode overrides the mode config. tools and call do not read a mode.'));
  console.log(t('skills 列出已加载的技能与未加载原因；它不读取模型配置。', 'skills lists loaded skills and why others were skipped; it does not read model config.'));
  console.log(t('个人配置位于 ~/.ligule；可用绝对路径设置 LIGULE_HOME。', 'Personal config lives in ~/.ligule; set LIGULE_HOME to use an absolute path.'));
} else {
  // 未知命令应以失败状态退出，避免脚本把帮助文本误判为成功。
  printFailure('cli_command_unknown', t(`“${command}”不是有效命令；运行 ligule --help 查看命令列表`, `"${command}" is not a command; run ligule --help to list commands`));
}
