import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { CONFIG_DIRECTORY } from './config-file.js';
import { dataRoot } from '../data-root.js';
import { createOutputSchemaContract } from '../delegation.js';
import type { PermissionNetwork, PermissionProfile } from './permission.js';
import { KernelError } from './error.js';

export type AgentPresetLayer = 'shipped' | 'user' | 'project';

export interface AgentPresetDirectories {
  readonly shipped: string;
  readonly user: string;
  readonly project: string;
  readonly projectRoot?: string;
}

export type AgentPresetMode = string | {
  readonly type: 'inline';
  readonly tools: readonly string[] | '*';
  readonly prompt: readonly string[] | '*';
};

export interface AgentPreset {
  readonly id: string;
  readonly layer: AgentPresetLayer;
  readonly digest: string;
  readonly description: string;
  readonly instruction: string;
  readonly mode: AgentPresetMode;
  readonly permissionProfile?: PermissionProfile;
  readonly network?: PermissionNetwork;
  readonly outputTokens?: number;
  readonly thinkingEffort?: 'none' | 'low' | 'high' | 'max';
  readonly loopIterations?: number;
  readonly modelCalls?: number;
  readonly outputSchema?: Record<string, unknown>;
  readonly requiredChecks?: readonly string[];
}

export interface AgentPresetSummary {
  readonly id: string;
  readonly layer: AgentPresetLayer;
  readonly description?: string;
  readonly digest?: string;
  readonly errorCode?: string;
}

export interface AgentPresetPage {
  readonly presets: readonly AgentPresetSummary[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_DEFINITIONS_PER_LAYER = 128;
const MAX_PAGE_SIZE = 64;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_INSTRUCTION_BYTES = 8 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_REQUIRED_CHECKS = 8;
const PRESET_FIELDS = [
  'schemaVersion', 'description', 'instruction', 'mode', 'permissionProfile', 'network',
  'outputTokens', 'thinkingEffort', 'loopIterations', 'modelCalls', 'outputSchema', 'requiredChecks',
] as const;
const PROFILE_VALUES: readonly PermissionProfile[] = ['read-only', 'workspace-write', 'full-access'];
const NETWORK_VALUES: readonly PermissionNetwork[] = ['policy', 'unrestricted', 'disabled'];
const THINKING_VALUES = ['none', 'low', 'high', 'max'] as const;

export function agentPresetDirectories(projectRoot: string, shippedDirectory: string, userDataRoot = dataRoot()): AgentPresetDirectories {
  if (typeof projectRoot !== 'string' || projectRoot === '' || !isAbsolute(projectRoot)) {
    throw new KernelError('agent_preset_project_root_required');
  }
  if (typeof shippedDirectory !== 'string' || shippedDirectory === '' || !isAbsolute(shippedDirectory)) {
    throw new KernelError('agent_preset_shipped_root_required');
  }
  return {
    shipped: shippedDirectory,
    user: join(userDataRoot, 'agents'),
    project: join(projectRoot, CONFIG_DIRECTORY, 'agents'),
    projectRoot: resolve(projectRoot),
  };
}

function checkedId(id: string): string {
  if (typeof id !== 'string' || id.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new KernelError('agent_preset_name_invalid');
  }
  return id;
}

function fail(code: string, detail: string): never {
  throw new KernelError(code, { detail: detail.slice(0, 256) });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum) {
    return fail('agent_preset_field_invalid', `${field} must be a non-empty string within its byte limit`);
  }
  return value;
}

function countField(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail('agent_preset_field_invalid', `${field} must be a positive integer`);
  return value as number;
}

function names(value: unknown, field: string): readonly string[] | '*' {
  if (value === '*') return '*';
  if (!Array.isArray(value) || value.length > 128) return fail('agent_preset_mode_invalid', `${field} must be * or a list of at most 128 names`);
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) {
      return fail('agent_preset_mode_invalid', `${field} contains an invalid name`);
    }
    if (output.includes(item)) return fail('agent_preset_mode_invalid', `${field} contains a duplicate name`);
    output.push(item);
  }
  return output;
}

function modeField(value: unknown): AgentPresetMode {
  if (typeof value === 'string') {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) return fail('agent_preset_mode_invalid', 'mode name is invalid');
    return value;
  }
  if (!object(value)) return fail('agent_preset_mode_invalid', 'mode must be a name or an inline mode table');
  for (const key of Object.keys(value)) {
    if (key !== 'tools' && key !== 'prompt') return fail('agent_preset_mode_invalid', `mode field ${key} is not supported`);
  }
  if (!Object.hasOwn(value, 'tools') || !Object.hasOwn(value, 'prompt')) {
    return fail('agent_preset_mode_invalid', 'inline mode requires tools and prompt');
  }
  return { type: 'inline', tools: names(value.tools, 'tools'), prompt: names(value.prompt, 'prompt') };
}

