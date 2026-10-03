#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
// `host` 这一条是另一件事：它把同一个内核作为 Host 进程起起来，等一条标准输入输出上的客户端连接（D30）。
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createConfig } from './kernel/config.js';
import { loadConfigLayers } from './kernel/config-file.js';
import { createKernel } from './kernel/kernel.js';
import { loadAssembly } from './kernel/assembly.js';
import { DEFAULT_MODE, modeDirectories } from './kernel/modes.js';
import { discoverSkills, skillDirectories } from './kernel/skills.js';
import { minimalPlugin } from './tools/minimal.js';
import { createHost, providerFromConfig, serveHost } from './host/host.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// 随包的模式目录与 `dist/` 同级：从本模块往上一层就是包根，本地检出与解包之后是同一个相对位置。
const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));

// `--config a.b=c` 可以出现多次；`--mode <名字>` 取一个值。两者都从位置参数里挑出来。
const flags = [];
const positional = [];
const argv = process.argv.slice(2);
let missingFlagValue = false;
let missingModeValue = false;
let modeFlag;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
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

async function configSnapshot() {
  const layers = await loadConfigLayers({ projectRoot: process.cwd(), flags });
  // 边界兜底取当前工作目录：命令行在哪里跑，工具就能在哪里读写。任何一层配置都盖得过它。
  return createConfig({ ...layers, user: { boundary: process.cwd(), ...layers.user } });
}

// 模式名按 D44：`--mode` 覆盖一次运行，否则读配置里的 `mode`，两处都没写就是随包的 minimal。
// 交出去的是名字加那三层目录，装载在 Host 那一侧做：运行中换模式要用同一套查找（D41）。
function resolveMode(config) {
  return { modeName: modeFlag ?? config.mode ?? DEFAULT_MODE, modePaths: modeDirectories(process.cwd(), shippedModes) };
}

async function installedKernel() {
  const kernel = createKernel({ config: await configSnapshot() });
  loadAssembly(kernel, [minimalPlugin]);
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
// 那时无人在等，行也不能丢（本机实测：等有人问再建 readline，先前那一行已经被读走了，问出去就一直没有答复）。
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

async function runOneRound(config, selection, text) {
  const host = createHost({ config, provider: providerFromConfig(config), policy: config.policy, ...selection });
  const approvals = terminalApprovals();
  const connection = {
    notify: printNotification,
    // 协议里 Host 只发出这一种请求：一次询问，答允许或不允许。
    request: async (method, params) => {
      const described = params.command ?? JSON.stringify(params.args);
      const answer = await approvals.ask(`allow ${params.tool} ${described}? [y/N] `);
      return { decision: /^y(es)?$/i.test(String(answer).trim()) ? 'allow' : 'deny' };
    },
  };
  try {
    const { sessionId } = await host.handle({ method: 'session.create', params: {} }, connection);
    const result = await host.handle({ method: 'run.start', params: { sessionId, input: text } }, connection);
    console.error(`session ${sessionId}: ${result.iterations} iterations, ${result.modelCalls} model calls`);
  } finally {
    approvals.close();
    host.release();
  }
}

if (missingFlagValue) {
  printFailure('cli_config_needs_a_value');
} else if (missingModeValue) {
  printFailure('cli_mode_needs_a_value', '--mode takes a mode name, e.g. --mode full');
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === 'tools') {
  // 默认运行装的就是那份显式的最小清单（D3）。
  const kernel = await kernelOrFail();
  if (kernel) for (const name of kernel.list()) console.log(name);
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
      const config = await configSnapshot();
      await runOneRound(config, resolveMode(config), text);
    } catch (error) {
      printFailure(error.code ?? 'cli_run_failed', error.detail);
    }
  }
} else if (command === 'host') {
  // 桌面壳或者脚本起这一个进程，两端各读写一行 JSON（D30）：本机不开端口，审批与事件都走这条连接。
  try {
    const config = await configSnapshot();
    serveHost({ config, provider: providerFromConfig(config), policy: config.policy, ...resolveMode(config) });
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
      const config = await configSnapshot();
      // React 与 Ink 在第一次被加载时按 NODE_ENV 选构建，所以这一行要在动态导入之前。
      // 开发版把界面拖贵了一倍：两千条记录的转录下提交一行是 2.6 毫秒对 1.4 毫秒，进程常驻 155 MiB 对 114 MiB。
      process.env.NODE_ENV = 'production';
      const { runTui } = await import('./tui/start.js');
      await runTui({ config, provider: providerFromConfig(config), policy: config.policy, ...resolveMode(config) });
    } catch (error) {
      const missing = error.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package '(ink|react)'/.test(String(error.message));
      printFailure(missing ? 'tui_dependency_missing' : error.code ?? 'cli_tui_failed',
        missing ? 'the terminal UI is an optional dependency: npm install ink react' : error.detail);
    }
  }
} else if (command === undefined || command === '--help' || command === '-h') {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`);
  console.log('commands: tools, skills, run <text>, call <tool> [json-args], tui, host, --version');
  console.log('options: --config <key.path=value> (repeatable), --mode <name>');
  console.log('run, tui and host read model.api ("messages" or "chat-completions"), model.baseURL and model.model from the config layers; the key comes from LIGULE_API_KEY');
  console.log('run, tui and host also pick a mode: --mode <name> overrides the config `mode`, and neither one written means the shipped "minimal" (D44); tools and call do not read one');
  console.log('skills lists what this directory would load and why any skill was skipped; it reads the four skill directories and no model config');
} else {
  // 打错的命令不该走帮助文本再退出 0：调用方是个脚本时，0 加一段帮助就是一次成功。
  printFailure('cli_command_unknown', `"${command}" is not a command; run ligule --help to list them`);
}
