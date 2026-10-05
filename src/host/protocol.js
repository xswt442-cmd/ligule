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
    parameters: { type: 'object', properties: {}, description: 'creating a session takes no argument' },
  },
  'session.open': {
    description: 'Resume a session whose record is already on disk',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'session.read': {
    description: 'Read the events of an open session, oldest first, so a client that arrives late can show what happened',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
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
    description: 'Stop the round this session is running; the call answering run.start then reports loop_cancelled',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  'status.get': {
    description: 'Read what the Host currently holds for this session',
    parameters: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
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
