// 用户在数据根 tools/ 目录放置的声明式工具：每个 TOML 文件描述一个命令工具。
// 模型只提供参数；命令与参数模式由文件声明，执行复用 exec 工具的完整权限与审批链路。
// 占位符只允许独占一个参数位，避免把模型输入拼进 shell 语法。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { KernelError } from '../kernel/error.js';
import { assertSupportedSchema } from '../kernel/schema.js';
import { execTool } from '../capability/exec.js';
import type { ExecRunContext } from '../capability/exec.js';
import type { ShellKind } from '../capability/shell.js';
import type { ToolDefinition } from '../kernel/kernel.js';

export interface CustomToolDiagnostic {
  code: string;
  path: string;
  detail: string;
}

export interface CustomToolSpec {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly parameters: Record<string, unknown>;
}

const CUSTOM_NAME = /^[a-z][a-z0-9-]*$/u;
const PLACEHOLDER = /^\{([a-zA-Z][a-zA-Z0-9_]*)\}$/u;
const SPEC_FIELDS = ['name', 'description', 'command', 'args', 'cwd', 'parameters'] as const;

// 按 Kernel 选定的 Shell 种类为每个参数位加引号；命令行再交回 exec 解析与判定。
// PowerShell 会把带引号的首个词当作字符串而不是命令，因此只有含特殊字符的词才加引号。
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

