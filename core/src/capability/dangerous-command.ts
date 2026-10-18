import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import {
  inspectCommand,
  type CommandInspection,
  type ParsedCommandArgument,
  type ParsedCommandInvocation,
} from './command.js';
import type { ShellKind } from './shell.js';

export interface DangerousCommandMatch {
  readonly kind: 'hard-deny' | 'approval';
  readonly reason: string;
}

const DELETE_ROOT_REASON = 'recursive deletion of a filesystem root or user home is prohibited';
const DELETE_SCOPE_REASON = 'deleting files requires per-call approval';
const PROCESS_SWEEP_REASON = 'terminating all or a broad class of processes is prohibited';
const PROCESS_TARGET_REASON = 'stopping a process requires per-call approval because process ownership is unknown';
const WRAPPER_REASON = 'this command wrapper cannot be completely inspected and requires per-call approval';

type DirectoryKind = 'workspace' | 'absolute' | 'unknown';

interface DirectoryState {
  kind: DirectoryKind;
  path?: string;
  workspaceParts: string[];
}

interface DirectoryTracker {
  current: DirectoryState;
  stack: DirectoryState[];
}

type Risk = DangerousCommandMatch | undefined;

function executableName(token: string): string {
  const basename = token.replaceAll('\\', '/').split('/').at(-1) ?? token;
  return basename.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '');
}

function normalizedPath(value: string): string {
  const path = value.replaceAll('\\', '/').toLowerCase().replace(/\/{2,}/gu, '/');
  return path === '/' || /^[a-z]:\/$/u.test(path) ? path : path.replace(/\/+$/u, '');
}

function homeDirectory(): string {
  return normalizedPath(homedir());
}

function isHomeOrRootPath(value: string): boolean {
  const path = normalizedPath(value);
  return path === '/'
    || path === '/home'
    || /^\/home\/[^/]+$/u.test(path)
    || path === '/root'
    || path === homeDirectory()
    || /^[a-z]:\/$/u.test(path)
    || /^([a-z]:\/users)(?:\/[^/]+)?$/u.test(path);
}

