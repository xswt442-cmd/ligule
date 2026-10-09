// 客户端协议（D30）：界面客户端与 Host 之间的那一层契约，与它走什么载体无关。
// D30 定下六件事：创建或恢复会话、发送用户输入、接收流式事件、请求审批、取消、查询状态。
// 客户端发来的请求就是 METHODS 里那几个方法；审批是 Host 发出去、由客户端答复的一次请求；
// 流式事件与刚落盘的那一条记录是 Host 交回的通知，没有人答复它们。
// 参数模式用内核已经在校验的那个子集（D14），客户端与 Host 读同一张表，两边不会出现两份形状。
import { KernelError } from '../kernel/error.js';
import { assertSupportedSchema, validateArgs } from '../kernel/schema.js';

const SESSION_ID = { type: 'string', description: 'the session this call refers to' };

export const METHODS = Object.freeze({
  'session.create': {
    description: 'Start a session the Host keeps; returns the id every later call needs',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'start this session against another project the Host can load' },
        // 一份会话落在哪一具工作区由客户端说：桌面可能指名一份目录，而那一份正是它的默认工作区，
        // 「有没有指名」推不出这一层意思（方案 5.5.3）。不写这一格时宿主按指没指名定：指了是 explicit，没指是 default。
        workspaceOrigin: { type: 'string', description: "how this session landed on that workspace: 'explicit' when the client chose it, 'default' when it is the one the client falls back to" },
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
        // 记录属于哪个项目由这一格说：宿主按它取那一份项目环境，工具目录与记录目录都跟着走（方案 3.2）。
        projectRoot: { type: 'string', description: 'the project this record belongs to, when it is not the one the Host started on' },
      },
      required: ['sessionId'],
    },
  },
  // 第五条只为界面多出来的方法：一份会话在宿主那一侧占着记录锁、MCP 子进程与扩展监听，界面换到别的一份时要把这些收掉。
  // 它不取消正在跑的那一轮，也不动记录——记录是唯一的事实源，收的只是这一次装配（D85、D71）。
  'session.close': {
    description: 'Release this session in the Host: its record lock, its MCP servers and its extension listeners; the record on disk stays as it is',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
      required: ['sessionId'],
    },
  },
  // 第六条只为界面多出来的方法：名字与归档标记由宿主写成记录里的一条事实，两端读的是同一份（方案 4.2）。
  // 两格都可省略，但至少要给一格：什么都不改的一次调用没有意义，那一格由宿主说。
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
  // 第八条只为界面多出来的方法：分支复制的是记录的前缀，父那一份一个字都不动（方案 4.3）。
  // `at` 那一格说停在哪个轮次；不给就是整份复制，复制到此刻记录落到哪儿为止。
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
  // 第三条只为界面多出来的方法（前两条是 `mode.set` D65 与 `session.compact` D83）：会话列表扫的是记录目录，
  // 那是宿主那一侧的事实源，界面自己不去开盘。
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
  // 第七条只为界面多出来的方法：查的是记录目录里的那些整份记录，与列表同一个扫描器（方案 4.2）。
  // 交回的是「哪一份会话的第几条」，界面拿着这两个值接上那一份会话、跳到那一行。
  'sessions.search': {
    description: 'Find one piece of text in the records on disk and return which session each hit is in, most recently written session first; the query is required and must not be blank',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the text to look for, matched case-insensitively' },
        projectRoot: { type: 'string', description: 'only search sessions opened against this project root' },
        // 指名一份就只读那一份记录，并且读得深一层：那一次结果溢出在另一个文件里的整段正文也搜（方案 4.2 的完整工具结果）。
        sessionId: { ...SESSION_ID, description: 'search this one record only, including the tool results it spilled into other files' },
        limit: { type: 'integer', description: 'stop after this many hits', minimum: 1, maximum: 200 },
      },
      required: ['query'],
    },
  },
  // 第九条只为界面多出来的方法：`@` 要的候选文件由宿主这一侧列，界面不开盘（方案 5.3、D81 边界一）。
  // 列的是那一个项目根内的普通文件：符号链接不跟也不进候选，读不了的那一层不报错，只说这句可能没找全。
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
    description: 'Read the events of an open session, oldest first, so a client that arrives late can show what happened; `limit` and `before` ask for one history page instead of the whole record',
    parameters: { type: 'object', properties: {
      sessionId: SESSION_ID,
      fullResults: { type: 'boolean', description: 'read complete spilled tool results for display; the record and model view stay unchanged' },
      // 事件序号就是那条稳定游标：往回翻页要说出这一页最早的那一条，翻页期间新到的事件只追加在末尾（E03）。
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'take at most this many of the newest events in the requested range' },
      before: { type: 'integer', minimum: 1, description: 'read events older than this sequence number; it has to name an event in this record' },
    }, required: ['sessionId'] },
  },
  // 第十二条只为界面多出来的方法：一份记录写成 markdown 并落到人选定的那个位置（方案 6A）。
  // 读完整记录、补溢出正文、排版、写文件四件都在宿主这一侧，两个界共用这一条；界面只管由人选定目的地。
  // 那一条路径出自人自己按下的保存对话框，不是模型工具的一次写出，所以不套项目边界；交回路径不等于写成。
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
    description: 'Read what the Host currently holds for this session',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  // 工作区那份持久登记的读与写（方案 5.5.1、5.5.2、5.5.3）：清单与默认选择都在应用数据根里，
  // 界面上那一栏只是读者，收起或列不出来都不改这份文件。写那一头只有默认选择一件，登记本身由建会话那两处做。
  'workspaces.list': {
    description: 'Read the durable workspace roster and its default selection from the application data root; the interface list is a reader of it, so a workspace a person stopped watching is still here',
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
  // 第四条只为界面多出来的方法（前三条是 `mode.set` D65、`session.compact` D83、`sessions.list`）：配置在宿主那一侧，
  // 而这条路只交得出白名单里的几格——没有参数可点路径，所以界面要不到别的格。
  'config.get': {
    description: 'Read the configuration this interface may show: the host builds the answer from the whitelisted fields it owns, and those values, the layer writing each one and the version of every writable settings file come from one read, so no path can be asked for and no credential ever comes from configuration (D13, D60)',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'the project whose settings layers to read; absent means the one the Host was launched on' },
      },
    },
  },
  // 第十条只为界面多出来的方法：配置由宿主持有，界面说得出改哪一个白名单字段、写进哪一层，以及它读回的那一份版本；
  // 文件路径、白名单之外的键与项目共享那一份配置都说不出口（方案 7.2）。
  'config.set': {
    description: 'Write one whitelisted configuration field into one settings layer of one project; the host owns the field list, the value shape and the target file, refuses the write when that file changed since it was read, and adopts only the sessions whose effective value changed after the layers are folded again',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'one field name from the list the host names back when this is not one of them' },
        value: { type: 'string', description: 'the new value of a one-line field; the host checks it against the shape that field declares' },
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
  // 第十一条只为界面多出来的方法：审批档位有两件来源，配置文件那一份是默认，这一份会话可以覆盖它（D101）。
  // 覆盖只在运行期，不写文件也不动别的会话；交回档位说成 `default` 就是退回配置那一份。
  'policy.set': {
    description: 'Override the approval tier for this session only, or go back to the tier the settings file writes; the new tier applies to the tool decisions that follow',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID, mode: { type: 'string', description: "'ask', 'auto', or 'default' to drop this session's override" } },
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
  // 第二次多出一个方法（第一条是 `mode.set`，D65）：摘要要调模型、检查点要写盘，两处都在宿主一侧，界面做不到（D83）。
  'session.compact': {
    description: 'Compact the front of this session now: ask for one summary, write the checkpoint, return the new boundary; refuses while a round runs or when no window is configured',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
});