function quote(kind: ShellKind, token: string): string {
  if (SAFE_TOKEN.test(token)) return token;
  if (kind === 'powershell') return `"${token.replace(/"/gu, '""')}"`;
  return `'${token.replace(/'/gu, `'\\''`)}'`;
}

// 占位符替换为独立的参数位；可选参数缺省时整位省略。
function resolveArgv(argv: readonly string[], args: Record<string, unknown>): string[] {
  const resolved: string[] = [];
  for (const token of argv) {
    const placeholder = PLACEHOLDER.exec(token);
    if (placeholder === null) {
      resolved.push(token);
      continue;
    }
    const value = args[placeholder[1]];
    if (value === undefined) continue;
    if (typeof value === 'string') resolved.push(value);
    else if (typeof value === 'number' && Number.isFinite(value)) resolved.push(String(value));
    else if (typeof value === 'boolean') resolved.push(String(value));
    else throw new KernelError('custom_tool_args_invalid', { detail: `{${placeholder[1]}} takes a string, number, or boolean` });
  }
  return resolved;
}

function specPropertyNames(parameters: Record<string, unknown>): Set<string> {
  const properties = parameters.properties;
  if (properties === undefined || typeof properties !== 'object' || properties === null || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}

/** 校验一个工具文件；无效文件不注册，错误以诊断形式报告。 */
export function checkedCustomToolSpec(parsed: unknown, file: string): CustomToolSpec {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KernelError('custom_tool_invalid', { detail: 'a tool file is a TOML table' });
  }
  const given = parsed as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(SPEC_FIELDS as readonly string[]).includes(key)) {
      throw new KernelError('custom_tool_invalid', { detail: `${key} is not one of: ${SPEC_FIELDS.join(', ')}` });
    }
  }
  const stem = file.replace(/\.toml$/u, '');
  const name = given.name === undefined ? stem : given.name;
  if (typeof name !== 'string' || !CUSTOM_NAME.test(name) || name.length > 48) {
    throw new KernelError('custom_tool_invalid', { detail: 'name takes lowercase letters, digits and hyphens, starting with a letter' });
  }
  const description = given.description;
  if (typeof description !== 'string' || description.trim() === '') {
    throw new KernelError('custom_tool_invalid', { detail: 'description is required so the model knows when to call the tool' });
  }
  const command = given.command;
  if (typeof command !== 'string' || command.trim() === '' || /\s/u.test(command)) {
    throw new KernelError('custom_tool_invalid', { detail: 'command takes a single executable path without arguments; put its arguments in args' });
  }
  const args = given.args ?? [];
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || item === '')) {
    throw new KernelError('custom_tool_invalid', { detail: 'args takes an array of non-empty strings' });
  }
  const cwd = given.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
    throw new KernelError('custom_tool_invalid', { detail: 'cwd takes a non-empty path relative to the workspace root' });
  }
  const parameters = given.parameters === undefined
    ? { type: 'object' }
    : given.parameters as Record<string, unknown>;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new KernelError('custom_tool_invalid', { detail: 'parameters takes a JSON schema object' });
  }
  if (parameters.type !== undefined && parameters.type !== 'object') {
    throw new KernelError('custom_tool_invalid', { detail: 'parameters.type must be object' });
  }
  const schema = { type: 'object', ...parameters };
  try {
    assertSupportedSchema(schema);
  } catch (cause) {
    throw new KernelError('custom_tool_invalid', { cause, detail: `parameters must stay in the supported schema subset: ${(cause as Error).message}` });
  }
  const declared = specPropertyNames(schema);
  for (const token of args as string[]) {
    const placeholder = PLACEHOLDER.exec(token);
    if (placeholder === null) {
      if (token.includes('{') || token.includes('}')) {
        throw new KernelError('custom_tool_invalid', { detail: `placeholders replace a whole entry of args; "${token}" only partially looks like one` });
      }
      continue;
    }
    if (!declared.has(placeholder[1])) {
      throw new KernelError('custom_tool_invalid', { detail: `{${placeholder[1]}} is not declared in parameters.properties` });
    }
  }
  return {
    name,
    description,
    command,
    args: args as string[],
    ...(cwd === undefined ? {} : { cwd }),
    parameters: schema,
  };
}

function buildCustomTool(spec: CustomToolSpec): ToolDefinition {
  return {
    name: spec.name,
    // 执行、权限与审批都按 exec 能力判定；声明一个工具不授予任何额外权限。
    access: 'exec',
    capability: () => 'exec',
    description: spec.description,
    parameters: spec.parameters,
    async run(args: Record<string, unknown>, context: ExecRunContext) {
      if (context.shell === undefined) {
        throw new KernelError('exec_shell_unavailable', { detail: 'the host did not select a shell backend for exec' });
      }
      const argv = resolveArgv(spec.args, args);
      const command = [spec.command, ...argv].map((token) => quote(context.shell!.kind, token)).join(' ');
      return execTool.run({ command, ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }) }, context);
    },
  } as ToolDefinition;
}

/** 发现数据根 tools/ 目录下的声明式工具；目录不存在时返回空表。 */
export async function discoverCustomTools(directory: string): Promise<{ tools: ToolDefinition[]; diagnostics: CustomToolDiagnostic[] }> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tools: [], diagnostics: [] };
    return {
      tools: [],
      diagnostics: [{ code: 'custom_tools_read_failed', path: directory, detail: (error as Error).message }],
    };
  }
  const tools: ToolDefinition[] = [];
  const diagnostics: CustomToolDiagnostic[] = [];
  const taken = new Set<string>();
  for (const file of files.sort()) {
    if (!file.endsWith('.toml')) continue;
    const path = join(directory, file);
    try {
      const spec = checkedCustomToolSpec(parse(await readFile(path, 'utf8')), file);
      if (taken.has(spec.name)) {
        diagnostics.push({ code: 'custom_tool_name_taken', path, detail: `${spec.name} is already declared by another file` });
        continue;
      }
      taken.add(spec.name);
      tools.push(buildCustomTool(spec));
    } catch (error) {
      const detail = typeof (error as { detail?: unknown }).detail === 'string' && (error as { detail: string }).detail !== ''
        ? (error as { detail: string }).detail
        : error instanceof Error ? error.message : String(error);
      diagnostics.push({
        code: error instanceof KernelError ? error.code : 'custom_tool_invalid',
        path,
        detail,
      });
    }
  }
  return { tools, diagnostics };
}

export function createCustomToolsPlugin(tools: readonly ToolDefinition[]) {
  return {
    name: 'ligule-custom-tools',
    setup(kernel: { register(tool: ToolDefinition): () => void }) {
      const disposers = tools.map((tool) => kernel.register(tool));
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    },
  };
}
