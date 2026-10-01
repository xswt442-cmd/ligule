// 最小配置：默认运行的全部内容是一条显式清单，不是「关掉一大堆之后的结果」（I1、architecture.md 第四节、D3）。
// 内核本身仍然一件工具都不提供，这一份清单是装载侧交出去的第一个插件。
import { createTool, deleteTool, editTool, findTool, readTool, searchTool, writeTool } from './tools.js';
import { execTool } from './exec.js';

export const minimalTools = Object.freeze([
  execTool, findTool, searchTool, readTool, createTool, writeTool, editTool, deleteTool,
]);

export const minimalPlugin = {
  name: 'ligule-minimal',
  setup(kernel) {
    const disposers = minimalTools.map((tool) => kernel.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
};
