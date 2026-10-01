#!/usr/bin/env node
// CLI 适配器：与内核同进程直接调用，不起端口（D23、实现顺序第 13 步）。
// 它自己不持有任何能力：装载的是那份显式的最小清单，内核一件工具都没有（I1）。
import { readFileSync } from 'node:fs';
import { createConfig } from './config.js';
import { createKernel } from './kernel.js';
import { loadAssembly } from './assembly.js';
import { minimalPlugin } from './minimal.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [command, ...rest] = process.argv.slice(2);

function installedKernel() {
  // 边界取当前工作目录：命令行在哪里跑，工具就能在哪里读写。
  const kernel = createKernel({ config: createConfig({ user: { boundary: process.cwd() } }) });
  loadAssembly(kernel, [minimalPlugin]);
  return kernel;
}

function printFailure(code) {
  console.error(code);
  process.exitCode = 1;
}

if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === 'tools') {
  // 默认运行装的就是那份显式的最小清单（D3）。
  for (const name of installedKernel().list()) console.log(name);
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
      const kernel = installedKernel();
      try {
        const result = await kernel.call(name, args);
        console.log(typeof result?.text === 'string' ? result.text : JSON.stringify(result, null, 2));
      } catch (error) {
        printFailure(error.code ?? 'cli_call_failed');
      }
    }
  }
} else {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`);
  console.log('commands: tools, call <tool> [json-args], --version');
}
