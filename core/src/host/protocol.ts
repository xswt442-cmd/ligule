// 此协议定义客户端与 Host 之间的请求和通知，与底层传输方式无关。
// 客户端发起 METHODS 中的请求；Host 发出的审批由客户端答复；流式片段和已落盘事件以通知形式发送。
// 参数模式使用 Kernel 支持的子集，客户端和 Host 共用同一份定义。
import { KernelError } from '../kernel/error.js';
import { assertSupportedSchema, validateArgs } from '../kernel/schema.js';

interface MethodSpec {
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface HostMethodParams extends Record<string, unknown> {
  readonly sessionId?: string;
  readonly projectRoot?: string;
  readonly workspaceOrigin?: string;
  readonly mode?: string;
  readonly policy?: string;
  readonly name?: string;
  readonly archived?: boolean;
  readonly at?: number;
  readonly limit?: number;
  readonly query?: string;
  readonly path?: string;
  readonly fullResults?: boolean;
  readonly before?: number;
  readonly input?: string;
  readonly directory?: string;
  readonly text?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly initialMode?: string;
  readonly initialPolicy?: string;
  readonly initialProvider?: string;
  readonly initialModel?: string;
  readonly initialThinkingEffort?: string;
  readonly initialOutputTokens?: number;
  readonly thinkingEffort?: string;
  readonly outputTokens?: number;
  readonly resetModel?: boolean;
  readonly resetThinking?: boolean;
  readonly resetOutputTokens?: boolean;
  readonly reference?: string;
  readonly value?: unknown;
  readonly json?: string;
  readonly version?: string;
  readonly field?: string;
  readonly layer?: string;
  readonly op?: string;
  readonly index?: number;
  readonly ruleTool?: string;
  readonly ruleDecision?: string;
  readonly ruleMatch?: string;
  readonly ruleReason?: string;
}

const SESSION_ID: Record<string, unknown> = { type: 'string', description: 'the session this call refers to' };

export const METHODS = Object.freeze({
  'session.create': {
    description: 'Start a session the Host keeps; returns the id every later call needs',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'start this session against another project the Host can load' },
        // 客户端明确说明工作区来源，因为指定的目录也可能正是默认工作区。
        // 未提供来源时，Host 根据是否提供工作区路径区分显式选择与默认工作区。
        workspaceOrigin: { type: 'string', description: "how this session landed on that workspace: 'explicit' when the client chose it, 'default' when it is the one the client falls back to" },
        initialMode: { type: 'string', description: 'optional mode to apply before returning the new session' },
        initialPolicy: { type: 'string', description: 'optional session policy override: ask, auto, or never' },
        initialProvider: { type: 'string', description: 'provider ID for an initial model selection; must be paired with initialModel' },
        initialModel: { type: 'string', description: 'model ID for an initial model selection; must be paired with initialProvider' },
        initialThinkingEffort: { type: 'string', description: 'provider-supported effort to apply before the first run' },
        initialOutputTokens: { type: 'integer', minimum: 1, description: 'optional session output-token limit; the Host enforces model and context ceilings' },
      },
      description: 'a session starts on the project the Host was launched on; naming another project is optional',
    },
  },
  'session.open': {
    description: 'Resume a session whose record is already on disk; without a mode the Host takes the one last in force in that record',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        mode: { type: 'string', description: 'the mode to resume with, in place of the one that record carries' },
        // 用项目根目录选择项目环境，并据此解析工具边界和会话记录目录。
        projectRoot: { type: 'string', description: 'the project this record belongs to, when it is not the one the Host started on' },
      },
      required: ['sessionId'],
    },
  },
  // 关闭会话会释放其记录锁、MCP 子进程和扩展监听器。
  // 此操作不取消运行中的轮次，也不修改会话记录。
  'session.close': {
    description: 'Release this session in the Host: its record lock, its MCP servers and its extension listeners; the record on disk stays as it is',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
      required: ['sessionId'],
    },
  },
  // 会话名称和归档状态保存在记录中，由 Host 统一更新。
  // 两个字段都可省略，但至少要提供一个。
  'session.label': {
    description: 'Name this session, mark it archived, or both; the fact is appended to the record and the model is never shown it',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        name: { type: 'string', description: 'the title a person reads in the list; it stays out of what the model is shown' },
        archived: { type: 'boolean', description: 'archived keeps the record and only changes how the list shows it' },
      },
      required: ['sessionId'],
    },
  },
  // 创建分支时复制记录前缀，不修改父会话。
  // `at` 指定分支结束的轮次；省略时复制当前已有的全部记录。
  'session.branch': {
    description: 'Copy the prefix of a record into a new session: with `at`, up to that completed turn marker; without it, the whole record as it stands. The parent record is never written to, and a half-written branch is not listed',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        at: { type: 'integer', minimum: 0, description: 'the sequence number of a `turn` marker this record proves it completed' },
        projectRoot: { type: 'string', description: 'the project the parent record belongs to, when it is not the one the Host started on' },
      },
      required: ['sessionId'],
    },
  },
  // 会话列表由 Host 扫描记录目录；客户端不直接访问磁盘。
  'sessions.list': {
    description: 'List sessions already on disk, most recently written first, so a client can pick one to resume',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'only sessions opened against this project root' },
        limit: { type: 'integer', description: 'stop after this many rows', minimum: 1 },
      },
      description: 'listing sessions takes no argument; both filters are optional',
    },
  },
  // 搜索使用与会话列表相同的记录扫描器。
  // 结果包含会话编号和事件序号，供客户端打开会话并定位记录。
  'sessions.search': {
    description: 'Find one piece of text in the records on disk and return which session each hit is in, most recently written session first; the query is required and must not be blank',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the text to look for, matched case-insensitively' },
        projectRoot: { type: 'string', description: 'only search sessions opened against this project root' },
        // 只搜索指定会话，并读取溢出文件中的完整工具结果。
        sessionId: { ...SESSION_ID, description: 'search this one record only, including the tool results it spilled into other files' },
        limit: { type: 'integer', description: 'stop after this many hits', minimum: 1, maximum: 200 },
      },
      required: ['query'],
    },
  },
  // Host 为 `@` 文件引用生成候选项，客户端不扫描磁盘。
  // 只列项目根内的普通文件，不跟随符号链接；无法读取目录时标记结果可能不完整。
  'paths.list': {
    description: 'List file paths inside one project that contain the typed fragment, so an interface can offer @-references without walking the filesystem itself; results are capped and never include links',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project to list inside; absent means the one the Host was launched on' },
        query: { type: 'string', description: 'the fragment typed after @; matched case-insensitively against the path, absent or blank lists the first entries' },
        limit: { type: 'integer', description: 'stop after this many paths', minimum: 1, maximum: 50 },
      },
    },
  },
  'session.read': {
    description: 'Read events from an open session. Use `limit` and `before` for a history page, or `at` to read exactly one event by sequence number; `at` and `before` cannot be combined',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      fullResults: { type: 'boolean', description: 'read complete spilled tool results for display; the record and model view stay unchanged' },
      // 使用事件序号作为稳定游标；`before` 指向当前页最早事件，新事件只会追加到末尾。
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'take at most this many of the newest events in the requested range' },
      before: { type: 'integer', minimum: 1, description: 'read events older than this sequence number; it has to name an event in this record' },
      at: { type: 'integer', minimum: 1, description: 'read exactly the event with this sequence number; it has to exist in this record and cannot be combined with before' },
    }, required: ['sessionId'] },
  },
  // Host 读取完整记录、补回溢出内容、生成 Markdown 并写入用户选择的位置。
  // 导出路径由用户通过保存对话框选择，不受模型工具的项目边界限制；返回路径不代表写入成功。
  'session.export': {
    description: 'Write this session record, and each derived branch record, as Markdown files at the destination the human chose; returns the paths written and any branch it could not read',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      path: { type: 'string', description: 'the file to write the main record to; branch records get a sibling file named after their own session id' },
    }, required: ['sessionId', 'path'] },
  },
  'run.start': {
    description: 'Send one user input through the loop; events arrive as notifications while it runs',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, input: { type: 'string', description: 'the user message for this round' } },
      required: ['sessionId', 'input'],
    },
  },
  'run.cancel': {
    description: 'Stop the round this session is running; the call answering run.start reports loop_cancelled between model calls and provider_cancelled while one is in flight',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'status.get': {
    description: 'Read the Host state for this session, including its live phase and model output budget when a run is active',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'session.configure': {
    description: 'Read or change one session-owned category: mode, policy, model and generation settings. Generation changes apply at the next turn boundary and never write configuration files.',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      mode: { type: 'string', description: 'select a mode; default restores the mode configured for this project' },
      policy: { type: 'string', description: 'ask, auto, never, or default to restore the project policy' },
      provider: { type: 'string', description: 'provider ID for a model selection; must be paired with model' },
      model: { type: 'string', description: 'model ID for a model selection; must be paired with provider' },
      thinkingEffort: { type: 'string', description: 'a value advertised by the selected provider, or default to inherit the provider default' },
      outputTokens: { type: 'integer', minimum: 1, description: 'session output-token maximum bounded by the provider and context window' },
      resetModel: { type: 'boolean', description: 'restore the model selection inherited from the current project configuration' },
      resetThinking: { type: 'boolean', description: 'inherit the selected provider default thinking behavior' },
      resetOutputTokens: { type: 'boolean', description: 'inherit the selected provider output-token setting' },
    }, required: ['sessionId'] },
  },
  // 工作区登记表和默认选择保存在应用数据根目录中。
  // 客户端可读取登记、设置默认项或移除登记；移除前必须先清除默认项。
  'workspaces.list': {
    description: 'Read the durable workspace roster and its default selection from the application data root; a workspace removed from one window stays registered until explicitly removed',
    parameters: { type: 'object', properties: {} },
  },
  'workspace.default.set': {
    description: 'Name the workspace new sessions fall back to; the directory is registered first so the default always points at a row that exists, and an empty directory clears the default',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'the workspace to make default; blank means no workspace is the default' },
        name: { type: 'string', description: 'the label to show for it; absent keeps the last segment of the directory' },
      },
      required: ['directory'],
    },
  },
  'workspace.remove': {
    description: 'Remove a workspace from the durable roster without changing its directory or session records; the default workspace must be cleared first',
    parameters: {
      type: 'object',
      properties: { directory: { type: 'string', description: 'the registered workspace directory to remove' } },
      required: ['directory'],
    },
  },
  // CLI/TUI 和 Desktop 共用应用数据根目录中的输入历史。
  // 客户端不能获取历史文件路径或读取数据根下的其他文件；输入历史不写入会话，也不提供给模型。
  'history.read': {
    description: 'Read the input history this machine keeps across sessions: sentences that were actually sent, newest first, up to the cap the host applies',
    parameters: { type: 'object', properties: {} },
  },
  // 只保存已发送的输入；重复内容移到列表前端，超过上限时删除最旧条目。响应直接返回更新后的列表。
  'history.append': {
    description: 'Remember one sentence that was sent: it moves to the front of the shared history, an older copy of the same sentence comes with it, and the whole list stays capped; the full list after the write comes back',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the sentence that was sent; blank changes nothing' },
      },
      required: ['text'],
    },
  },
  // Desktop 草稿、暂停队列、语言、通知和外观保存在应用数据根目录的偏好文档中。
  // 客户端不能读取该文件路径或访问数据根目录中的其他文件。
  'credentials.status': {
    description: 'Report whether a credential is configured and its source; never return the credential value',
    parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
  },
  'model.select': {
    description: 'Select a listed provider and model for one session, immediately when idle or at the next turn boundary',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, provider: { type: 'string' }, model: { type: 'string' } },
      required: ['sessionId', 'provider', 'model'],
    },
  },
  'models.discover': {
    description: 'Discover model IDs using a temporary key or a credential bound to a trusted user-level service endpoint; never return or log the credential',
    parameters: {
      type: 'object',
      properties: {
        api: { type: 'string' }, baseURL: { type: 'string' }, reference: { type: 'string' },
        temporaryKey: { type: 'string' }, projectRoot: { type: 'string' },
      },
      required: ['api', 'baseURL', 'reference'],
    },
  },
  'credentials.set': {
    description: 'Store a secret in the system credential store; an active environment override prevents changes',
    parameters: { type: 'object', properties: { reference: { type: 'string' }, value: { type: 'string' } }, required: ['reference', 'value'] },
  },
  'credentials.delete': {
    description: 'Delete a stored secret; never modify an environment variable',
    parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
  },
  'prefs.read': {
    description: 'Read the desktop preferences this machine keeps in the application data root: drafts, paused queues and interface choices; the document is per machine, not per session',
    parameters: { type: 'object', properties: {} },
  },
  // 原子替换偏好文档。Host 校验对象结构，通过临时文件和重命名写入，并返回写入后的版本。
  'prefs.write': {
    description: 'Replace the desktop preferences document with the given JSON; the host checks it parses to an object, writes it atomically so a crash never leaves half a document, and the written document comes back',
    parameters: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'the whole preferences document as JSON; it must parse to an object' },
        version: { type: 'string', description: 'the byte version returned by prefs.read; blank only when the file did not exist' },
      },
      required: ['json', 'version'],
    },
  },
  // 客户端只能读取配置白名单中的字段，不能请求文件路径或其他配置内容。
  'config.get': {
    description: 'Read the configuration this interface may show: the host builds the answer from the whitelisted fields it owns, and those values, the layer writing each one and the version of every writable settings file come from one read, so no path can be asked for and no credential ever comes from configuration (D13, D60)',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project whose settings layers to read; absent means the one the Host was launched on' },
      },
    },
  },
  // 配置由 Host 管理。客户端只能指定允许字段、配置层和已读取版本，不能指定文件路径或写入其他字段。
  'config.set': {
    description: 'Write one whitelisted configuration field into one settings layer of one project; the host owns the field list, the value shape and the target file, refuses the write when that file changed since it was read, and adopts only the sessions whose effective value changed after the layers are folded again',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'one field name from the list the host names back when this is not one of them' },
        value: { description: 'the new value; the host checks scalar, service list, and model selection shapes by field name' },
        layer: { type: 'string', description: 'which settings file to write; the writable ones are named back when this is not one of them' },
        version: { type: 'string', description: 'the version read from that file, so a concurrent edit is reported instead of overwritten; blank when that file did not exist' },
        projectRoot: { type: 'string', description: 'the project whose settings layer to write; absent means the one the Host was launched on' },
        op: { type: 'string', description: 'for the tool rule table: add a rule, change that one rule, or remove it' },
        index: { type: 'number', description: 'which rule in the table that layer writes, counted from 0; ignored when adding' },
        ruleTool: { type: 'string', description: 'for add and change: the capability name the rule matches' },
        ruleDecision: { type: 'string', description: "for add and change: 'allow' or 'deny'" },
        ruleMatch: { type: 'string', description: 'for add and change: the command prefix pattern; absent means the whole capability' },
        ruleReason: { type: 'string', description: 'for add and change: the sentence shown when this rule decides' },
      },
      required: ['field', 'layer', 'version'],
    },
  },
  // 策略默认值来自配置，每个会话可以设置运行期覆盖。
  // 覆盖不写配置文件，也不影响其他会话；`default` 表示恢复配置默认值。
  'policy.set': {
    description: 'Override the approval tier for this session only, or go back to the tier the settings file writes; the new tier applies to the tool decisions that follow',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, mode: { type: 'string', description: "'ask', 'auto', 'never', or 'default' to drop this session's override" } },
      required: ['sessionId', 'mode'],
    },
  },
  'mode.set': {
    description: 'Switch to another named mode; while a round runs it takes effect once that round ends, and naming the mode already in use withdraws a pending switch',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, name: { type: 'string', description: 'the mode to use for the next round' } },
      required: ['sessionId', 'name'],
    },
  },
  // 压缩需要调用模型并写入检查点，因此只能由 Host 执行，不能由客户端直接完成。
  'session.compact': {
    description: 'Compact the front of this session now: ask for one summary, write the checkpoint, return the new boundary; refuses while a round runs or when no window is configured',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
} satisfies Record<string, MethodSpec>);

