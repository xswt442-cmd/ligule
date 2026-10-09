#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
// `host` 这一条是另一件事：它把同一个内核作为 Host 进程起起来，等一条标准输入输出上的客户端连接（D30）。
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createConfig } from './kernel/config.js';
import { loadConfigLayers } from './kernel/config-file.js';
import { createConfigStore } from './kernel/config-store.js';
import { createKernel } from './kernel/kernel.js';
import { loadAssembly } from './kernel/assembly.js';
import { DEFAULT_MODE, modeDirectories } from './kernel/modes.js';
import { extensionSources } from './kernel/extensions.js';
import { discoverSkills, skillDirectories } from './kernel/skills.js';
import { createSessionLog } from './session/session.js';
import { listSessions, sessionDirectory } from './session/list.js';
import { formatVerdicts, summarizeVerdicts } from './session/verdicts.js';
import { minimalPlugin } from './tools/minimal.js';
import { networkPlugin } from './tools/network.js';
import { createHost, providerFromConfig, serveHost } from './host/host.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// 随包的模式目录与 `dist/` 同级：从本模块往上一层就是包根，本地检出与解包之后是同一个相对位置。
const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// `--config a.b=c` 可以出现多次；`--mode <名字>` 与 `--project <根>` 各取一个值；`--json` 是个旗子。
// 它们都从位置参数里挑出来。
const flags = [];
const positional = [];
const argv = process.argv.slice(2);
let missingFlagValue = false;
let missingModeValue = false;
let missingProjectValue = false;
let modeFlag;
let projectFlag;
let jsonFlag = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--json') {
    jsonFlag = true;
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
      if (arg === '--config') missingFlagValue = true;
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

async function configSnapshot(projectRoot = process.cwd()) {
  const layers = await loadConfigLayers({ projectRoot, flags });
  // 边界的默认值就是这一次指的那一根：命令行在哪里跑（或 `--project` 指了哪一根），工具就在哪里读写。任何一层配置写的 boundary 都盖得过它。
  const user = { boundary: projectRoot, ...layers.user };
  // 扩展的来源在同一次装载里算出来（D68）：项目层与本地层里写的路径不算，那一条挡住的判断在这里看得见。
  const extensions = await extensionSources({ ...layers, user }, { projectRoot });
  return { config: createConfig({ ...layers, user }), extensions, layers };
}

// 模式名按 D44：`--mode` 覆盖一次运行，否则读配置里的 `mode`，两处都没写就是随包的 minimal。
// 交出去的是名字加那三层目录，装载在 Host 那一侧做：运行中换模式要用同一套查找（D41）。
function resolveMode(config) {
  return { modeName: modeFlag ?? config.mode ?? DEFAULT_MODE, modePaths: modeDirectories(process.cwd(), shippedModes) };
}

// 一具宿主可以接多个项目，这是宿主按项目根再装载一份环境的那条路（方案 3.1、实现顺序第 69 步）。
// 走的是命令行自己启动时同一批函数：配置那几层、提供方、模式与扩展来源都按那一个项目根重算。
// `--mode` 是这一次运行的覆盖，不跟着进另一个项目的环境；要换清单由 `session.open` 的 `mode` 那一格指名。
async function projectEnvironment(projectRoot) {
  const layers = await loadConfigLayers({ projectRoot, flags });
  const user = { boundary: projectRoot, ...layers.user };
  const config = createConfig({ ...layers, user });
  return {
    config,
    provider: providerFromConfig(config),
    policy: config.policy,
    // 四层原样交回：宿主给这一份项目环境建它自己的可写层存储，设置那一栏读写都按这一个项目算（方案 3.2）。
    layers,
    modeName: config.mode ?? DEFAULT_MODE,
    modePaths: modeDirectories(projectRoot, shippedModes),
    extensions: await extensionSources({ ...layers, user }, { projectRoot }),
  };
}

async function installedKernel() {
  const { config } = await configSnapshot();
  const kernel = createKernel({ config });
  loadAssembly(kernel, [minimalPlugin, networkPlugin]);
  return kernel;
}

// 码是给脚本分支的，后面那一句是给站在终端前的人看的（D19 把码与文本分开就是为了两边各取一样）。
function printFailure(code, detail) {
  console.error(detail === undefined || detail === '' ? code : `${code}: ${detail}`);
  process.exitCode = 1;
}