// Host 向客户端发出去的那一份请求，与客户端答复的形状。
export const APPROVAL_METHOD = 'approval.request';

// 模型向人提问那一条请求（D107）：审批那一格问这一件能不能做，这一格问这一件该怎么办，两条各自一发请求与一次答复。
// 答复带 `answers`，每题一项，按题目自己的编号对上；题目的字段由那件工具核对，这条协议只定请求的名字。
export const QUESTION_METHOD = 'question.request';

// Host 交回的通知名。delta 来自流式接收期间，event 是会话记录里刚落盘的那一条（I5：记录是唯一事实源），
// fault 是这条连接本身的问题——一行读不出来时没有对应的请求可以答复，只能说给对端听。
export const NOTIFICATIONS = Object.freeze(['delta', 'event', 'fault']);

for (const [name, method] of Object.entries(METHODS)) {
  // 这张表交给客户端读，子集之外的构造等于承诺一件客户端做不到的事，所以在这里当场失败。
  try {
    assertSupportedSchema(method.parameters);
  } catch (error) {
    throw new KernelError('protocol_method_unsupported', { detail: `${name}: ${error.message}` });
  }
}

export function validateCall(name, params) {
  const method = METHODS[name];
  if (method === undefined) throw new KernelError('protocol_method_unknown', { detail: name });
  const violations = validateArgs(method.parameters, params);
  if (violations.length > 0) throw new KernelError('protocol_args_invalid', { detail: `${name}: ${violations.join('; ')}` });
}

// 审批的答复只有一种要看的东西：允许还是不允许。
export function isApproved(result) {
  return result?.decision === 'allow';
}
