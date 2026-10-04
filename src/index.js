export { createKernel } from './kernel/kernel.js';
export { KernelError, KernelRuntimeError } from './kernel/error.js';
export { createConfig, LAYER_ORDER } from './kernel/config.js';
export { loadConfigLayers, flagLayer, configPaths } from './kernel/config-file.js';
export { createLogger } from './kernel/log.js';
export { loadAssembly } from './kernel/assembly.js';
export { loadMode, applyMode, modeDirectories, MODE_DIRECTORY, DEFAULT_MODE } from './kernel/modes.js';
export {
  discoverSkills, skillDirectories, formatSkillCatalog, searchSkills, readSkillBody, listSkillFiles,
  SKILL_FILE, SKILLS_DIRECTORY, SKILL_METADATA_BUDGET_BYTES,
} from './kernel/skills.js';
export { createSkillTool, createSkillPlugin } from './tools/skill.js';
export { fetchTool, networkPlugin } from './tools/network.js';
export { classifyAddress, resolveTarget, fetchTarget } from './capability/network.js';
export {
  discoverTemplates, templateDirectories, parseInvocation, findTemplate, splitArguments, expandTemplate,
  PROMPTS_DIRECTORY,
} from './kernel/templates.js';
export { minimalTools, minimalPlugin } from './tools/minimal.js';
export { createSlotRegistry } from './kernel/slots.js';
export { loadInstructions } from './capability/instructions.js';
export { isWithin, resolveWithin } from './capability/paths.js';
export { probeBackend } from './capability/capability.js';
export { createDecisionChain, DEFAULT_THRESHOLDS } from './kernel/policy.js';
export { parseCommand } from './capability/command.js';
export { resolveShell, withNativeExitCode } from './capability/shell.js';
export { readOnlyTools, readTool, findTool, searchTool } from './tools/read-only.js';
export { writeTools, createTool, writeTool, editTool, deleteTool } from './tools/write.js';
export { DEFAULT_LIMITS } from './capability/limits.js';
export { createObservationLog, versionOf } from './session/observe.js';
export { resolveRecycler, windowsRecycleBin, freedesktopTrash } from './capability/recycle.js';
export { resolveRipgrep, searchWithRipgrep } from './capability/ripgrep.js';
export { execTool } from './capability/exec.js';
export { createPromptAssembly, PROMPT_BOUNDARY } from './kernel/prompt.js';
export { createSessionLog } from './session/session.js';
export { createLoop, DEFAULT_LOOP_LIMITS } from './kernel/loop.js';
export {
  METHODS, APPROVAL_METHOD, NOTIFICATIONS, validateCall, isApproved,
} from './host/protocol.js';
export { createConnection } from './host/connection.js';
export { createMemoryConnectionPair } from './host/memory.js';
export { createHost, serveHost, providerFromConfig } from './host/host.js';
export {
  createMessagesProvider, capabilitiesOf, MESSAGES_CAPABILITIES,
} from './model/messages.js';
export {
  createChatCompletionsProvider, chatCompletionsCapabilities, CHAT_COMPLETIONS_CAPABILITIES,
} from './model/chat-completions.js';
export { DEFAULT_RETRY } from './model/http.js';
export { resultOf, failureOf, refusalOf, spillContent, resultLimit, DEFAULT_RESULT_BYTES } from './kernel/result.js';

// 与 package.json#version 保持一致，test/kernel.test.js 断言这一点。
export const VERSION = '0.0.1';
