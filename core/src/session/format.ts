// 会话记录首行保存格式版本、项目归属和创建时的模式信息。
// 未知格式版本必须拒绝读取，避免静默跳过记录并生成错误的模型上下文。
import { KernelRuntimeError } from '../kernel/error.js';

export const SESSION_FORMAT_VERSION = 1;

export interface SessionModeIdentity {
  name: string;
  layer: string;
}

export interface SessionHeader {
  kind: 'session';
  formatVersion: number;
  sessionId: string;
  projectRoot: string;
  // 保存工作区身份及来源：`explicit` 表示客户端指定，`default` 表示使用默认工作区。
  // 旧记录缺少这两个字段时保持未指定，不使用当前默认目录补写。
  workspace?: string;
  workspaceOrigin?: 'explicit' | 'default';
  createdAt?: string | null;
  mode?: SessionModeIdentity;
}

export interface SessionEvent {
  seq: number;
  kind?: string;
  [key: string]: unknown;
}

// 追加前的事件不含序号；写入时由 Session 分配。
export type PendingSessionEvent = Omit<SessionEvent, 'seq'>;

// 从 `label` 事件推导当前名称和归档状态；新事件只覆盖其中实际提供的字段。
// 会话列表、Host 响应和搜索共用此函数。
export function foldLabel(events: SessionEvent[]): { name: string; archived: boolean } {
  let name = '';
  let archived = false;
  for (const event of events) {
    if (event.kind !== 'label') continue;
    if (typeof event.name === 'string') name = event.name;
    if (typeof event.archived === 'boolean') archived = event.archived;
  }
  return { name, archived };
}

export interface SessionRecord {
  events: SessionEvent[];
  formatVersion: number;
  header: SessionHeader | undefined;
}

// 当前程序会写入的事件类型。未知事件仅在标记为 `ignorable` 时允许跳过，其他情况拒绝读取。
// `usage` 虽不进入模型投影，但其序号仍用于校验检查点范围，因此必须保留。
// `label` 保存会话名称和归档状态；这些信息供界面使用，不进入模型上下文。
const WRITTEN_KINDS = ['session', 'user', 'reasoning', 'assistant', 'tool', 'mode', 'usage', 'turn', 'label', 'turnContext', 'modelSelection', 'sessionGeneration', 'sessionLoopIterations'];

export function createSessionHeader({
  id,
  projectRoot,
  workspace,
  workspaceOrigin,
  createdAt,
  mode,
}: {
  id: string;
  projectRoot?: string;
  workspace?: string;
  workspaceOrigin?: 'explicit' | 'default';
  createdAt: string;
  mode?: SessionModeIdentity;
}): SessionHeader {
  const header: SessionHeader = {
    kind: 'session',
    formatVersion: SESSION_FORMAT_VERSION,
    sessionId: id,
    // 创建记录时可能尚未确定模式；此时省略该字段，不写空名称或虚构的默认值。
    projectRoot: projectRoot ?? '',
    createdAt,
  };
  if (workspace !== undefined && workspace !== '') header.workspace = workspace;
  if (workspaceOrigin !== undefined) header.workspaceOrigin = workspaceOrigin;
  if (mode !== undefined) header.mode = mode;
  return header;
}

// 首行元数据不是事件，不占事件序号；旧记录没有首行时按版本 0 读取。
export function parseSessionEvents(objects: SessionEvent[]): SessionRecord {
  let formatVersion = 0;
  let header: SessionHeader | undefined;
  const events: SessionEvent[] = [];
  for (const [index, event] of objects.entries()) {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'session') {
      // 会话元数据只能出现在首行；后续再次出现通常表示记录被拼接，应拒绝读取。
      if (index !== 0) throw new KernelRuntimeError('session_header_position', { detail: `line ${index + 1}` });
      const version = event.formatVersion;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
        throw new KernelRuntimeError('session_header_invalid', { detail: `formatVersion ${JSON.stringify(version)}` });
      }
      if (version > SESSION_FORMAT_VERSION) {
        throw new KernelRuntimeError('session_version_unsupported', {
          detail: `the record is version ${version}, this build reads up to ${SESSION_FORMAT_VERSION}`,
        });
      }
      formatVersion = version;
      header = event as unknown as SessionHeader;
      continue;
    }
    if (!WRITTEN_KINDS.includes(kind)) {
      // 未知事件只有标记为可忽略时才跳过；其他未知事件可能影响记录重建，必须拒绝读取。
      if (event.ignorable !== true) {
        throw new KernelRuntimeError('session_event_unsupported', { detail: kind === '' ? 'an event without a kind' : kind });
      }
      continue;
    }
    events.push(event);
  }
  return { events, formatVersion, header };
}