function isHomeOrRootArgument(argument: ParsedCommandArgument, shell: ShellKind): boolean {
  const value = argument.value;
  if (value === undefined) return false;
  const path = normalizedPath(value);
  if (isHomeOrRootPath(path)) return true;
  if (argument.dynamic && ['$home', '${home}', '$env:userprofile'].includes(path)) return true;
  if ((argument.tildeExpansion || shell === 'powershell') && path === '~') return true;
  const separator = path.lastIndexOf('/');
  const parent = separator < 0 ? '' : separator === 0 ? '/'
    : separator === 2 && /^[a-z]:$/u.test(path.slice(0, separator)) ? `${path.slice(0, separator)}/`
      : path.slice(0, separator);
  const base = separator < 0 ? path : path.slice(separator + 1);
  if (!/[*?[]/u.test(base)) return false;
  return isHomeOrRootBase(parent, argument, shell);
}

function isHomeOrRootBase(value: string, argument: ParsedCommandArgument, shell: ShellKind): boolean {
  const path = normalizedPath(value);
  if (isHomeOrRootPath(path)) return true;
  if (argument.dynamic && ['$home', '${home}', '$env:userprofile'].includes(path)) return true;
  return (argument.tildeExpansion || shell === 'powershell') && path === '~';
}

function isBroadRootGlob(argument: ParsedCommandArgument, shell: ShellKind): boolean {
  const value = argument.value;
  if (value === undefined) return false;
  const path = normalizedPath(value);
  const separator = path.lastIndexOf('/');
  const parent = separator < 0 ? '' : separator === 0 ? '/'
    : separator === 2 && /^[a-z]:$/u.test(path.slice(0, separator)) ? `${path.slice(0, separator)}/`
      : path.slice(0, separator);
  const base = separator < 0 ? path : path.slice(separator + 1);
  if (!/[*?[]/u.test(base)) return false;
  return isHomeOrRootBase(parent, argument, shell);
}

function isCurrentDirectoryTarget(argument: ParsedCommandArgument): boolean {
  const value = argument.value;
  if (value === undefined) return false;
  const path = normalizedPath(value);
  return path === '.' || path === './'
    || path === '*' || path === './*'
    || path === '.*' || path === './.*';
}

function directoryIsHomeOrRoot(state: DirectoryState): boolean {
  return state.kind === 'absolute' && state.path !== undefined && isHomeOrRootPath(state.path);
}

function cloneDirectory(state: DirectoryState): DirectoryState {
  return { ...state, workspaceParts: [...state.workspaceParts] };
}

function initialDirectory(relativeCwd?: string): DirectoryTracker {
  if (relativeCwd === undefined || relativeCwd.trim() === '' || relativeCwd === '.') {
    return { current: { kind: 'workspace', workspaceParts: [] }, stack: [] };
  }
  const path = relativeCwd.replaceAll('\\', '/');
  const normalized = posix.normalize(path);
  if (isAbsolutePath(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return { current: { kind: 'unknown', workspaceParts: [] }, stack: [] };
  }
  return {
    current: { kind: 'workspace', workspaceParts: normalized === '.' ? [] : normalized.split('/').filter(Boolean) },
    stack: [],
  };
}

function isAbsolutePath(path: string): boolean {
  const normalized = normalizedPath(path);
  return normalized.startsWith('/') || /^[a-z]:\//u.test(normalized);
}

function expandHomePrefix(argument: ParsedCommandArgument, shell: ShellKind): string | undefined {
  const value = argument.value;
  if (value === undefined) return undefined;
  const path = normalizedPath(value);
  const home = homeDirectory();
  if (argument.dynamic && (path === '$home' || path.startsWith('$home/'))) return `${home}${path.slice('$home'.length)}`;
  if (argument.dynamic && (path === '${home}' || path.startsWith('${home}/'))) return `${home}${path.slice('${home}'.length)}`;
  if (argument.dynamic && (path === '$env:userprofile' || path.startsWith('$env:userprofile/'))) {
    return `${home}${path.slice('$env:userprofile'.length)}`;
  }
  if ((argument.tildeExpansion || shell === 'powershell') && (path === '~' || path.startsWith('~/'))) {
    return `${home}${path.slice(1)}`;
  }
  return undefined;
}

function resolveDirectory(argument: ParsedCommandArgument, shell: ShellKind, current: DirectoryState): DirectoryState {
  const value = argument.value;
  if (value === undefined || argument.nested.length > 0) return { kind: 'unknown', workspaceParts: [] };
  const path = normalizedPath(value);
  const expandedHome = expandHomePrefix(argument, shell);
  if (expandedHome !== undefined) {
    const normalized = normalizedPath(expandedHome);
    return { kind: 'absolute', path: normalized, workspaceParts: [] };
  }
  if (isAbsolutePath(path)) return { kind: 'absolute', path, workspaceParts: [] };

  if (current.kind === 'absolute' && current.path !== undefined) {
    const windowsPath = /^[a-z]:\//u.test(current.path);
    const pathApi = windowsPath ? win32 : posix;
    const resolved = normalizedPath(pathApi.resolve(current.path, value));
    return { kind: 'absolute', path: resolved, workspaceParts: [] };
  }
  if (current.kind === 'workspace') {
    const joined = posix.normalize(`/workspace/${[...current.workspaceParts, path].join('/')}`);
    if (joined !== '/workspace' && !joined.startsWith('/workspace/')) return { kind: 'unknown', workspaceParts: [] };
    const relative = joined.slice('/workspace'.length).replace(/^\//u, '');
    return { kind: 'workspace', workspaceParts: relative === '' ? [] : relative.split('/') };
  }
  return { kind: 'unknown', workspaceParts: [] };
}

function optionValue(argument: ParsedCommandArgument): string | undefined {
  return argument.value?.toLowerCase();
}

function positionalArguments(invocation: ParsedCommandInvocation, shell: ShellKind): ParsedCommandArgument[] {
  if (shell !== 'powershell') return invocation.arguments.filter((argument) => argument.value !== '--');
  const result: ParsedCommandArgument[] = [];
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index];
    const value = optionValue(argument);
    if (value === '-path' || value === '-literalpath' || value === '-destination' || value === '-literaldestination') {
      const next = invocation.arguments[index + 1];
      if (next !== undefined) result.push(next);
      index += 1;
      continue;
    }
    if (value?.startsWith('-path:') === true || value?.startsWith('-literalpath:') === true) {
      const colon = argument.value?.indexOf(':') ?? -1;
      if (colon >= 0) result.push({ ...argument, value: argument.value?.slice(colon + 1) });
      continue;
    }
    if (argument.value !== undefined && !argument.value.startsWith('-')) result.push(argument);
  }
  return result;
}

function recursiveFlag(invocation: ParsedCommandInvocation, shell: ShellKind): boolean {
  return invocation.arguments.some((argument) => {
    const value = optionValue(argument);
    if (value === undefined) return false;
    if (shell === 'powershell') return value === '-recurse' || value === '-recursive' || value === '-r';
    return value === '--recursive' || (/^-[^-]+$/u.test(value) && value.slice(1).includes('r'));
  });
}

function isPythonOrHttpServer(value: string): boolean {
  const pattern = value.toLowerCase();
  return /(^|[^a-z0-9_])python(?:w)?(?:\d+(?:\.\d+)*)?(?:\.exe)?($|[^a-z0-9_])/u.test(pattern)
    || pattern.includes('http.server')
    || pattern.includes('http-server');
}

function isCatchAllProcessPattern(value: string): boolean {
  return ['*', '.', '.*', '.+', '^', '$', '^.*$', '^.+$', '.*?'].includes(value.trim().toLowerCase());
}

function deleteRisk(
  invocation: ParsedCommandInvocation,
  shell: ShellKind,
  current: DirectoryState,
): Risk {
  const name = executableName(invocation.executable);
  const args = invocation.arguments;
  if (name === 'find' && args.some((argument) => argument.value?.toLowerCase() === '-delete')) {
    const target = args.find((argument) => argument.value !== undefined && !argument.value.startsWith('-'));
    if (target !== undefined && (isHomeOrRootArgument(target, shell) || isBroadRootGlob(target, shell))) {
      return { kind: 'hard-deny', reason: DELETE_ROOT_REASON };
    }
    if (target !== undefined && isCurrentDirectoryTarget(target) && directoryIsHomeOrRoot(current)) {
      return { kind: 'hard-deny', reason: DELETE_ROOT_REASON };
    }
    return { kind: 'approval', reason: DELETE_SCOPE_REASON };
  }

  const powershellRemoval = shell === 'powershell'
    && ['remove-item', 'rm', 'ri', 'del', 'erase', 'rmdir', 'rd'].includes(name);
  const posixRemoval = shell === 'bash' && ['rm', 'unlink', 'rmdir'].includes(name);
  if (!powershellRemoval && !posixRemoval) return undefined;

  const targets = positionalArguments(invocation, shell);
  if (targets.length === 0) return undefined;
  const recursive = recursiveFlag(invocation, shell);
  if (recursive && targets.some((target) => isHomeOrRootArgument(target, shell) || isBroadRootGlob(target, shell))) {
    return { kind: 'hard-deny', reason: DELETE_ROOT_REASON };
  }
  if (recursive && targets.some(isCurrentDirectoryTarget) && directoryIsHomeOrRoot(current)) {
    return { kind: 'hard-deny', reason: DELETE_ROOT_REASON };
  }
  return { kind: 'approval', reason: DELETE_SCOPE_REASON };
}

function parameterArguments(invocation: ParsedCommandInvocation): Map<string, ParsedCommandArgument[]> {
  const result = new Map<string, ParsedCommandArgument[]>();
  const args = invocation.arguments;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value;
    if (value === undefined || !value.startsWith('-')) continue;
    const colon = value.indexOf(':');
    const key = (colon < 0 ? value : value.slice(0, colon)).toLowerCase();
    const inline = colon < 0 ? undefined : { ...args[index], value: value.slice(colon + 1) };
    const values = result.get(key) ?? [];
    if (inline !== undefined) values.push(inline);
    else if (args[index + 1] !== undefined && !args[index + 1]?.value?.startsWith('-')) values.push(args[index + 1]!);
    result.set(key, values);
  }
  return result;
}

function processRisk(invocation: ParsedCommandInvocation, shell: ShellKind): Risk {
  const name = executableName(invocation.executable);
  const args = invocation.arguments.map((argument) => argument.value?.toLowerCase() ?? '');
  if (name === 'kill') {
    let signalIsZero = false;
    let sawSignal = false;
    let afterOptions = false;
    const targets: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index] ?? '';
      if (!afterOptions && value === '--') {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && (value === '-s' || value === '--signal' || value === '-n')) {
        const signal = args[index + 1] ?? '';
        signalIsZero = signal === '0' || signal === 'sigzero';
        sawSignal = true;
        index += 1;
        continue;
      }
      if (!afterOptions && /^-[a-z0-9]+$/u.test(value) && !sawSignal) {
        signalIsZero = value === '-0';
        sawSignal = true;
        continue;
      }
      if (value !== '') targets.push(value);
    }
    if (signalIsZero) return undefined;
    if (targets.some((target) => target === '0' || /^-\d+$/u.test(target))) {
      return { kind: 'hard-deny', reason: PROCESS_SWEEP_REASON };
    }
    return targets.length > 0 ? { kind: 'approval', reason: PROCESS_TARGET_REASON } : undefined;
  }

  if (['pkill', 'killall'].includes(name)) {
    if (args.some(isPythonOrHttpServer)) return { kind: 'hard-deny', reason: PROCESS_SWEEP_REASON };
    const patternIndex = args.findIndex((value) => value === '-f' || value === '--full' || value === '-name' || value === '-processname');
    const patterns = patternIndex < 0 ? args : args.slice(patternIndex + 1);
    if (patterns.some(isCatchAllProcessPattern)) return { kind: 'hard-deny', reason: PROCESS_SWEEP_REASON };
    return { kind: 'approval', reason: PROCESS_TARGET_REASON };
  }

  if (shell === 'powershell' && ['stop-process', 'spps'].includes(name)) {
    const params = parameterArguments(invocation);
    const named = params.get('-name') ?? params.get('-processname') ?? [];
    const ids = params.get('-id') ?? [];
    if (named.some((argument) => argument.value !== undefined && (isPythonOrHttpServer(argument.value) || isCatchAllProcessPattern(argument.value)))) {
      return { kind: 'hard-deny', reason: PROCESS_SWEEP_REASON };
    }
    if (named.length > 0 || ids.length > 0 || params.has('-inputobject')) {
      return { kind: 'approval', reason: PROCESS_TARGET_REASON };
    }
    return { kind: 'approval', reason: PROCESS_TARGET_REASON };
  }

  if (name === 'taskkill') {
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const target = args[index + 1] ?? '';
      if ((flag === '/im' || flag === '-im') && (isPythonOrHttpServer(target) || isCatchAllProcessPattern(target))) {
        return { kind: 'hard-deny', reason: PROCESS_SWEEP_REASON };
      }
      if (flag === '/pid' || flag === '-pid') return { kind: 'approval', reason: PROCESS_TARGET_REASON };
    }
    return { kind: 'approval', reason: PROCESS_TARGET_REASON };
  }

  return undefined;
}

