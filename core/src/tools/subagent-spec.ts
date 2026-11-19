// Subagent 的「有效规格」解析：preset、模式、权限、生成参数与预算的最终取值。
//
// 预览与真实启动都必须经过这里的同一份判定；调用方只负责把当前授权与运行状态传进来，
// 不允许在启动路径上再写一套更宽松的校验。该模块不启动 Run，也不接触会话记录。
import { createHash } from 'node:crypto';
import {
  resolveModeSelection,
  type ModeDirectories,
  type ModeFile,
  type ModePromptFragment,
  type RequestedModeSelection,
} from '../kernel/modes.js';
import { createPermissionContext, type PermissionContext, type PermissionNetwork, type PermissionProfile } from '../kernel/permission.js';
import { createOutputSchemaContract } from '../delegation.js';
import { KernelError } from '../kernel/error.js';
import { DEFAULT_LOOP_LIMITS, type LoopLimits } from '../kernel/loop.js';
import { loadAgentPreset, type AgentPreset, type AgentPresetDirectories } from '../kernel/agent-presets.js';
import type { createLoop } from '../kernel/loop.js';

type LoopOptions = Parameters<typeof createLoop>[0];

export type ThinkingEffort = 'none' | 'low' | 'high' | 'max';
type ChildGenerationOptions = { readonly outputTokens?: number; readonly thinkingEffort?: ThinkingEffort };
export type SubagentProvider = LoopOptions['provider'] & {
  readonly outputTokens?: number;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingCapability?: { readonly efforts: readonly string[]; readonly defaultEffort: string };
  withGeneration?: (options: ChildGenerationOptions) => SubagentProvider;
};

export interface SubagentRunArguments {
  readonly task?: string;
  readonly presetId?: string;
  readonly mode?: RequestedModeSelection;
  readonly outputTokens?: number;
  readonly thinkingEffort?: ThinkingEffort;
  readonly loopIterations?: number;
  readonly modelCalls?: number;
  readonly outputSchema?: Record<string, unknown>;
}

export interface AgentPresetPreview {
  readonly presetId: string;
  readonly layer: AgentPreset['layer'];
  readonly digest: string;
  readonly description: string;
  readonly instruction: string;
  readonly executable: boolean;
  readonly mode: { readonly name: string; readonly tools: readonly string[] | '*'; readonly prompt: readonly string[] | '*' };
  readonly permission: { readonly profile: PermissionProfile; readonly network: PermissionNetwork };
  readonly generation: { readonly outputTokens: number | null; readonly thinkingEffort: string | null };
  readonly limits: { readonly loopIterations: number; readonly modelCalls: number };
  readonly outputSchemaDigest?: string;
  readonly requiredChecks: readonly string[];
  readonly narrowedFields: readonly string[];
}

export interface SubagentCallContext {
  readonly signal?: AbortSignal;
  readonly permission: PermissionContext;
  readonly runId?: string;
  readonly executionId?: string;
  readonly callId?: string;
}

export interface PreparedSubagentRun {
  readonly args: SubagentRunArguments;
  readonly preset?: AgentPreset;
  readonly provider: SubagentProvider;
  readonly limits: LoopLimits;
  readonly outputContract?: ReturnType<typeof createOutputSchemaContract>;
  readonly permission: PermissionContext;
  readonly resolvedMode?: Awaited<ReturnType<typeof resolveModeSelection>>;
  readonly preview?: AgentPresetPreview;
  readonly snapshot?: Record<string, unknown>;
}

// 父 Kernel 的可见工具与可选项；解析时只读，不注册新工具。
export interface ParentKernelView {
  manifest(): readonly { readonly name: string }[];
  selectable(): readonly string[];
}

export interface SubagentSpecDeps {
  readonly loopLimits?: LoopLimits;
  readonly modePaths?: ModeDirectories;
  readonly presetDirectories?: AgentPresetDirectories;
  readonly modeFile?: () => ModeFile | undefined;
  readonly promptFragments?: () => readonly ModePromptFragment[];
  readonly provider: SubagentProvider;
}