async function kernelOrFail() {
  try {
    return await installedKernel();
  } catch (error) {
    printFailure(error.code ?? 'cli_kernel_failed', error.detail);
    return undefined;
  }
}

// 打印一次真实轮次（第 13 步第三条）：这具 Host 在同进程里驱动一遍，事件的出口是终端，
// 审批也问在终端上。走的是协议那一层，与桌面壳起进程时看到的是同一份东西。
function printNotification(message) {
  if (message.notify === 'delta') {
    if (message.event?.type === 'text') process.stdout.write(message.event.text);
    // 推理段走标准错误：答案那一份要留给管道另一头的脚本，想看的的人在终端里看得见（D32）。
    if (message.event?.type === 'reasoning') process.stderr.write(message.event.text);
  } else if (message.notify === 'event' && message.event?.kind === 'reasoning') {
    process.stderr.write('\n');
  } else if (message.notify === 'event' && message.event?.kind === 'assistant') {
    // 只有流上真的吐过字才收那一行，纯工具调用那一轮的文本是空的，不该留一个空行。
    if (message.event.text !== '') process.stdout.write('\n');
  } else if (message.notify === 'event' && message.event?.kind === 'tool') {
    const { tool, result } = message.event;
    console.log(`· ${tool}: ${result.failed ? result.code : 'ok'}`);
  } else if (message.notify === 'event' && message.event?.kind === 'user') {
    // 模板展开过的那一条画原始那一行（D54）：终端里回声要等于人打的字。
    console.log(`> ${message.event.raw ?? message.event.text}`);
  } else if (message.notify === 'fault') {
    console.error(message.detail === undefined ? message.code : `${message.code}: ${message.detail}`);
  }
}

