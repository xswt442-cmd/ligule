#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
import { readFileSync } from 'node:fs';
import { createConfig } from './config.js';
import { loadConfigLayers } from './config-file.js';
import { createKernel } from './kernel.js';
import { loadAssembly } from './assembly.js';
import { minimalPlugin } from './minimal.js';

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

async function installedKernel() {
  const layers = await loadConfigLayers({ projectRoot: process.cwd(), flags });
  // 边界兜底取当前工作目录：命令行在哪里跑，工具就能在哪里读写。任何一层配置都盖得过它。
  const kernel = createKernel({
    config: createConfig({ ...layers, user: { boundary: process.cwd(), ...layers.user } }),
  });
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
} else {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`);
  console.log('commands: tools, call <tool> [json-args], --version');
  console.log('options: --config <key.path=value> (repeatable)');
}