function cwdCommand(invocation: ParsedCommandInvocation, shell: ShellKind): { kind: 'change'; target?: ParsedCommandArgument; push?: boolean } | { kind: 'pop' } | undefined {
  const name = executableName(invocation.executable);
  if (['popd', 'pop-location'].includes(name)) return { kind: 'pop' };
  if (!['cd', 'chdir', 'pushd', 'push-location', 'set-location', 'sl'].includes(name)) return undefined;
  const push = name === 'pushd' || name === 'push-location';
  const args = invocation.arguments;
  if (shell === 'powershell') {
    for (let index = 0; index < args.length; index += 1) {
      const value = optionValue(args[index]!) ?? '';
      if (value === '-path' || value === '-literalpath') return { kind: 'change', target: args[index + 1], push };
      if (value.startsWith('-path:') || value.startsWith('-literalpath:')) {
        const colon = args[index]?.value?.indexOf(':') ?? -1;
        return { kind: 'change', target: colon < 0 ? undefined : { ...args[index]!, value: args[index]?.value?.slice(colon + 1) }, push };
      }
    }
  }
  const target = args.find((argument) => argument.value !== undefined && argument.value !== '--' && !argument.value.startsWith('-'));
  return { kind: 'change', target: target ?? (shell === 'bash' ? {
    source: '', value: '~', dynamic: false, tildeExpansion: true, nested: [],
  } : undefined), push };
}