// 审批问在终端上。行从进程一开头就收着：`echo y | ligule run` 那一种把答复写在问题之前，
// 那时无人在等，行也不能丢——readline 建得早，才拿得到已经到达的那一行，问出去才有答复可读。
function terminalApprovals() {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const queued = [];
  let ended = false;
  let waiter;
  const answer = (line) => {
    if (waiter === undefined) {
      if (line !== undefined) queued.push(line);
      return;
    }
    const settle = waiter;
    waiter = undefined;
    settle(line);
  };
  reader.on('line', (line) => answer(line));
  reader.on('close', () => {
    ended = true;
    answer(undefined);
  });
  return {
    // 交回 undefined 就是「没有答复」，调用方按不允许处理。
    async ask(question) {
      process.stderr.write(question);
      let line;
      if (queued.length > 0) line = queued.shift();
      else if (ended) line = undefined;
      else line = await new Promise((resolve) => {
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

async function runOneRound(config, selection, extensions, text, sessionId) {
  const host = createHost({ config, provider: providerFromConfig(config), policy: config.policy, extensions, ...selection });
  const approvals = terminalApprovals();
  const connection = {
    notify: printNotification,
    // 这一路答得了的请求只有审批那一种：一次询问，答允许或不允许。模型的提问不在这一路装载，纯命令行的下一次调用没人替它答（D107）。
    request: async (method, params) => {
      const described = params.command ?? JSON.stringify(params.args);
      // 命令文本后面说清是哪一种语法、哪一个可执行文件（D59）：同一条文本在两种语法下要问不该问是两回事。
      const backend = params.shell === undefined ? '' : ` (${params.shell}: ${params.executable ?? ''})`;
      const answer = await approvals.ask(`allow ${params.tool} ${described}${backend}? [y/N] `);
      return { decision: /^y(es)?$/i.test(String(answer).trim()) ? 'allow' : 'deny' };
    },
  };
  try {
    // 给了 id 就是接着那一份记录往下走：记录不在就是没有这次会话，不新建一份空记录顶上去（D73）。
    // 用哪一份模式清单由宿主定（D78、第 44 步）：`--mode` 写了就作为那一个参数递过去，
    // 没写时宿主取记录里最后生效的那一条并比它的摘要，这一侧不再另算一遍。
    const opened = sessionId === undefined
      ? await host.handle({ method: 'session.create', params: {} }, connection)
      : await host.handle({ method: 'session.open', params: { sessionId, ...(modeFlag === undefined ? {} : { mode: modeFlag }) } }, connection);
    const result = await host.handle({ method: 'run.start', params: { sessionId: opened.sessionId, input: text } }, connection);
    console.error(`session ${opened.sessionId}: ${result.iterations} iterations, ${result.modelCalls} model calls`);
  } finally {
    approvals.close();
    await host.release();
  }
}

if (missingFlagValue) {
  printFailure('cli_config_needs_a_value');
} else if (missingModeValue) {
  printFailure('cli_mode_needs_a_value', '--mode takes a mode name, e.g. --mode full');
} else if (missingProjectValue) {
  printFailure('cli_project_needs_a_value', '--project takes a project root to filter the listing by');
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
      console.log('no extensions loaded');
      console.log(`  looked in ${extensions.installedDirectory}`);
    }
    for (const diagnostic of extensions.ignored) console.error(`${diagnostic.code}\t${diagnostic.path}\t${diagnostic.detail}`);
  } catch (error) {
    printFailure(error.code ?? 'cli_extensions_failed', error.detail);
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
      console.log('no skills loaded');
      for (const directory of directories) console.log(`  looked in ${directory}`);
    }
    if (registry.diagnostics.length > 0) {
      console.error(`not loaded: ${registry.diagnostics.length}`);
      for (const diagnostic of registry.diagnostics) console.error(`${diagnostic.code}\t${diagnostic.detail}`);
    }
  } catch (error) {
    printFailure(error.code ?? 'cli_skills_failed', error.detail);
  }
} else if (command === 'call') {
  const [name, argsJson] = rest;
  if (name === undefined) {
    printFailure('cli_call_needs_a_tool_name');
  } else {
    let args = {};
    try {
      args = argsJson === undefined ? {} : JSON.parse(argsJson);
    } catch {
      printFailure('cli_args_invalid_json');
      args = undefined;
    }
    if (args !== undefined) {
      const kernel = await kernelOrFail();
      if (kernel) {
        try {
          const result = await kernel.call(name, args);
          console.log(typeof result?.text === 'string' ? result.text : JSON.stringify(result, null, 2));
        } catch (error) {
          printFailure(error.code ?? 'cli_call_failed', error.detail);
        }
      }
    }
  }
} else if (command === 'run') {
  const text = rest.join(' ').trim();
  if (text === '') {
    printFailure('cli_run_needs_the_user_text', 'run takes the user message, e.g. ligule run "read the note"');
  } else {
    try {
      const { config, extensions } = await configSnapshot();
      await runOneRound(config, resolveMode(config), extensions, text);
    } catch (error) {
      printFailure(error.code ?? 'cli_run_failed', error.detail);
    }
  }
} else if (command === 'resume') {
  // 接着一次已经跑过的会话往下走（D73、D78）：那一份记录不在就是没有这次会话，模式清单取记录里最后生效的那一条。
  const [sessionId, ...textParts] = rest;
  const text = textParts.join(' ').trim();
  if (sessionId === undefined) {
    printFailure('cli_resume_needs_the_session_id', 'resume takes a session id and the user message, e.g. ligule resume 5f3c "keep going"');
  } else if (text === '') {
    printFailure('cli_run_needs_the_user_text', 'resume takes the user message too, e.g. ligule resume 5f3c "keep going"');
  } else {
    try {
      const { config, extensions } = await configSnapshot();
      await runOneRound(config, resolveMode(config), extensions, text, sessionId);
    } catch (error) {
      printFailure(error.code ?? 'cli_resume_failed', error.detail);
    }
  }
} else if (command === 'sessions') {
  // 只读地列出跑过的会话（D73）：扫记录目录，不建索引也不开会话；耗时打在这一行上，U38 要的就是这个数。
  try {
    // `--project <根>` 指了哪一根就读哪一根的那一层：记录目录本身是按项目层配出来的，
    // 只在当前目录下筛项目根等于没读那个项目。
    const { config } = await configSnapshot(projectFlag);
    const directory = sessionDirectory(config);
    const started = Date.now();
    const listed = await listSessions(directory, { projectRoot: projectFlag });
    if (jsonFlag) console.log(JSON.stringify(listed));
    else if (listed.length === 0) {
      console.log('no sessions');
      console.log(`  looked in ${directory}`);
    } else {
      for (const item of listed) {
        const open = item.unanswered > 0 ? `  ${item.unanswered} dispatched without a result` : '';
        console.log(`${item.updatedAt}  ${item.id}  ${item.events} events  mode:${item.mode?.name ?? '-'}${item.name === '' ? '' : `  "${item.name}"`}${item.archived ? '  archived' : ''}${open}`);
      }
      console.error(`${listed.length} sessions in ${directory}, scanned in ${Date.now() - started}ms`);
    }
  } catch (error) {
    printFailure(error.code ?? 'cli_sessions_failed', error.detail);
  }
} else if (command === 'policy') {
  // 判定结果的汇总（D77）：读那一份记录算出来，内核里没有第二份计数器；这一条也不建内核、不开会话。
  const [sessionId] = rest;
  if (sessionId === undefined) {
    printFailure('cli_policy_needs_the_session_id', 'policy takes a session id, e.g. ligule policy 5f3c');
  } else {
    try {
      const { config } = await configSnapshot();
      const directory = sessionDirectory(config);
      if (!existsSync(join(directory, `${sessionId}.jsonl`))) {
        printFailure('session_not_found', `no record for ${sessionId} in ${directory}`);
      } else {
        const counts = summarizeVerdicts(await createSessionLog({ directory, id: sessionId }).read());
        if (jsonFlag) console.log(JSON.stringify(counts));
        else if (counts.length === 0) console.log(`no decision records in ${sessionId} (calls from before this field existed read as none)`);
        else for (const line of formatVerdicts(counts)) console.log(line);
      }
    } catch (error) {
      printFailure(error.code ?? 'cli_policy_failed', error.detail);
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
      provider: providerFromConfig(config),
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
    printFailure(error.code ?? 'cli_host_failed', error.detail);
  }
} else if (command === 'tui') {
  // 终端界面是协议的第二个客户端（D33）：与 Host 同进程、走内存载体，界面只读协议帧。
  // 它需要真终端：管道那头没有 raw mode，按键与重画都无从谈起。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printFailure('tui_terminal_required', 'the terminal UI needs an interactive terminal; use ligule run from a script');
  } else {
    try {
      const { config, extensions } = await configSnapshot();
      // React 与 Ink 在第一次被加载时按 NODE_ENV 选构建，所以这一行要在动态导入之前。
      // 开发版把界面拖贵了一倍：两千条记录的转录下提交一行是 2.6 毫秒对 1.4 毫秒，进程常驻 155 MiB 对 114 MiB。
      process.env.NODE_ENV = 'production';
      const { runTui } = await import('./tui/start.js');
      await runTui({ config, provider: providerFromConfig(config), policy: config.policy, extensions, ...resolveMode(config) });
    } catch (error) {
      const missing = error.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package '(ink|react|marked|highlight\.js|string-width)'/.test(String(error.message));
      printFailure(missing ? 'tui_dependency_missing' : error.code ?? 'cli_tui_failed',
        missing ? 'the terminal UI requires optional dependencies: npm install ink react marked highlight.js string-width' : error.detail);
    }
  }
} else if (command === undefined || command === '--help' || command === '-h') {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`);
  console.log('commands: tools, skills, extensions, sessions, policy <session-id>, run <text>, resume <id> <text>, call <tool> [json-args], tui, host, --version');
  console.log('options: --config <key.path=value> (repeatable), --mode <name>');
  console.log('run, tui and host read model.api ("messages" or "chat-completions"), model.baseURL and model.model from the config layers; the key comes from the environment variable named by model.apiKeyEnv, or LIGULE_API_KEY when that one is not written');
  console.log('run, tui and host also pick a mode: --mode <name> overrides the config `mode`, and neither one written means the shipped "minimal" (D44); tools and call do not read one');
  console.log('skills lists what this directory would load and why any skill was skipped; it reads the four skill directories and no model config');
} else {
  // 打错的命令不该走帮助文本再退出 0：调用方是个脚本时，0 加一段帮助就是一次成功。
  printFailure('cli_command_unknown', `"${command}" is not a command; run ligule --help to list them`);
}
