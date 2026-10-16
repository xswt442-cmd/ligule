#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
// `host` 这一条是另一件事：它把同一个内核作为 Host 进程起起来，等一条标准输入输出上的客户端连接（D30）。
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
// 随包的模式目录与 `dist/` 同级：从本模块往上一层就是包根，本地检出与解包之后是同一个相对位置。
const shippedModes = dirname(fileURLToPath(import.meta.resolve('@ligule/core/modes/minimal.toml')));

// `--config a.b=c` 可以出现多次；`--mode <名字>` 与 `--project <根>` 各取一个值；`--json` 是个旗子。
// 它们都从位置参数里挑出来。
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
    // 列表按项目根过滤；写了这个旗子却没给值与 `--mode` 同一类处理，不静默当成没写。
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

// 模式名按 D44：`--mode` 覆盖一次运行，否则读配置里的 `mode`，两处都没写就是随包的 minimal。
// 交出去的是名字加那三层目录，装载在 Host 那一侧做：运行中换模式要用同一套查找（D41）。
function resolveMode(config: CliConfig): { modeName: string; modePaths: ModeDirectories } {
  return { modeName: modeFlag ?? config.mode ?? DEFAULT_MODE, modePaths: modeDirectories(process.cwd(), shippedModes) };
}

// 一具宿主可以接多个项目，这是宿主按项目根再装载一份环境的那条路（方案 3.1、实现顺序第 69 步）。
// 走的是命令行自己启动时同一批函数：配置那几层、提供方、模式与扩展来源都按那一个项目根重算。
// `--mode` 是这一次运行的覆盖，不跟着进另一个项目的环境；要换清单由 `session.open` 的 `mode` 那一格指名。
async function projectEnvironment(projectRoot: string) {
  const { config: snapshot, layers, extensions } = await loadProjectConfig(projectRoot, flags);
  const config = cliConfig(snapshot, projectRoot);
  return {
    config,
    provider: hostProviderFromConfig(config),
    policy: config.policy,
    // 四层原样交回：宿主给这一份项目环境建它自己的可写层存储，设置那一栏读写都按这一个项目算（方案 3.2）。
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

// 码是给脚本分支的，后面那一句是给站在终端前的人看的（D19 把码与文本分开就是为了两边各取一样）。
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

// 打印一次真实轮次（第 13 步第三条）：这具 Host 在同进程里驱动一遍，事件的出口是终端，
// 审批也问在终端上。走的是协议那一层，与桌面壳起进程时看到的是同一份东西。
function printNotification(message: Record<string, unknown>): void {
  const event = isRecord(message.event) ? message.event : undefined;
  if (message.notify === 'delta') {
    if (event?.type === 'text' && typeof event.text === 'string') process.stdout.write(event.text);
    // 推理段走标准错误：答案那一份要留给管道另一头的脚本，想看的的人在终端里看得见（D32）。
    if (event?.type === 'reasoning' && typeof event.text === 'string') process.stderr.write(event.text);
  } else if (message.notify === 'event' && event?.kind === 'reasoning') {
    process.stderr.write('\n');
  } else if (message.notify === 'event' && event?.kind === 'assistant') {
    // 只有流上真的吐过字才收那一行，纯工具调用那一轮的文本是空的，不该留一个空行。
    if (event.text !== '') process.stdout.write('\n');
  } else if (message.notify === 'event' && event?.kind === 'tool') {
    const result = isRecord(event.result) ? event.result : {};
    console.log(`· ${String(event.tool ?? '')}: ${result.failed ? String(result.code ?? '') : t('成功', 'ok')}`);
  } else if (message.notify === 'event' && event?.kind === 'user') {
    // 模板展开过的那一条画原始那一行（D54）：终端里回声要等于人打的字。
    console.log(`> ${String(event.raw ?? event.text ?? '')}`);
  } else if (message.notify === 'fault') {
    console.error(message.detail === undefined ? message.code : `${message.code}: ${message.detail}`);
  }
}

// 审批问在终端上。行从进程一开头就收着：`echo y | ligule run` 那一种把答复写在问题之前，
// 那时无人在等，行也不能丢——readline 建得早，才拿得到已经到达的那一行，问出去才有答复可读。
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
    // 交回 undefined 就是「没有答复」，调用方按不允许处理。
    async ask(question: string): Promise<string | undefined> {
      process.stderr.write(question);
      let line: string | undefined;
      if (queued.length > 0) line = queued.shift();
      else if (ended) line = undefined;
      else line = await new Promise<string | undefined>((resolve) => {
        waiter = resolve;
      });
      // 人敲的那一下回车由终端回显；答复是从管道里进来的时没人回显，不补这一行就会和下一行接在一起。
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
    // 这一路答得了的请求只有审批那一种：一次询问，答允许或不允许。模型的提问不在这一路装载，纯命令行的下一次调用没人替它答（D107）。
    request: async (method, params) => {
      if (method !== 'approval.request') throw new KernelError('protocol_method_unknown', { detail: method });
      const fields = isRecord(params) ? params : {};
      const described = typeof fields.command === 'string' ? fields.command : JSON.stringify(fields.args);
      // 命令文本后面说清是哪一种语法、哪一个可执行文件（D59）：同一条文本在两种语法下要问不该问是两回事。
      const backend = typeof fields.shell !== 'string' ? '' : ` (${fields.shell}: ${typeof fields.executable === 'string' ? fields.executable : ''})`;
      const tool = typeof fields.tool === 'string' ? fields.tool : 'tool';
      const answer = await approvals.ask(t(`允许 ${tool} ${described}${backend}？[y/N] `, `Allow ${tool} ${described}${backend}? [y/N] `));
      return { decision: /^y(es)?$/i.test(String(answer).trim()) ? 'allow' : 'deny' };
    },
  };
  try {
    // 给了 id 就是接着那一份记录往下走：记录不在就是没有这次会话，不新建一份空记录顶上去（D73）。
    // 用哪一份模式清单由宿主定（D78、第 44 步）：`--mode` 写了就作为那一个参数递过去，
    // 没写时宿主取记录里最后生效的那一条并比它的摘要，这一侧不再另算一遍。
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
  // 默认运行装的就是那份显式的最小清单（D3）。
  const kernel = await kernelOrFail();
  if (kernel) for (const name of kernel.list()) console.log(name);
} else if (command === 'extensions') {
  // 与 `ligule skills` 同一类只读排错入口（D64）：说清这一具机器会加载哪几个文件、哪些路径被 D68 那条规则挡掉，
  // 不 import 任何一份扩展——一条诊断命令不该执行别人的代码。
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
  // 只读的诊断入口：装载侧扫一遍那四个目录，把载入的与被丢下的都说出来，不起内核也不读模型配置。
  // 客户端协议不为这件事扩，日志留完整记录，提示词里只带一个计数（D64）。
  try {
    const directories = skillDirectories(process.cwd());
    const registry = await discoverSkills(directories);
    for (const skill of registry.skills) console.log(`${skill.name}\t${skill.root}`);
    if (registry.skills.length === 0) {
      // 「装了但没生效」最难自查，所以一份都没有时把扫过的位置说出来。
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
  // 接着一次已经跑过的会话往下走（D73、D78）：那一份记录不在就是没有这次会话，模式清单取记录里最后生效的那一条。
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
  // 只读地列出跑过的会话（D73）：扫记录目录，不建索引也不开会话；耗时打在这一行上，U38 要的就是这个数。
  try {
    // `--project <根>` 指了哪一根就读哪一根的那一层：记录目录本身是按项目层配出来的，
    // 只在当前目录下筛项目根等于没读那个项目。
    const { config } = await configSnapshot(projectFlag);
    const directory = sessionDirectory(config);
    // 缺省目录下没有这一份项目的新记录时，先按 D110 的整理把旧位置补齐一份（原件保留、可重跑）：
    // 整理失败明确报告，不能把读取失败说成没有旧记录。
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
  // 读那份持久的登记（D110、方案 5.5.1）：宿主在真的建会话与真的接会话那两处写下每一条，这一条只读它，不建内核。
  // 界面上那一栏列不出来的工作区仍然在这份清单里：登记不是「最近八个路径」那一类列表。
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
  // 判定结果的汇总（D77）：读那一份记录算出来，内核里没有第二份计数器；这一条也不建内核、不开会话。
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
} else if (command === 'host') {
  // 桌面壳或者脚本起这一个进程，两端各读写一行 JSON（D30）：本机不开端口，审批与事件都走这条连接。
  try {
    const { config, extensions, layers } = await configSnapshot();
    // 可写的那两层由启动这一侧算出路径：宿主只认「哪一层、哪一个白名单字段、读回的那一份版本」，说不出文件在哪（方案 7.2）。
    // 装载那一次读到的四层对象一起交进去：来源那一格要说得出一条值现在由哪一层写着，`--config` 那一层是只读的（方案 7.1）。
    // 这一格跟着 `ligule host` 起：设置那一栏在桌面壳里，终端与 `ligule run` 都没有要写配置的入口。
    serveHost({
      config,
      // 还没配上模型时宿主照样起来收请求：那一栏要写得进去才谈得上配上（U59）。发起一轮时才说缺哪几格。
      provider: hostProviderFromConfig(config),
      policy: config.policy,
      extensions,
      loadEnvironment: projectEnvironment,
      // 桌面壳那一侧答得了模型的提问，也答得了审批：这一进程只由壳或脚本起，客户端在界面的另一头（D107）。
      interactive: true,
      // 装载那一次读到的四层交进宿主，可写那两层的存储由宿主按项目环境各建一份：设置那一栏说的是
      // 「哪一个项目的哪一层文件」，读与写都落在它自己身上（方案 3.2、审阅 F3）。
      // 路径与文件名在这里算，宿主说不出也换不到（方案 7.2）：它只认层名、白名单字段与读回的那一份版本。
      configLayers: layers,
      configStoreFor: (projectRoot, ownLayers) => createConfigStore({ projectRoot, layers: ownLayers }),
      ...resolveMode(config),
    });
  } catch (error) {
    const fields = errorFields(error);
    printFailure(fields.code ?? 'cli_host_failed', fields.detail);
  }
} else if (command === 'tui' || command === undefined) {
  // 终端界面是协议的第二个客户端（D33）：与 Host 同进程、走内存载体，界面只读协议帧。
  // 它需要真终端：管道那头没有 raw mode，按键与重画都无从谈起。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printFailure('tui_terminal_required', t('tui 需要交互式终端；在脚本中请使用 ligule run', 'tui needs an interactive terminal; use ligule run from a script'));
  } else {
    try {
      // React 与 Ink 在第一次被加载时按 NODE_ENV 选构建，所以这一行要在动态导入之前。
      // 开发版把界面拖贵了一倍：两千条记录的转录下提交一行是 2.6 毫秒对 1.4 毫秒，进程常驻 155 MiB 对 114 MiB。
      process.env.NODE_ENV = 'production';
      const { confirmWorkspaceTrust } = await import('./tui/trust.js');
      // 项目信任先于项目配置和资源装载；拒绝时不创建 Host 或会话。
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
  console.log(t('选项：--config <key.path=value>（可重复）、--mode <name>、--lang <zh|en|auto>', 'Options: --config <key.path=value> (repeatable), --mode <name>, --lang <zh|en|auto>'));
  console.log(t('run、tui 和 host 从配置读取 model.api、model.baseURL 与 model.model；密钥由 model.apiKeyEnv 指定，未设置时读取 LIGULE_API_KEY。', 'run, tui and host read model.api, model.baseURL and model.model from config; the key uses model.apiKeyEnv, or LIGULE_API_KEY when unset.'));
  console.log(t('run、tui 和 host 默认使用 minimal 模式；--mode 可覆盖 mode 配置。tools 和 call 不读取模式。', 'run, tui and host use the minimal mode by default; --mode overrides the mode config. tools and call do not read a mode.'));
  console.log(t('skills 列出已加载的技能与未加载原因；它不读取模型配置。', 'skills lists loaded skills and why others were skipped; it does not read model config.'));
  console.log(t('个人配置位于 ~/.ligule；可用绝对路径设置 LIGULE_HOME。', 'Personal config lives in ~/.ligule; set LIGULE_HOME to use an absolute path.'));
} else {
  // 打错的命令不该走帮助文本再退出 0：调用方是个脚本时，0 加一段帮助就是一次成功。
  printFailure('cli_command_unknown', t(`“${command}”不是有效命令；运行 ligule --help 查看命令列表`, `"${command}" is not a command; run ligule --help to list commands`));
}