function updateDirectory(invocation: ParsedCommandInvocation, shell: ShellKind, tracker: DirectoryTracker): void {
  const command = cwdCommand(invocation, shell);
  if (command === undefined) return;
  if (command.kind === 'pop') {
    tracker.current = tracker.stack.pop() ?? { kind: 'unknown', workspaceParts: [] };
    return;
  }
  const target = command.target;
  if (target === undefined) {
    tracker.current = { kind: 'unknown', workspaceParts: [] };
    return;
  }
  if (command.push === true) tracker.stack.push(cloneDirectory(tracker.current));
  tracker.current = resolveDirectory(target, shell, tracker.current);
}

function hardOrApprovalDeletion(
  invocation: ParsedCommandInvocation,
  shell: ShellKind,
  current: DirectoryState,
): Risk {
  return deleteRisk(invocation, shell, current);
}

function isScriptRunner(name: string): boolean {
  return ['npm', 'npx', 'pnpm', 'yarn', 'make', 'start-process', 'invoke-expression', 'iex', 'eval', 'xargs', 'awk', 'gawk', 'mawk', 'nawk'].includes(name);
}

const NON_EXECUTING_ARGUMENT_COMMANDS = new Set([
  'echo', 'printf', 'write-output', 'write-host', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail',
  'get-content', 'select-string', 'git', 'ls', 'dir', 'pwd', 'get-childitem', 'test', '[', 'true', 'false',
]);