function schemaField(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) return fail('agent_preset_schema_invalid', 'outputSchema must be an object');
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { return fail('agent_preset_schema_invalid', 'outputSchema is not a supported JSON value'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCHEMA_BYTES) return fail('agent_preset_schema_too_large', 'outputSchema exceeds 32 KiB');
  try { createOutputSchemaContract(value); }
  catch { return fail('agent_preset_schema_invalid', 'outputSchema is not in the supported schema subset'); }
  return structuredClone(value);
}

function requiredChecksField(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REQUIRED_CHECKS) {
    return fail('agent_preset_checks_invalid', 'requiredChecks must contain at most eight check names');
  }
  const checks: string[] = [];
  for (const name of value) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) {
      return fail('agent_preset_checks_invalid', 'requiredChecks contains an invalid check name');
    }
    if (checks.includes(name)) return fail('agent_preset_checks_invalid', 'requiredChecks contains a duplicate check name');
    checks.push(name);
  }
  return checks;
}

function parseDefinition(id: string, layer: AgentPresetLayer, source: string): AgentPreset {
  let document: unknown;
  try { document = parse(source); }
  catch (error) { throw new KernelError('agent_preset_file_invalid', { cause: error, detail: 'preset TOML is invalid' }); }
  if (!object(document)) return fail('agent_preset_file_invalid', 'preset TOML must contain a table');
  for (const key of Object.keys(document)) {
    if (!(PRESET_FIELDS as readonly string[]).includes(key)) return fail('agent_preset_field_unknown', `unsupported field ${key}`);
  }
  if (document.schemaVersion !== 1) return fail('agent_preset_schema_version_invalid', 'schemaVersion must be 1');
  for (const key of ['description', 'instruction', 'mode']) {
    if (!Object.hasOwn(document, key)) return fail('agent_preset_field_missing', `${key} is required`);
  }
  const description = textField(document.description, 'description', MAX_DESCRIPTION_BYTES);
  const instruction = textField(document.instruction, 'instruction', MAX_INSTRUCTION_BYTES);
  const mode = modeField(document.mode);
  if (document.permissionProfile !== undefined && !PROFILE_VALUES.includes(document.permissionProfile as PermissionProfile)) {
    return fail('agent_preset_field_invalid', 'permissionProfile is unsupported');
  }
  if (document.network !== undefined && !NETWORK_VALUES.includes(document.network as PermissionNetwork)) {
    return fail('agent_preset_field_invalid', 'network is unsupported');
  }
  if (document.thinkingEffort !== undefined && !(THINKING_VALUES as readonly unknown[]).includes(document.thinkingEffort)) {
    return fail('agent_preset_field_invalid', 'thinkingEffort is unsupported');
  }
  const outputTokens = countField(document.outputTokens, 'outputTokens');
  const loopIterations = countField(document.loopIterations, 'loopIterations');
  const modelCalls = countField(document.modelCalls, 'modelCalls');
  const outputSchema = schemaField(document.outputSchema);
  const requiredChecks = requiredChecksField(document.requiredChecks);
  const normalized = {
    schemaVersion: 1,
    description,
    instruction,
    mode,
    ...(document.permissionProfile === undefined ? {} : { permissionProfile: document.permissionProfile }),
    ...(document.network === undefined ? {} : { network: document.network }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(document.thinkingEffort === undefined ? {} : { thinkingEffort: document.thinkingEffort }),
    ...(loopIterations === undefined ? {} : { loopIterations }),
    ...(modelCalls === undefined ? {} : { modelCalls }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(requiredChecks === undefined ? {} : { requiredChecks }),
  };
  const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return Object.freeze({
    id, layer, digest, description, instruction, mode,
    ...(document.permissionProfile === undefined ? {} : { permissionProfile: document.permissionProfile as PermissionProfile }),
    ...(document.network === undefined ? {} : { network: document.network as PermissionNetwork }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(document.thinkingEffort === undefined ? {} : { thinkingEffort: document.thinkingEffort as AgentPreset['thinkingEffort'] }),
    ...(loopIterations === undefined ? {} : { loopIterations }),
    ...(modelCalls === undefined ? {} : { modelCalls }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(requiredChecks === undefined ? {} : { requiredChecks }),
  });
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function safeLayerDirectory(directory: string, layer: AgentPresetLayer, directories: AgentPresetDirectories): Promise<string> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('agent_preset_path_invalid', 'preset layer must be a normal directory');
  const canonicalDirectory = await realpath(directory);
  if (layer === 'project' && directories.projectRoot !== undefined) {
    const canonicalProject = await realpath(directories.projectRoot);
    if (!within(canonicalProject, canonicalDirectory)) fail('agent_preset_path_invalid', 'project preset layer escapes the project root');
  }
  return canonicalDirectory;
}

async function readDefinition(id: string, directories: AgentPresetDirectories): Promise<{ layer: AgentPresetLayer; source: string }> {
  const candidates: readonly { layer: AgentPresetLayer; directory: string }[] = [
    { layer: 'project', directory: directories.project },
    { layer: 'user', directory: directories.user },
    { layer: 'shipped', directory: directories.shipped },
  ];
  for (const candidate of candidates) {
    let info;
    try { info = await lstat(join(candidate.directory, `${id}.toml`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') fail('agent_preset_path_invalid', 'preset path is not a directory');
      throw new KernelError('agent_preset_file_read_failed', { cause: error, detail: 'preset file could not be inspected' });
    }
    if (!info.isFile() || info.isSymbolicLink()) fail('agent_preset_path_invalid', 'preset must be a regular file');
    const directory = await safeLayerDirectory(candidate.directory, candidate.layer, directories);
    const path = join(candidate.directory, `${id}.toml`);
    const canonicalFile = await realpath(path);
    if (dirname(canonicalFile) !== directory) fail('agent_preset_path_invalid', 'preset file escapes its layer directory');
    if (info.size > MAX_DEFINITION_BYTES) fail('agent_preset_too_large', 'preset definition exceeds 64 KiB');
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) { throw new KernelError('agent_preset_file_read_failed', { cause: error, detail: 'preset file could not be read' }); }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) {
      fail('agent_preset_path_invalid', 'preset file changed while it was being read');
    }
    if (bytes.byteLength > MAX_DEFINITION_BYTES) fail('agent_preset_too_large', 'preset definition exceeds 64 KiB');
    return { layer: candidate.layer, source: bytes.toString('utf8') };
  }
  throw new KernelError('agent_preset_unknown');
}

export async function loadAgentPreset(id: string, directories: AgentPresetDirectories): Promise<AgentPreset> {
  const checked = checkedId(id);
  const { layer, source } = await readDefinition(checked, directories);
  return parseDefinition(checked, layer, source);
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new KernelError('agent_preset_cursor_invalid');
  let decoded: string;
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); }
  catch { throw new KernelError('agent_preset_cursor_invalid'); }
  if (!/^v1:[a-z0-9][a-z0-9._-]{0,63}$/u.test(decoded)) throw new KernelError('agent_preset_cursor_invalid');
  return decoded.slice(3);
}

export async function listAgentPresets(
  directories: AgentPresetDirectories,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<AgentPresetPage> {
  const limit = options.limit ?? MAX_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new KernelError('agent_preset_page_limit_invalid');
  const after = decodeCursor(options.cursor);
  const selected = new Map<string, AgentPresetLayer>();
  let truncated = false;
  for (const layer of ['project', 'user', 'shipped'] as const) {
    let entries;
    try { entries = await readdir(directories[layer], { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new KernelError('agent_preset_path_invalid');
      throw new KernelError('agent_preset_directory_read_failed', { cause: error, detail: 'preset directory could not be read' });
    }
    const files = entries.filter(entry => entry.name.endsWith('.toml')).map(entry => entry.name.slice(0, -5)).sort();
    if (files.length > MAX_DEFINITIONS_PER_LAYER) truncated = true;
    for (const id of files.slice(0, MAX_DEFINITIONS_PER_LAYER)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id) || selected.has(id)) continue;
      selected.set(id, layer);
    }
  }
  const ids = [...selected.keys()].sort().filter(id => after === undefined || id > after);
  const pageIds = ids.slice(0, limit);
  const presets: AgentPresetSummary[] = [];
  for (const id of pageIds) {
    const layer = selected.get(id)!;
    try {
      const preset = await loadAgentPreset(id, directories);
      presets.push({ id, layer: preset.layer, description: preset.description, digest: preset.digest });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        && /^agent_preset_[a-z0-9_]{1,72}$/u.test(error.code) ? error.code : 'agent_preset_invalid';
      presets.push({ id, layer, errorCode: code });
    }
  }
  const hasMore = ids.length > pageIds.length;
  const last = pageIds.at(-1);
  return {
    presets,
    ...(hasMore && last !== undefined ? { nextCursor: Buffer.from(`v1:${last}`).toString('base64url') } : {}),
    truncated: truncated || hasMore,
  };
}
