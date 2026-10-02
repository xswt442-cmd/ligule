#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
// `host` 这一条是另一件事：它把同一个内核作为 Host 进程起起来，等一条标准输入输出上的客户端连接（D30）。
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createConfig } from './kernel/config.js';
import { loadConfigLayers } from './kernel/config-file.js';
import { createKernel } from './kernel/kernel.js';
import { loadAssembly } from './kernel/assembly.js';
import { minimalPlugin } from './tools/minimal.js';
import { createHost, providerFromConfig, serveHost } from './host/host.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// `--config a.b=c` 可以出现多次，从位置参数里挑出来；剩下的按「命令、工具名、一段 JSON」三段读。
const flags = [];
const positional = [];
const argv = process.argv.slice(2);
let missingFlagValue = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg !== '--config') {
    positional.push(arg);
    continue;
  }
  const value = argv[index + 1];
  if (value === undefined) {
    missingFlagValue = true;
    break;
  }
  flags.push(value);
  index += 1;
}
const [command, ...rest] = positional;

async function configSnapshot() {
  const layers = await loadConfigLayers({ projectRoot: process.cwd(), flags });
  // 边界兜底取当前工作目录：命令行在哪里跑，工具就能在哪里读写。任何一层配置都盖得过它。
  return createConfig({ ...layers, user: { boundary: process.cwd(), ...layers.user } });
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
    console.log(`> ${message.event.text}`);
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

async function runOneRound(config, text) {
  const host = createHost({ config, provider: providerFromConfig(config), policy: config.policy });
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
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === 'tools') {
  // 默认运行装的就是那份显式的最小清单（D3）。
  const kernel = await kernelOrFail();
  if (kernel) for (const name of kernel.list()) console.log(name);
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
      await runOneRound(await configSnapshot(), text);
    } catch (error) {
      printFailure(error.code ?? 'cli_run_failed', error.detail);
    }
  }
} else if (command === 'host') {
  // 桌面壳或者脚本起这一个进程，两端各读写一行 JSON（D30）：本机不开端口，审批与事件都走这条连接。
  try {
    const config = await configSnapshot();
    serveHost({ config, provider: providerFromConfig(config), policy: config.policy });
  } catch (error) {
    printFailure(error.code ?? 'cli_host_failed', error.detail);
  }
} else if (command === undefined || command === '--help' || command === '-h') {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`);
  console.log('commands: tools, run <text>, call <tool> [json-args], host, --version');
  console.log('options: --config <key.path=value> (repeatable)');
  console.log('run and host read model.api ("messages" or "chat-completions"), model.baseURL and model.model from the config layers; the key comes from LIGULE_API_KEY');
} else {
  // 打错的命令不该走帮助文本再退出 0：调用方是个脚本时，0 加一段帮助就是一次成功。
  printFailure('cli_command_unknown', `"${command}" is not a command; run ligule --help to list them`);
}