function optionIndex(invocation: ParsedCommandInvocation, choices: readonly string[]): number {
  return invocation.arguments.findIndex((argument) => argument.value !== undefined && choices.includes(argument.value.toLowerCase()));
}

function findExecChildren(invocation: ParsedCommandInvocation, shell: ShellKind, current: DirectoryState): {
  readonly children: readonly ParsedCommandInvocation[];
  readonly hasExecutor: boolean;
  readonly rootSweep: boolean;
  readonly incomplete: boolean;
} | undefined {
  if (shell !== 'bash' || executableName(invocation.executable) !== 'find') return undefined;
  const args = invocation.arguments;
  const children: ParsedCommandInvocation[] = [];
  let hasExecutor = false;
  let incomplete = false;
  let rootSweep = false;
  let startIndex = 0;
  while (['-h', '-l', '-p', '-d'].includes(args[startIndex]?.value?.toLowerCase() ?? '')
    || /^-o[0-3]$/u.test(args[startIndex]?.value?.toLowerCase() ?? '')) {
    const option = args[startIndex]?.value?.toLowerCase() ?? '';
    startIndex += 1;
    if (option === '-d' && args[startIndex] !== undefined) startIndex += 1;
  }
  const candidate = args[startIndex];
  const start = candidate?.value !== undefined && !candidate.value.startsWith('-') ? candidate : undefined;
  const searchesHomeOrRoot = start === undefined
    ? directoryIsHomeOrRoot(current)
    : isHomeOrRootArgument(start, shell) || isBroadRootGlob(start, shell);

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]?.value?.toLowerCase();
    if (option !== '-exec' && option !== '-execdir') continue;
    hasExecutor = true;
    const end = args.findIndex((argument, candidate) => candidate > index
      && [';', '\\;', '+'].includes(argument.value ?? ''));
    if (end < 0 || end === index + 1) {
      incomplete = true;
      continue;
    }
    const commandArguments = args.slice(index + 1, end);
    const executable = commandArguments[0];
    if (executable?.value === undefined || executable.dynamic || executable.nested.length > 0) {
      incomplete = true;
      index = end;
      continue;
    }
    const child: ParsedCommandInvocation = {
      executable: executable.value,
      arguments: commandArguments.slice(1),
      nested: true,
      pipeline: false,
    };
    children.push(child);
    const name = executableName(child.executable);
    if (searchesHomeOrRoot && ['rm', 'unlink', 'rmdir'].includes(name)
      && child.arguments.some((argument) => argument.value === '{}')) {
      rootSweep = true;
    }
    index = end;
  }
  return { children, hasExecutor, rootSweep, incomplete };
}