export interface SubagentSpecAccess {
  readonly deps: SubagentSpecDeps;
  /** 启动子 Run 之前父 Kernel 必须已注册完毕；预览可以尚未就绪。 */
  readonly parentKernel: () => ParentKernelView | undefined;
  readonly parentClosed: (runId: string) => boolean;
}

function childLimits(args: { loopIterations?: number; modelCalls?: number }, parent: LoopLimits) {
  const limits = {
    iterations: args.loopIterations ?? parent.iterations,
    modelCalls: args.modelCalls ?? parent.modelCalls,
    ...(parent.maxParallelTools === undefined ? {} : { maxParallelTools: parent.maxParallelTools }),
  };
  if (limits.iterations > parent.iterations || limits.modelCalls > parent.modelCalls) {
    throw new KernelError('subagent_budget_escalation', { detail: 'a child run may only use budgets within its parent session limits' });
  }
  return limits;
}

function childProvider(args: { outputTokens?: number; thinkingEffort?: ThinkingEffort }, provider: SubagentProvider): SubagentProvider {
  if (args.outputTokens === undefined && args.thinkingEffort === undefined) return provider;
  if (provider.withGeneration === undefined) {
    throw new KernelError('subagent_generation_unavailable', { detail: 'this provider cannot create a bounded child generation' });
  }
  if (args.outputTokens !== undefined
    && (provider.outputTokens === undefined || args.outputTokens > provider.outputTokens)) {
    throw new KernelError('subagent_output_budget_escalation', { detail: 'a child output-token limit cannot exceed the parent session limit' });
  }
  if (args.thinkingEffort !== undefined) {
    const capability = provider.thinkingCapability;
    if (capability === undefined || !capability.efforts.includes(args.thinkingEffort)) {
      throw new KernelError('provider_thinking_effort_invalid', { detail: 'the selected provider does not support this thinking effort' });
    }
    const ceiling = provider.thinkingEffort ?? capability.defaultEffort;
    const ranks: Record<ThinkingEffort, number> = { none: 0, low: 1, high: 2, max: 3 };
    if (ranks[args.thinkingEffort] > (ranks[ceiling as ThinkingEffort] ?? 0)) {
      throw new KernelError('subagent_thinking_escalation', { detail: 'a child thinking effort cannot exceed the parent session setting' });
    }
  }
  const options: { outputTokens?: number; thinkingEffort?: ThinkingEffort } = {};
  const outputTokens = args.outputTokens ?? provider.outputTokens;
  if (outputTokens !== undefined) options.outputTokens = outputTokens;
  const thinkingEffort = args.thinkingEffort ?? provider.thinkingEffort;
  if (thinkingEffort !== undefined) options.thinkingEffort = thinkingEffort;
  return provider.withGeneration(options);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const PROFILE_RANK: Record<PermissionProfile, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const NETWORK_RANK: Record<PermissionNetwork, number> = { disabled: 0, policy: 1, unrestricted: 2 };
const THINKING_RANK: Record<ThinkingEffort, number> = { none: 0, low: 1, high: 2, max: 3 };

function intersection(left: readonly string[] | '*', right: readonly string[] | '*', allowed: readonly string[]): readonly string[] | '*' {
  if (left === '*' && right === '*') return '*';
  const leftSet = new Set(left === '*' ? allowed : left);
  const rightSet = new Set(right === '*' ? allowed : right);
  return allowed.filter(name => leftSet.has(name) && rightSet.has(name));
}

export async function resolveSubagentSpec(
  access: SubagentSpecAccess,
  args: SubagentRunArguments,
  context: SubagentCallContext,
  requireTask: boolean,
): Promise<PreparedSubagentRun> {
  const { deps, parentClosed } = access;
  const parentKernel = access.parentKernel();
  if (requireTask && (typeof args.task !== 'string' || args.task.trim() === '')) {
    throw new KernelError('subagent_task_required');
  }
  const parentLimits = deps.loopLimits ?? DEFAULT_LOOP_LIMITS;
  if (args.presetId === undefined) {
    const namedMode = typeof args.mode === 'string' || (typeof args.mode === 'object' && args.mode?.type === 'named');
    if (namedMode && deps.modePaths === undefined) {
      throw new KernelError('subagent_mode_paths_required', { detail: 'this run has no mode directories to look a name up in' });
    }
    const outputContract = args.outputSchema === undefined ? undefined : createOutputSchemaContract(args.outputSchema);
    const limits = childLimits(args, parentLimits);
    const provider = childProvider(args, deps.provider);
    let resolvedMode = await resolveModeSelection(args.mode, deps.modePaths, deps.modeFile?.());
    if (args.mode === undefined && resolvedMode !== undefined && parentKernel !== undefined
      && resolvedMode.application.tools !== '*') {
      const parentTools = new Set(parentKernel.manifest().map(tool => tool.name));
      resolvedMode = { ...resolvedMode, application: { ...resolvedMode.application,
        tools: resolvedMode.application.tools.filter(name => parentTools.has(name)) } };
    }
    return { args, provider, limits, ...(outputContract === undefined ? {} : { outputContract }),
      permission: context.permission, resolvedMode };
  }
  if (deps.presetDirectories === undefined) throw new KernelError('agent_preset_unavailable');
  if (parentKernel === undefined) throw new KernelError('subagent_runtime_unavailable');
  const preset = await loadAgentPreset(args.presetId, deps.presetDirectories);
  const parentMode = deps.modeFile?.();
  const parentTools = parentKernel.selectable();
  const fragments = deps.promptFragments?.() ?? [];
  const parentPrompt = parentMode?.prompt === undefined || parentMode.prompt === '*'
    ? fragments.map(fragment => fragment.name) : [...parentMode.prompt];
  const fragmentNames = new Set(fragments.map(fragment => fragment.name));

  const resolvePresetMode = async (selection: AgentPreset['mode'] | RequestedModeSelection) => {
    if (deps.modePaths === undefined) throw new KernelError('agent_preset_mode_invalid');
    try {
      const resolved = await resolveModeSelection(selection as RequestedModeSelection, deps.modePaths);
      if (resolved === undefined) throw new KernelError('agent_preset_mode_invalid');
      return resolved;
    } catch {
      throw new KernelError('agent_preset_mode_invalid');
    }
  };
  const validateMode = (mode: NonNullable<PreparedSubagentRun['resolvedMode']>): void => {
    const tools = mode.application.tools;
    if (tools !== '*' && tools.some(name => !parentTools.includes(name))) {
      throw new KernelError('agent_preset_tool_unavailable');
    }
    const prompt = mode.application.prompt;
    if (prompt !== '*' && prompt.some(name => !parentPrompt.includes(name) || !fragmentNames.has(name))) {
      throw new KernelError('agent_preset_prompt_unavailable');
    }
  };
  const presetSelection: RequestedModeSelection = typeof preset.mode === 'string' ? preset.mode : preset.mode;
  const presetMode = await resolvePresetMode(presetSelection);
  validateMode(presetMode);
  const presetPrompt = presetMode.application.prompt === '*' ? parentPrompt : presetMode.application.prompt;
  let resolvedMode = {
    ...presetMode,
    application: { ...presetMode.application, prompt: presetPrompt },
  };
  if (args.mode !== undefined) {
    const override = await resolvePresetMode(args.mode);
    validateMode(override);
    const tools = intersection(presetMode.application.tools, override.application.tools, parentTools);
    const overridePrompt = override.application.prompt === '*' ? parentPrompt : override.application.prompt;
    const promptSelection = intersection(presetPrompt, overridePrompt, parentPrompt);
    const prompt = promptSelection === '*' ? parentPrompt : promptSelection;
    resolvedMode = {
      application: { name: 'inline', tools, prompt }, source: 'inline', name: 'inline', layer: 'inline',
    };
  }

  const narrowedFields: string[] = [];
  const parentPermission = context.permission;
  const profile = preset.permissionProfile === undefined || PROFILE_RANK[preset.permissionProfile] > PROFILE_RANK[parentPermission.profile]
    ? parentPermission.profile : preset.permissionProfile;
  const network = preset.network === undefined || NETWORK_RANK[preset.network] > NETWORK_RANK[parentPermission.network]
    ? parentPermission.network : preset.network;
  if (profile !== preset.permissionProfile && preset.permissionProfile !== undefined) narrowedFields.push('permissionProfile');
  if (network !== preset.network && preset.network !== undefined) narrowedFields.push('network');
  if (profile !== parentPermission.profile) narrowedFields.push('permissionProfile');
  if (network !== parentPermission.network) narrowedFields.push('network');
  const permission = createPermissionContext(profile, network, parentPermission.capabilities, {
    profiles: parentPermission.profiles,
    limitations: parentPermission.limitations,
    partialWorkspaceWriteConfirmationRequired: parentPermission.partialWorkspaceWriteConfirmationRequired,
    partialWorkspaceWriteConfirmed: parentPermission.partialWorkspaceWriteConfirmed,
    workspaceTrusted: parentPermission.workspaceTrusted,
  });

  const explicitLimits = {
    loopIterations: args.loopIterations,
    modelCalls: args.modelCalls,
  };
  const resolveLimit = (field: 'loopIterations' | 'modelCalls', presetValue: number | undefined, explicit: number | undefined, parent: number): number => {
    if (explicit !== undefined && presetValue !== undefined && explicit > presetValue) {
      throw new KernelError('agent_preset_override_escalation', { detail: `${field} exceeds the selected preset limit` });
    }
    if (explicit !== undefined && explicit > parent) {
      throw new KernelError('subagent_budget_escalation', { detail: `${field} exceeds the parent session limit` });
    }
    if (presetValue !== undefined && presetValue > parent) narrowedFields.push(field);
    return explicit ?? Math.min(presetValue ?? parent, parent);
  };
  const loopIterations = resolveLimit('loopIterations', preset.loopIterations, explicitLimits.loopIterations, parentLimits.iterations);
  const modelCalls = resolveLimit('modelCalls', preset.modelCalls, explicitLimits.modelCalls, parentLimits.modelCalls);

  const parentOutputTokens = deps.provider.outputTokens;
  const explicitOutputTokens = args.outputTokens;
  if (explicitOutputTokens !== undefined && preset.outputTokens !== undefined && explicitOutputTokens > preset.outputTokens) {
    throw new KernelError('agent_preset_override_escalation', { detail: 'outputTokens exceeds the selected preset limit' });
  }
  if (explicitOutputTokens !== undefined && (parentOutputTokens === undefined || explicitOutputTokens > parentOutputTokens)) {
    throw new KernelError('subagent_output_budget_escalation');
  }
  if (preset.outputTokens !== undefined && parentOutputTokens !== undefined && preset.outputTokens > parentOutputTokens) {
    narrowedFields.push('outputTokens');
  }
  const effectiveOutputTokens = explicitOutputTokens
    ?? (preset.outputTokens === undefined ? undefined : Math.min(preset.outputTokens, parentOutputTokens ?? preset.outputTokens));

  const parentEffort = deps.provider.thinkingEffort ?? deps.provider.thinkingCapability?.defaultEffort;
  const explicitEffort = args.thinkingEffort;
  if (explicitEffort !== undefined && preset.thinkingEffort !== undefined
    && THINKING_RANK[explicitEffort] > THINKING_RANK[preset.thinkingEffort]) {
    throw new KernelError('agent_preset_override_escalation', { detail: 'thinkingEffort exceeds the selected preset limit' });
  }
  if (explicitEffort !== undefined && parentEffort !== undefined
    && THINKING_RANK[explicitEffort] > (THINKING_RANK[parentEffort as ThinkingEffort] ?? 0)) {
    throw new KernelError('subagent_thinking_escalation');
  }
  if (preset.thinkingEffort !== undefined && deps.provider.thinkingCapability?.efforts.includes(preset.thinkingEffort) !== true) {
    throw new KernelError('provider_thinking_effort_invalid');
  }
  const effectiveEffort = explicitEffort ?? (preset.thinkingEffort === undefined ? undefined
    : parentEffort !== undefined && THINKING_RANK[preset.thinkingEffort] > (THINKING_RANK[parentEffort as ThinkingEffort] ?? 0)
      ? (narrowedFields.push('thinkingEffort'), parentEffort as ThinkingEffort) : preset.thinkingEffort);
  if (effectiveEffort !== undefined && parentEffort !== undefined && effectiveEffort !== parentEffort) narrowedFields.push('thinkingEffort');

  if (args.outputSchema !== undefined && preset.outputSchema !== undefined
    && canonicalJson(args.outputSchema) !== canonicalJson(preset.outputSchema)) {
    throw new KernelError('agent_preset_output_schema_conflict');
  }
  const outputSchema = preset.outputSchema ?? args.outputSchema;
  let outputContract: ReturnType<typeof createOutputSchemaContract> | undefined;
  try { outputContract = outputSchema === undefined ? undefined : createOutputSchemaContract(outputSchema); }
  catch { throw new KernelError('agent_preset_schema_invalid'); }

  const generationArgs: { outputTokens?: number; thinkingEffort?: ThinkingEffort } = {};
  if (effectiveOutputTokens !== undefined && (explicitOutputTokens !== undefined || effectiveOutputTokens !== parentOutputTokens)) {
    generationArgs.outputTokens = effectiveOutputTokens;
  }
  if (effectiveEffort !== undefined && (explicitEffort !== undefined || effectiveEffort !== parentEffort)) {
    generationArgs.thinkingEffort = effectiveEffort;
  }
  const provider = childProvider(generationArgs, deps.provider);
  const limits = childLimits({ loopIterations, modelCalls }, parentLimits);
  const effectiveArgs: SubagentRunArguments = {
    ...args,
    loopIterations,
    modelCalls,
    ...(generationArgs.outputTokens === undefined ? {} : { outputTokens: generationArgs.outputTokens }),
    ...(generationArgs.thinkingEffort === undefined ? {} : { thinkingEffort: generationArgs.thinkingEffort }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
  const preview: AgentPresetPreview = {
    presetId: preset.id, layer: preset.layer, digest: preset.digest, description: preset.description,
    instruction: preset.instruction, executable: context.runId !== undefined && !parentClosed(context.runId),
    mode: { name: resolvedMode.name, tools: resolvedMode.application.tools, prompt: resolvedMode.application.prompt },
    permission: { profile: permission.profile, network: permission.network },
    generation: {
      outputTokens: provider.outputTokens ?? null,
      thinkingEffort: provider.thinkingEffort ?? provider.thinkingCapability?.defaultEffort ?? null,
    },
    limits: { loopIterations: limits.iterations, modelCalls: limits.modelCalls },
    ...(outputContract === undefined ? {} : { outputSchemaDigest: outputContract.digest }),
    requiredChecks: preset.requiredChecks ?? [],
    narrowedFields: [...new Set(narrowedFields)],
  };
  const snapshot: Record<string, unknown> = {
    version: 1,
    preset: { id: preset.id, layer: preset.layer, digest: preset.digest },
    instruction: preset.instruction,
    instructionDigest: createHash('sha256').update(preset.instruction).digest('hex'),
    mode: {
      name: resolvedMode.name,
      source: resolvedMode.source,
      layer: resolvedMode.layer,
      ...(resolvedMode.fileDigest === undefined ? {} : { fileDigest: resolvedMode.fileDigest }),
      tools: resolvedMode.application.tools,
      prompt: resolvedMode.application.prompt,
    },
    generation: preview.generation,
    limits: preview.limits,
    permission: preview.permission,
    ...(outputContract === undefined ? {} : { outputSchemaDigest: outputContract.digest }),
    requiredChecks: preview.requiredChecks,
  };
  return { args: effectiveArgs, preset, provider, limits, outputContract, permission, resolvedMode, preview, snapshot };
}
