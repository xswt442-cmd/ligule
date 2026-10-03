// Host 进程的主体（D30）：会话、循环、工具与权限的真实状态都在这一侧，界面客户端只是协议的另一个端点。
// 加这一层不改动内核任何一行：要往外发的每一件事都有现成的注入口——
// 提供方与判定链由构造参数交进来，落盘的事件从会话记录那一条路上过一遍。
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { createKernel } from '../kernel/kernel.js';
import { loadAssembly } from '../kernel/assembly.js';
import { applyMode, loadMode } from '../kernel/modes.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { createSessionLog } from '../session/session.js';
import { loadInstructions, DEFAULT_INSTRUCTION_BYTES } from '../capability/instructions.js';
import { SKILL_METADATA_BUDGET_BYTES, discoverSkills, formatSkillCatalog, skillDirectories } from '../kernel/skills.js';
import { discoverTemplates, expandTemplate, findTemplate, parseInvocation, templateDirectories } from '../kernel/templates.js';
import { createLoop, DEFAULT_LOOP_LIMITS } from '../kernel/loop.js';
import { minimalPlugin } from '../tools/minimal.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createMessagesProvider } from '../model/messages.js';
import { createChatCompletionsProvider } from '../model/chat-completions.js';
import { DEFAULT_RETRY } from '../model/http.js';
import { createConnection } from './connection.js';
import { APPROVAL_METHOD, isApproved, validateCall } from './protocol.js';

// 重试边界也在配置里；形状在这里就查：非整数的 maxAttempts 让「第几次了」比不出大小，
// 每次传输失败就悄悄变成不重试，而看不出为什么不重试。
function retryOf(model) {
  const retry = { ...DEFAULT_RETRY, ...model.retry };
  for (const key of ['maxAttempts', 'baseDelayMs']) {
    if (!Number.isInteger(retry[key]) || retry[key] < 1) {
      throw new KernelError('host_retry_invalid', { detail: `${key} must be an integer of at least 1` });
    }
  }
  for (const key of ['retry429', 'retry5xx', 'retryTransport']) {
    if (typeof retry[key] !== 'boolean') throw new KernelError('host_retry_invalid', { detail: `${key} must be a boolean` });
  }
  return Object.freeze(retry);
}

// 服务地址与模型名从配置快照读，凭据只在发请求时从环境变量读（D13）。
// 线上形状由 `model.api` 指名（D31）：不按地址猜，猜错的请求体只会换来一句说不出原因的 400。
// 能力项只能把该种形状声明的上限调低，那一条判据由各自的声明把守，这里只负责把配置送到它面前。
const API_FORMS = Object.freeze({
  messages: createMessagesProvider,
  'chat-completions': createChatCompletionsProvider,
});

export function providerFromConfig(config) {
  const model = config.model;
  if (model === undefined) throw new KernelError('host_model_config_missing', { detail: 'config.model.baseURL and config.model.model' });
  const createProvider = API_FORMS[model.api];
  if (createProvider === undefined) {
    throw new KernelError('provider_api_form_required', { detail: `model.api must be "messages" or "chat-completions"` });
  }
  return createProvider({
    baseUrl: model.baseURL,
    model: model.model,
    ...(model.apiKeyEnv === undefined ? {} : { apiKeyEnv: model.apiKeyEnv }),
    ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
    retry: retryOf(model),
  });
}

// 会话记录落在哪儿：配置写了目录就用它，没有就贴着边界放。
function sessionDirectoryOf(config) {
  if (typeof config.host?.sessionDirectory === 'string' && config.host.sessionDirectory !== '') {
    return config.host.sessionDirectory;
  }
  return join(config.boundary, '.ligule', 'sessions');
}

// 循环的上限来自配置文件，形状在这里就查：只写其中一项时另一项照默认值补，
// 缺值传下去会让「迭代上限」变成 undefined，那一轮一次都不跑，报出来的码还说不出为什么。
function loopLimitsOf(config) {
  const limits = { ...DEFAULT_LOOP_LIMITS, ...config.loop };
  for (const key of ['iterations', 'modelCalls']) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) {
      throw new KernelError('host_loop_limits_invalid', { detail: `${key} must be an integer of at least 1` });
    }
  }
  return limits;
}