function strictPowerShellDecode(encoded: string): string | undefined {
  if (encoded.length === 0 || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.toString('base64') !== encoded) return undefined;
  const command = bytes.toString('utf16le');
  if (command.includes('\0') || !Buffer.from(command, 'utf16le').equals(bytes)) return undefined;
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = command.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return undefined;
  }
  return command;
}

function findPowerShellCommandArgument(invocation: ParsedCommandInvocation): { kind: ShellKind; text: string } | Risk | undefined {
  const commandIndex = optionIndex(invocation, ['-command', '-c']);
  if (commandIndex >= 0) {
    const values = invocation.arguments.slice(commandIndex + 1);
    if (values.length === 0 || values.some((argument) => argument.value === undefined || argument.nested.length > 0)) {
      return { kind: 'approval', reason: WRAPPER_REASON };
    }
    return { kind: 'powershell', text: values.map((argument) => argument.value).join(' ') };
  }
  const encodedIndex = optionIndex(invocation, ['-encodedcommand', '-enc']);
  if (encodedIndex >= 0) {
    const encoded = invocation.arguments[encodedIndex + 1]?.value;
    const decoded = encoded === undefined ? undefined : strictPowerShellDecode(encoded);
    return decoded === undefined ? { kind: 'approval', reason: WRAPPER_REASON } : { kind: 'powershell', text: decoded };
  }
  return undefined;
}

