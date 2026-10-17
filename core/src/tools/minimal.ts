// 默认运行的工具由显式清单定义；未列入清单的能力不会自动加载。
// Kernel 不内置工具；最小工具集由加载器通过插件显式注册。
import { createTool, deleteTool, editTool, writeTool } from './write.js';
import { findTool, readTool, searchTool } from './read-only.js';
import { execTool } from '../capability/exec.js';
import type { Kernel, ToolDefinition } from '../kernel/kernel.js';
import type { Plugin } from '../kernel/assembly.js';

export const minimalTools: readonly ToolDefinition[] = Object.freeze([
  execTool, findTool, searchTool, readTool, createTool, writeTool, editTool, deleteTool,
]);

export const minimalPlugin: Plugin<Kernel> = {
  name: 'ligule-minimal',
  setup(kernel: Kernel) {
    const disposers = minimalTools.map((tool) => kernel.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
};
