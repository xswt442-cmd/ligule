// 会话记录的形状（D73）：一份记录的第一行说清它是哪一版格式、属于哪一个项目、开局用哪一份模式清单。
// 版本号是要真的当兼容边界用的：读不懂就拒绝，不静默跳过——一份被悄悄掏空的会话照样能拼出请求，
// 但那读出来的已经不是那一次运行了（I5）。
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
  // 工作区的身份与这一份会话是怎么落到那一具工作区的（D110、方案 5.5.3）：`explicit` 是客户端指名的，
  // `default` 是它当前那一具。界面按这两格决定这份会话归哪一组，不按「路径等不等于现在的默认目录」猜（方案 5.5.4）。
  // 更早的记录没有这两格：读的人把它们当成没说过的，不拿现在的默认目录去补写。
  workspace?: string;
  workspaceOrigin?: 'explicit' | 'default';
  createdAt: string;
  mode?: SessionModeIdentity;
}

export interface SessionEvent {
  seq: number;
  kind?: string;
  [key: string]: unknown;
}

// 交给 `append` 的那一条还没有序号：号是写出去的时候定的（D73）。
export type PendingSessionEvent = Omit<SessionEvent, 'seq'>;

// 名字与归档标记读回的是记录里那几条 `label` 折出来的当前值：后写的只盖掉它说的那一件，另一件沿用（方案 4.2、实现顺序第 75 步）。
// 列表、宿主的答复与查找三处都读这一份，所以折法只写在一处。
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

// 这一具程序会写出去的事件种类。不在这一张表里的种类，只有事件自己标了可跳过才允许略过（D73）：
// 一条撑起重建的事件被静丢掉，读出来的就是错的历史。
// `usage` 在表里（D82）：它不进投影，但它的序号占着位——把它当成「可略过」丢掉的那几种读法会让检查点那段范围缺号，
// 一份本来对得上的检查点就白作废了。它同时带着 `ignorable` 那一格，读不懂它的旧程序略过而不是拒绝打开。
// `label` 同一条道理（实现顺序第 75 步）：会话的名字与归档标记是记在记录里的事实，列表那一处读它，模型看不见它。
const WRITTEN_KINDS = ['session', 'user', 'reasoning', 'assistant', 'tool', 'mode', 'usage', 'turn', 'label', 'turnContext'];

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
    // 开局时还没决定用哪一份模式清单，这一格就是不写，而不是写一个空名字或写一份假的默认。
    projectRoot: projectRoot ?? '',
    createdAt,
  };
  if (workspace !== undefined && workspace !== '') header.workspace = workspace;
  if (workspaceOrigin !== undefined) header.workspaceOrigin = workspaceOrigin;
  if (mode !== undefined) header.mode = mode;
  return header;
}

// 首行不算一条事件：它没有序号，也不参与「第几条」；一份没有首行的现存记录按版本 0 读（D73）。
export function parseSessionEvents(objects: SessionEvent[]): SessionRecord {
  let formatVersion = 0;
  let header: SessionHeader | undefined;
  const events: SessionEvent[] = [];
  for (const [index, event] of objects.entries()) {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'session') {
      // 首行之外再出现一份会话元信息，说明这份记录被拼接过；读下去只会读出错误的装配。
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
      // 标过的种类这份程序读不懂：略过它，剩下的那几条照旧撑得起重建；没标过的就是要人先看一眼这份记录到底是谁写的。
      if (event.ignorable !== true) {
        throw new KernelRuntimeError('session_event_unsupported', { detail: kind === '' ? 'an event without a kind' : kind });
      }
      continue;
    }
    events.push(event);
  }
  return { events, formatVersion, header };
}