function wrappedInvocation(invocation: ParsedCommandInvocation, shell: ShellKind): { child?: ParsedCommandInvocation; script?: { kind: ShellKind; text: string }; risk?: Risk } | undefined {
  const name = executableName(invocation.executable);
  if (['bash', 'sh', 'zsh', 'dash', 'fish'].includes(name)) {
    const commandIndex = invocation.arguments.findIndex((argument) => {
      const value = argument.value;
      return value !== undefined && /^-[a-z]*c[a-z]*$/u.test(value);
    });
    if (commandIndex < 0) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
    const command = invocation.arguments[commandIndex + 1];
    if (command?.value === undefined || command.nested.length > 0) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
    return { script: { kind: 'bash', text: command.value } };
  }
  if (name === 'pwsh' || name === 'powershell') {
    const command = findPowerShellCommandArgument(invocation);
    if (command === undefined) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
    if ('kind' in command && command.kind === 'approval') return { risk: command };
    return { script: command as { kind: ShellKind; text: string } };
  }
  if (name === 'su') {
    const commandIndex = optionIndex(invocation, ['-c', '--command']);
    if (commandIndex >= 0) {
      const command = invocation.arguments[commandIndex + 1];
      if (command?.value === undefined || command.nested.length > 0) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
      return { script: { kind: shell === 'powershell' ? 'powershell' : 'bash', text: command.value } };
    }
  }
  if (name === 'start-process') {
    const params = parameterArguments(invocation);
    const file = params.get('-filepath')?.[0]?.value ?? params.get('-workingdirectory')?.[0]?.value;
    const args = params.get('-argumentlist') ?? [];
    if (file === undefined || args.some((argument) => argument.value === undefined)) {
      return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
    }
    if (['pwsh', 'powershell'].includes(executableName(file))) {
      return { script: { kind: 'powershell', text: `${file} ${args.map((argument) => argument.value).join(' ')}` } };
    }
    return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
  }
  if (name === 'invoke-expression' || name === 'iex' || name === 'eval') {
    const parts = invocation.arguments.map((argument) => argument.value);
    if (parts.length === 0 || parts.some((part) => part === undefined)) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
    return { script: { kind: shell, text: parts.join(' ') } };
  }

  let index = 0;
  if (name === 'sudo' || name === 'doas') {
    while (invocation.arguments[index]?.value?.startsWith('-') === true) {
      const option = invocation.arguments[index]?.value?.toLowerCase();
      index += 1;
      if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-c', '--chdir'].includes(option ?? '')) index += 1;
    }
  } else if (name === 'env') {
    while (index < invocation.arguments.length) {
      const value = invocation.arguments[index]?.value ?? '';
      if (value === '--') { index += 1; break; }
      if (value === '-S' || value === '--split-string') {
        const command = invocation.arguments[index + 1];
        if (command?.value === undefined) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
        return { script: { kind: 'bash', text: command.value } };
      }
      if (['-i', '--ignore-environment', '-0', '--null'].includes(value)
        || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)
        || /^--(?:unset|chdir|argv0)=/u.test(value)) { index += 1; continue; }
      if (['-u', '--unset', '-C', '--chdir', '--argv0'].includes(value)) { index += 2; continue; }
      if (value.startsWith('-')) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
      break;
    }
  } else if (name === 'command' || name === 'exec' || name === 'nohup' || name === 'setsid') {
    if (invocation.arguments[index]?.value === '--') index += 1;
  } else if (name === 'timeout') {
    while (index < invocation.arguments.length) {
      const value = invocation.arguments[index]?.value ?? '';
      if (value === '--') { index += 1; break; }
      if (value === '-s' || value === '--signal' || value === '-k' || value === '--kill-after') { index += 2; continue; }
      if (value.startsWith('-')) { index += 1; continue; }
      index += 1;
      break;
    }
  } else if (name === 'busybox' || name === 'xargs') {
    while (invocation.arguments[index]?.value?.startsWith('-') === true) {
      const option = invocation.arguments[index]?.value;
      index += 1;
      if (['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '-t', '-x'].includes(option ?? '') && invocation.arguments[index]?.value !== undefined) index += 1;
    }
  } else {
    return undefined;
  }
  const executableArgument = invocation.arguments[index];
  if (executableArgument?.value === undefined) return { risk: { kind: 'approval', reason: WRAPPER_REASON } };
  const child: ParsedCommandInvocation = {
    executable: executableArgument.value,
    arguments: invocation.arguments.slice(index + 1),
    nested: true,
    pipeline: false,
  };
  return { child };
}

function opaqueChild(invocation: ParsedCommandInvocation): ParsedCommandInvocation | undefined {
  if (['echo', 'printf', 'write-output', 'write-host', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail',
    'get-content', 'select-string', 'git', 'ls', 'dir', 'pwd', 'get-childitem', 'test', '[', 'true', 'false']
    .includes(executableName(invocation.executable))) return undefined;
  const executable = invocation.arguments[0];
  if (executable?.value === undefined || executable.dynamic || !/^[A-Za-z0-9._/\\-]+$/u.test(executable.value)) return undefined;
  const name = executableName(executable.value);
  if (!['rm', 'unlink', 'rmdir', 'find', 'pkill', 'killall', 'kill', 'taskkill', 'stop-process', 'bash', 'sh', 'pwsh', 'powershell'].includes(name)) return undefined;
  return { executable: executable.value, arguments: invocation.arguments.slice(1), nested: true, pipeline: false };
}

function opaqueCommandText(invocation: ParsedCommandInvocation, shell: ShellKind): { shell: ShellKind; text: string } | Risk | undefined {
  if (NON_EXECUTING_ARGUMENT_COMMANDS.has(executableName(invocation.executable))) return undefined;
  const index = optionIndex(invocation, ['-c', '--command', '--exec', '--script', '--cmd', '-command', '-encodedcommand', '-enc']);
  if (index < 0) return undefined;
  const option = invocation.arguments[index]?.value?.toLowerCase();
  const content = invocation.arguments[index + 1];
  if (content?.value === undefined || content.nested.length > 0) return { kind: 'approval', reason: WRAPPER_REASON };
  if (option === '-encodedcommand' || option === '-enc') {
    const decoded = strictPowerShellDecode(content.value);
    return decoded === undefined ? { kind: 'approval', reason: WRAPPER_REASON } : { shell: 'powershell', text: decoded };
  }
  return { shell, text: content.value };
}

async function inspectText(text: string, shell: ShellKind, tracker: DirectoryTracker, depth: number): Promise<Risk> {
  if (depth > 8) return { kind: 'approval', reason: WRAPPER_REASON };
  const inspection = await inspectCommand(text, shell);
  return inspectAnalysis(inspection, shell, tracker, depth);
}

async function inspectAnalysis(
  inspection: CommandInspection,
  shell: ShellKind,
  tracker: DirectoryTracker,
  depth: number,
): Promise<Risk> {
  let approval: Risk;
  if (inspection.parsed.kind !== 'segments') approval = { kind: 'approval', reason: WRAPPER_REASON };
  for (const invocation of inspection.invocations) {
    const result = await inspectInvocation(invocation, shell, tracker, depth);
    if (result?.kind === 'hard-deny') return result;
    approval ??= result;
  }
  return approval;
}

async function inspectInvocation(
  invocation: ParsedCommandInvocation,
  shell: ShellKind,
  tracker: DirectoryTracker,
  depth: number,
): Promise<Risk> {
  if (depth > 8) return { kind: 'approval', reason: WRAPPER_REASON };
  const name = executableName(invocation.executable);
  const deletion = hardOrApprovalDeletion(invocation, shell, tracker.current);
  if (deletion?.kind === 'hard-deny') return deletion;
  const process = processRisk(invocation, shell);
  if (process?.kind === 'hard-deny') return process;
  const findExec = findExecChildren(invocation, shell, tracker.current);
  if (findExec?.rootSweep === true) return { kind: 'hard-deny', reason: DELETE_ROOT_REASON };

  let approval: Risk = deletion ?? process;
  if (findExec?.hasExecutor === true) approval ??= { kind: 'approval', reason: WRAPPER_REASON };
  if (findExec?.incomplete === true) approval ??= { kind: 'approval', reason: WRAPPER_REASON };
  for (const argument of invocation.arguments) {
    for (const nested of argument.nested) {
      const nestedResult = await inspectInvocation(nested, shell, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
      if (nestedResult?.kind === 'hard-deny') return nestedResult;
      approval ??= nestedResult;
    }
  }

  if (isScriptRunner(name)) approval ??= { kind: 'approval', reason: WRAPPER_REASON };
  const wrapped = wrappedInvocation(invocation, shell);
  if (wrapped?.risk?.kind === 'hard-deny') return wrapped.risk;
  approval ??= wrapped?.risk;
  if (wrapped?.script !== undefined) {
    const result = await inspectText(wrapped.script.text, wrapped.script.kind, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
    if (result?.kind === 'hard-deny') return result;
    approval ??= result;
    if (result === undefined) approval ??= { kind: 'approval', reason: WRAPPER_REASON };
  }
  if (wrapped?.child !== undefined) {
    const result = await inspectInvocation(wrapped.child, shell, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
    if (result?.kind === 'hard-deny') return result;
    approval ??= result;
    if (result === undefined && isScriptRunner(executableName(wrapped.child.executable))) {
      approval ??= { kind: 'approval', reason: WRAPPER_REASON };
    }
  }
  for (const child of findExec?.children ?? []) {
    const result = await inspectInvocation(child, shell, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
    if (result?.kind === 'hard-deny') return result;
    approval ??= result;
  }

  if (wrapped === undefined) {
    const script = opaqueCommandText(invocation, shell);
    if (script !== undefined) {
      if ('text' in script) {
        const result = await inspectText(script.text, script.shell, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
        if (result?.kind === 'hard-deny') return result;
        approval ??= result ?? { kind: 'approval', reason: WRAPPER_REASON };
      } else approval ??= script;
    }
    const child = opaqueChild(invocation);
    if (child !== undefined) {
      const result = await inspectInvocation(child, shell, { current: cloneDirectory(tracker.current), stack: [] }, depth + 1);
      if (result?.kind === 'hard-deny') return result;
      approval ??= result ?? { kind: 'approval', reason: WRAPPER_REASON };
    }
  }

  if (!invocation.nested && !invocation.pipeline) updateDirectory(invocation, shell, tracker);
  return approval;
}

export async function classifyDangerousCommand(
  command: string,
  shell: ShellKind,
  inspection?: CommandInspection,
  relativeCwd?: string,
): Promise<DangerousCommandMatch | undefined> {
  const parsed = inspection ?? await inspectCommand(command, shell);
  return inspectAnalysis(parsed, shell, initialDirectory(relativeCwd), 0);
}