// Host 发给客户端的请求及客户端答复的结构。
export const APPROVAL_METHOD = 'approval.request' as const;

// 模型向用户提问的请求与工具审批相互独立，分别使用自己的请求和答复。
// 答复中的 `answers` 为每个问题提供一项结果；工具负责校验答案内容，协议只定义字段结构。
export const QUESTION_METHOD = 'question.request' as const;

// Host 发出的通知类型：`delta` 是流式片段，`event` 是刚写入记录的事件，`progress` 是会话活动状态，`fault` 是连接错误。
export const NOTIFICATIONS = Object.freeze(['delta', 'event', 'fault', 'progress'] as const);

for (const [name, method] of Object.entries(METHODS)) {
  // 此表会发送给客户端；不支持的参数构造在注册时立即报错。
  try {
    assertSupportedSchema(method.parameters);
  } catch (error) {
    const detail = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
    throw new KernelError('protocol_method_unsupported', { detail: `${name}: ${detail}` });
  }
}

export function validateCall(name: string, params: unknown): asserts params is HostMethodParams {
  const method = Object.entries(METHODS).find(([methodName]) => methodName === name)?.[1];
  if (method === undefined) throw new KernelError('protocol_method_unknown', { detail: name });
  const violations = validateArgs(method.parameters, params);
  if (violations.length > 0) throw new KernelError('protocol_args_invalid', { detail: `${name}: ${violations.join('; ')}` });
}

// 审批答复只包含允许或拒绝。
export function isApproved(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'decision' in result && result.decision === 'allow';
}