// 流式接收期间把每一条事件抄一份送出去，交回给循环的那一份原样不动。
// 抄的是原对象再加一个 stream，而不是重搭一个：提供方声明的能力、模型名与换模型的路径都要留着看得见。
function observedProvider(provider, onDelta) {
  return {
    ...provider,
    async *stream(request, options) {
      for await (const event of provider.stream(request, options)) {
        onDelta(event);
        yield event;
      }
    },
  };
}

// 落盘的每一条都抄一份送出去：记录里的事与客户端看见的事同源，客户端看见的就是已经写下来的。
function observedSession(session, onEvent) {
  return {
    ...session,
    async append(event) {
      const stored = await session.append(event);
      onEvent(stored);
      return stored;
    },
  };
}

// modeName 与 modePaths 是一对：给了名字就要能给那三层目录，运行中换模式要用同一套查找（D41、D44）。
export function createHost({ config, provider, plugins = [minimalPlugin], policy, logger, modeName, modePaths, skillRegistry, templateRegistry }) {
  if (!Object.isFrozen(config)) throw new KernelError('host_config_must_be_frozen');
  // 边界是工具读写的位置，也是指令文件上溯的止点，两边都读它，缺一处就说缺一处。
  if (typeof config.boundary !== 'string' || config.boundary === '') throw new KernelError('host_boundary_required');
  if (typeof provider?.stream !== 'function') throw new KernelError('host_provider_required');
  if (modeName !== undefined && modePaths === undefined) throw new KernelError('host_mode_paths_required');
  const directory = sessionDirectoryOf(config);
  const sessions = new Map();

  function open(id) {
    const state = sessions.get(id);
    if (state === undefined) throw new KernelError('session_not_open', { detail: id });
    return state;
  }

  // 一个会话一套内核、判定链与循环：判定链里的拒绝计数与档位按会话存活（D15、D17）。
  // ask 是这条会话的审批通道：客户端不在答复里说允许，就按不允许处理（D16 的询问走内核对外接口）。
  // 取消落在审批还没答复的时候要把这个问题收掉：答复不会再来了，而判定链在这里抛出，
  // 那一次调用就在记录里没人回答，之后每一轮都拼不出合法请求体（D11）。
  async function build(id, connection) {
    const session = observedSession(createSessionLog({ directory, id }), (event) => {
      connection.notify({ notify: 'event', sessionId: id, event });
    });
    const state = { id, session, asks: new Set(), running: undefined, mode: { file: undefined, tools: [], undo: () => {} }, pending: undefined };
    const chain = createDecisionChain({
      ...policy,
      ask: async ({ tool, input, command, reason }) => {
        let settle;
        const cancelled = new Promise((resolve) => {
          settle = () => resolve(false);
        });
        state.asks.add(settle);
        try {
          const request = connection.request(APPROVAL_METHOD, { sessionId: id, tool, args: input, command, reason });
          return await Promise.race([
            request.then(isApproved, (error) => {
              // 客户端把答复写成一次失败：这是它的问题，说出来，同时这一条按不允许处理，记录仍然完整。
              logger?.log?.(`approval failed for ${tool}`, { tool, code: error.code, reason: error.detail });
              return false;
            }),
            cancelled,
          ]);
        } finally {
          state.asks.delete(settle);
        }
      },
    });
    const kernel = createKernel({ config, policy: chain, session, logger });
    // 技能注册表是一条系统事实（D46）：磁盘上有几份技能与模式选了哪几件无关（D45、D57）。
    // 装载侧可以交进已经查好的一份（测试与以后的重载），没交就在这里扫那四个目录。
    // 一份都没有时不改工具表也不加片段：多一件没人用的工具会改掉每次请求的前缀字节（D12）。
    const skills = skillRegistry ?? await discoverSkills(skillDirectories(config.boundary));
    for (const diagnostic of skills.diagnostics) {
      // 头部解不开与被同名压掉的那一份都不静默：装载侧留一条日志，提示词里那一段说明也带上计数（D49、D57）。
      logger?.log?.('skill is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const loaded = skills.skills.length === 0 ? plugins : [...plugins, createSkillPlugin(skills)];
    // 提示模板也是装载侧扫出来的事实（D45）：两处目录，靠近仓库的那一份胜出。展开发生在这一侧，
    // 三个客户端因此不必各写一份替换规则（D54）。
    const templates = templateRegistry ?? await discoverTemplates(templateDirectories(config.boundary));
    for (const diagnostic of templates.diagnostics) {
      logger?.log?.('prompt template is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const assembly = loadAssembly(kernel, loaded);
    // 应用一份模式：先撤销上一次自己那一项收紧，再按新清单收紧，再把交给模型的那一栏留在记录里。
    // 记录里这一条是给「两条用户输入之间各自用的是哪一份清单」用的（I2、I5）；
    // 收紧只减不加，被藏起来的那几件仍然留在登记表里（I4）。
    state.adopt = async (file) => {
      state.mode.undo();
      const applied = applyMode(kernel, file);
      const tools = kernel.manifest().map((entry) => entry.name);
      Object.assign(state.mode, { file, tools, undo: applied.undo });
      // 同一份清单不重复记：重新attach 到一份已有记录上不写东西（客户端接上来读不该改动事实源）。
      // 名字、来源或那一栏工具变了才记一条，让「这一条输入用的是哪一份」在记录里读得出来（I5）。
      const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
      if (last === undefined || last.name !== file.name || last.layer !== file.layer || last.tools.join(' ') !== tools.join(' ')) {
        await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools });
      }
    };
    // 模式选中的那一栏工具在装载之后收紧（D35、D44）：清单里写了本次没登记的名字会在这里失败，
    // 而不是静默少一件。
    if (modeName !== undefined) await state.adopt(await loadMode(modeName, modePaths));
    const prompt = createPromptAssembly({ static: config.prompt?.static ?? '' });
    // 项目指令文件那四层是装载侧交给提示词的一段（D10、第 9.5 步留下的那一半）：
    // 装载器自己的预算算在完整文本上，片段登记时按同一个数，两处不会各截一次。
    const maxBytes = config.instructions?.maxBytes ?? DEFAULT_INSTRUCTION_BYTES;
    const instructions = await loadInstructions({ boundary: config.boundary, ...config.instructions });
    prompt.fragment({ name: 'instructions', anchor: 0, text: instructions.text, maxBytes });
    // 目录整份内联还是只留一句使用说明由预算判（D55）。有技能就有这一段：
    // 披露入口不在模式的选择范围里，模式藏不掉它（D63）。
    if (skills.skills.length > 0) {
      prompt.fragment({ name: 'skills', anchor: 1, text: formatSkillCatalog(skills), maxBytes: SKILL_METADATA_BUDGET_BYTES });
    }
    const loop = createLoop({
      kernel,
      provider: observedProvider(provider, (event) => connection.notify({ notify: 'delta', sessionId: id, event })),
      prompt,
      session,
      limits: loopLimitsOf(config),
    });
    // 一份会话一份状态，审批的等待与正在跑的那一轮都记在这里。
    return Object.assign(state, { chain, kernel, assembly, loop, templates });
  }

  return {
    async handle(message, connection) {
      validateCall(message.method, message.params);
      const { sessionId, input } = message.params ?? {};

      switch (message.method) {
        case 'session.create': {
          const id = randomUUID();
          sessions.set(id, await build(id, connection));
          return { sessionId: id };
        }
        case 'session.open': {
          // 记录不在磁盘上就是没有这份会话，把它当新的一次空记录打开会让人以为恢复成功了。
          try {
            await access(join(directory, `${sessionId}.jsonl`));
          } catch {
            throw new KernelError('session_not_found', { detail: sessionId });
          }
          // 同一条连接上开两次同一个 id 会丢掉前一份状态：那一轮还在跑，取消与撤插件都没了对象。
          if (sessions.has(sessionId)) throw new KernelError('session_already_open', { detail: sessionId });
          const state = await build(sessionId, connection);
          sessions.set(sessionId, state);
          return { sessionId };
        }
        case 'session.read': {
          // 交回的是记录本身：客户端晚到了也能把已经发生过的事画出来（I5）。
          const state = open(sessionId);
          return { sessionId, events: await state.session.read() };
        }
        case 'run.start': {
          const state = open(sessionId);
          if (state.running !== undefined) throw new KernelError('run_already_running', { detail: sessionId });
          const controller = new AbortController();
          // 取消落在还没答复的审批上时把那些等待收掉，否则这一轮停在没人答复的问题上。
          const settleAsks = () => {
            for (const settle of state.asks) settle();
          };
          controller.signal.addEventListener('abort', settleAsks, { once: true });
          // 模板展开排在这一轮开始之前（D54）：交进循环的是展开后的文本，记录里另外留着人打的那一行、
          // 参数、模板来源与内容摘要。查不到的那一行斜杠在这里就报出去，不带着没展开的原文进模型。
          const invocation = parseInvocation(input);
          let text = input;
          let user;
          if (invocation !== undefined) {
            const expanded = await expandTemplate(findTemplate(state.templates, invocation.command), invocation.arguments);
            text = expanded.text;
            user = { raw: input, arguments: expanded.arguments, source: expanded.source, digest: expanded.digest };
          }
          state.running = controller;
          try {
            return await state.loop.run(text, { signal: controller.signal, user });
          } finally {
            controller.signal.removeEventListener('abort', settleAsks);
            state.running = undefined;
            // 等本轮结束再生效（D41）：完成与被打断都算结束，轮中不换清单，记录里那条用户输入
            // 才对得上当时交给模型的那一栏工具。待生效的清单在请求时就装载过，这里不会再失败。
            if (state.pending !== undefined) {
              const next = state.pending;
              state.pending = undefined;
              await state.adopt(next);
            }
          }
        }
        case 'run.cancel': {
          const state = open(sessionId);
          if (state.running === undefined) throw new KernelError('run_not_running', { detail: sessionId });
          // 取消由循环那条边界接手：工具、提供方与循环看到的是同一次取消（D20）。
          state.running.abort();
          return { cancelled: true };
        }
        case 'mode.set': {
          const state = open(sessionId);
          // 名字在这里就读成清单：坏清单在请求这一次就说出来，而不是等本轮结束应用时才炸（D44）。
          const requested = await loadMode(message.params.name, modePaths);
          const current = state.mode.file;
          if (current !== undefined && current.name === requested.name && current.layer === requested.layer) {
            // 又选了一遍当前这一份：那是在撤回上一次待生效的请求，不写任何东西（D41）。
            state.pending = undefined;
          } else if (state.running === undefined) {
            await state.adopt(requested);
          } else {
            state.pending = requested;
          }
          return {
            mode: state.mode.file?.name ?? null,
            layer: state.mode.file?.layer ?? null,
            pending: state.pending?.name ?? null,
            tools: state.kernel.manifest().map((entry) => entry.name),
          };
        }
        case 'status.get': {
          const state = open(sessionId);
          return {
            sessionId,
            running: state.running !== undefined,
            // 交给模型的那一栏，不是登记表的全部（I2）：被模式藏起来的几件不在这儿。
            tools: state.kernel.manifest().map((entry) => entry.name),
            mode: state.mode.file?.name ?? null,
            modeLayer: state.mode.file?.layer ?? null,
            pendingMode: state.pending?.name ?? null,
            // 判定档位与模式名是两样东西，字段也各写各的（D40：状态行上 `mode:` 与 `policy:`）。
            policy: state.chain.mode,
            denials: state.chain.denials(),
            // 条数而不是内容：内容走 session.read。
            eventCount: (await state.session.read()).length,
          };
        }
        default:
          // validateCall 已经拦住了不认识的方法，走到这里说明分发表与协议表不是同一份。
          throw new KernelError('protocol_method_unhandled', { detail: message.method });
      }
    },

    // 一条连接断开时把它还占着的那一轮停下来，然后按装配清单的逆序把插件撤掉（I7）。
    release() {
      for (const state of sessions.values()) {
        if (state.running !== undefined) state.running.abort();
      }
      for (const state of sessions.values()) state.assembly.dispose();
      sessions.clear();
    },
  };
}

// 标准输入输出那一种载体的入口：Tauri 壳或者脚本把这个进程起起来，两端各读写一行 JSON。
export function serveHost({ input = process.stdin, output = process.stdout, config, ...rest }) {
  const host = createHost({ config, ...rest });
  const connection = createConnection({
    input,
    output,
    // 一行读不出来的东西不是任何一次调用的失败，它是这条连接的问题：说清楚，让客户端自己决定要不要重开进程。
    onFault: (error) => connection.notify({ notify: 'fault', code: error.code, detail: error.detail }),
  });
  connection.onRequest((message) => host.handle(message, connection));
  input.on('end', () => host.release());
  return host;
}
