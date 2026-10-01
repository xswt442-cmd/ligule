export { createKernel } from './kernel.js';
export { KernelError, KernelRuntimeError } from './error.js';
export { createConfig, LAYER_ORDER } from './config.js';
export { loadConfigLayers, flagLayer, configPaths } from './config-file.js';
export { createLogger } from './log.js';
export { loadAssembly } from './assembly.js';
export { minimalTools, minimalPlugin } from './minimal.js';
export { createSlotRegistry } from './slots.js';
export { loadInstructions } from './instructions.js';
export { isWithin, resolveWithin } from './paths.js';
export { probeBackend } from './capability.js';
export { createDecisionChain, DEFAULT_THRESHOLDS } from './policy.js';
export { parseCommand } from './command.js';
export {
  readOnlyTools, readTool, findTool, searchTool,
  writeTools, createTool, writeTool, editTool, deleteTool, DEFAULT_LIMITS,
} from './tools.js';
export { createObservationLog, versionOf } from './observe.js';
export { resolveRecycler, windowsRecycleBin, freedesktopTrash } from './recycle.js';
export { resolveRipgrep, searchWithRipgrep } from './ripgrep.js';
export { execTool } from './exec.js';
export { createPromptAssembly, PROMPT_BOUNDARY } from './prompt.js';
export { createSessionLog } from './session.js';
export { createLoop, DEFAULT_LOOP_LIMITS } from './loop.js';
export {
  createMessagesProvider, capabilitiesOf, MESSAGES_CAPABILITIES, DEFAULT_RETRY,
} from './provider.js';
export { resultOf, failureOf, refusalOf, spillContent, resultLimit, DEFAULT_RESULT_BYTES } from './result.js';

// 与 package.json#version 保持一致，test/kernel.test.js 断言这一点。
export const VERSION = '0.0.1';
