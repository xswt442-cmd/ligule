// Host 进程的主体（D30）：会话、循环、工具与权限的真实状态都在这一侧，界面客户端只是协议的另一个端点。
// 加这一层不改动内核任何一行：要往外发的每一件事都有现成的注入口——
// 提供方与判定链由构造参数交进来，落盘的事件从会话记录那一条路上过一遍。
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { createKernel } from '../kernel/kernel.js';
import { loadAssembly } from '../kernel/assembly.js';
import { loadExtensions } from '../kernel/extensions.js';
import { applyMode, DEFAULT_MODE, loadMode } from '../kernel/modes.js';
import { createDecisionChain } from '../kernel/policy.js';
import { createPromptAssembly } from '../kernel/prompt.js';
import { createSessionLog } from '../session/session.js';
import { chooseResumeMode, listSessions, sessionDirectory } from '../session/list.js';
import { searchSessions } from '../session/search.js';
import { createCompaction } from '../session/compaction.js';
import { repairUnresolvedCalls } from '../session/repair.js';
import { limitsOf } from '../capability/limits.js';
import { loadInstructions, DEFAULT_INSTRUCTION_BYTES } from '../capability/instructions.js';
import { SKILL_METADATA_BUDGET_BYTES, discoverSkills, formatSkillCatalog, skillDirectories } from '../kernel/skills.js';
import { discoverTemplates, expandTemplate, findTemplate, parseInvocation, templateDirectories } from '../kernel/templates.js';
import { createLoop, DEFAULT_LOOP_LIMITS } from '../kernel/loop.js';
import { minimalPlugin } from '../tools/minimal.js';
import { networkPlugin } from '../tools/network.js';
import { createSkillPlugin } from '../tools/skill.js';
import { createMcpPlugin } from '../tools/mcp.js';
import { createSubagentPlugin } from '../tools/subagent.js';
import { createMcpRegistry, mcpServerConfigs } from '../capability/mcp.js';
import { createMessagesProvider } from '../model/messages.js';
import { createChatCompletionsProvider } from '../model/chat-completions.js';
import { DEFAULT_RETRY } from '../model/http.js';
import { createConnection } from './connection.js';
import { APPROVAL_METHOD, isApproved, validateCall } from './protocol.js';

// 会话名字的上限：列表那一行还要放得下时间与条数，名字过长就该换一份短的（实现顺序第 75 步）。
export const SESSION_NAME_MAX = 120;

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

// 会话记录落在哪儿由 `src/session/list.js` 那一处说:同一件事在两处各写一次,列表与宿主就会读到两个目录(D73)。

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

// 压缩的两条线（D75、U43）：窗口那一格必须写出来，两条比例才有意义——窗口是模型事实，不是策略参数。
// 没写就整条不启用（交回 undefined，宿主不给这一份会话挂压缩），写了但形状不对当场报出去，
// 因为一条 NaN 的线会让每一次请求都算不出「超没超」，看上去是压缩从不触发。
// 保留量还必须严格小于压力线，否则压完还是越线，而看不出来为什么一直在压（dsh 同一条约束）。
export function compactionLimitsOf(config) {
  const limits = limitsOf(config);
  if (limits.contextTokens === undefined) return undefined;
  if (typeof limits.contextTokens !== 'number' || !Number.isFinite(limits.contextTokens) || limits.contextTokens <= 0) {
    throw new KernelError('host_compaction_limits_invalid', { detail: `contextTokens must be a positive number, got ${JSON.stringify(limits.contextTokens)}` });
  }
  for (const key of ['compactThresholdRatio', 'compactRetainRatio']) {
    if (typeof limits[key] !== 'number' || !(limits[key] > 0)) {
      throw new KernelError('host_compaction_limits_invalid', { detail: `${key} must be a positive number` });
    }
  }
  if (limits.compactThresholdRatio > 1 || limits.compactRetainRatio >= limits.compactThresholdRatio) {
    throw new KernelError('host_compaction_limits_invalid', {
      detail: `compactRetainRatio (${limits.compactRetainRatio}) must be below compactThresholdRatio (${limits.compactThresholdRatio}), and the threshold must be at most 1`,
    });
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

// 界面能看到的配置由这一处拼出来（实现顺序第 67 步）。每一格要先是字符串，不是字符串就不交。
// 地址只留协议、主机、端口与路径：用户名、密码、查询参数与片段常常装的就是凭据，不原样交回。
// 地址解析不出来时也不猜，交回没有这一格，界面上说「读不出来或没写」。
function shownText(value) {
  return typeof value === 'string' ? value : undefined;
}

export function shownConfigOf(config) {
  const model = config.model ?? {};
  let endpoint = shownText(model.baseURL);
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      endpoint = `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      endpoint = undefined;
    }
  }
  return {
    model: {
      api: shownText(model.api),
      baseURL: endpoint,
      model: shownText(model.model),
      apiKeyEnv: shownText(model.apiKeyEnv),
    },
  };
}

// modeName 与 modePaths 是一对：给了名字就要能给那三层目录，运行中换模式要用同一套查找（D41、D44）。
// 扩展来源由装载侧算好交进来（D68：项目层与本地层里写的路径不算）：paths 是要加载的文件，
// ignored 是那些被这条规则挡掉的路径，它们进日志而不是静默消失。
export function createHost({ config, provider, plugins = [minimalPlugin, networkPlugin], policy, logger, modeName, modePaths, skillRegistry, templateRegistry, extensions = { paths: [], ignored: [] }, loadEnvironment }) {
  // 一份项目环境：这个项目自己的配置快照、提供方、判定档位、模式目录与记录目录（方案 3.1 与 3.2）。
  // 校验在装载这一刻做完：一条坏配置不该等到模型第一次调用才炸（D60）。
  // 边界是工具读写的位置，也是指令文件上溯的止点，两边都读它，缺一处就说缺一处。
  function prepareEnvironment(own) {
    if (!Object.isFrozen(own.config)) throw new KernelError('host_config_must_be_frozen');
    if (typeof own.config?.boundary !== 'string' || own.config?.boundary === '') throw new KernelError('host_boundary_required');
    if (typeof own.provider?.stream !== 'function') throw new KernelError('host_provider_required');
    if (own.modeName !== undefined && own.modePaths === undefined) throw new KernelError('host_mode_paths_required');
    return {
      projectRoot: own.config.boundary,
      config: own.config,
      provider: own.provider,
      policy: own.policy,
      modeName: own.modeName,
      modePaths: own.modePaths,
      skillRegistry: own.skillRegistry,
      templateRegistry: own.templateRegistry,
      extensions: own.extensions ?? { paths: [], ignored: [] },
      mcpConfigs: mcpServerConfigs(own.config),
      directory: sessionDirectory(own.config),
    };
  }

  const defaultEnvironment = prepareEnvironment({
    config, provider, policy, modeName, modePaths, skillRegistry, templateRegistry, extensions,
  });
  // 按项目根存一张表：同一份项目环境只装载一次，之后开这一项目的会话与列这一项目的记录都读它。
  const environments = new Map([[defaultEnvironment.projectRoot, defaultEnvironment]]);

  // 取这一份项目环境。没指名就是宿主自己那一份；指名了别的项目而装载侧没给那条路就说清不支持，
  // 不悄悄用当前这一份项目环境去读另一项目的记录（方案 3.2：不能在另一个项目里悄悄继续）。
  async function environmentFor(projectRoot) {
    if (projectRoot === undefined || projectRoot === null || projectRoot === '') return defaultEnvironment;
    const known = environments.get(projectRoot);
    if (known !== undefined) return known;
    if (loadEnvironment === undefined) throw new KernelError('host_project_root_unsupported', { detail: String(projectRoot).slice(0, 200) });
    const loaded = prepareEnvironment(await loadEnvironment(projectRoot));
    if (loaded.projectRoot !== projectRoot) {
      throw new KernelError('host_project_root_mismatch', { detail: `asked for ${projectRoot}, the layers give ${loaded.projectRoot}` });
    }
    environments.set(projectRoot, loaded);
    return loaded;
  }

  const sessions = new Map();
  const building = new Set();
  let closing;

  function open(id) {
    const state = sessions.get(id);
    if (state === undefined) throw new KernelError('session_not_open', { detail: id });
    return state;
  }

  // 一次装配的收尾：MCP 的子进程、扩展的监听、模板登记表与那一份记录锁，四样都只在这一份会话里存在过（D60、D37、D85）。
  // 记录本身一个字都不动：它是事实源，收掉的只是宿主里这一份活着的装配（I1）。
  async function retire(state) {
    // 那一轮的失败不是收尾的失败：取消、提供方断流这些事实已经写在记录里了，这里只等它跑完（D11）。
    await state.operation?.catch(() => undefined);
    try {
      await state.mcp.close();
      state.extensions.dispose();
      state.assembly.dispose();
    } finally {
      // 收尾失败也要把这一份从表里摘出去并交回记录锁：留着它，界面再也收不掉，锁也一直占着（D85）。
      sessions.delete(state.id);
      await state.session.close();
    }
  }

  // 这一个项目根上最后一份会话收了，那份项目环境就退出这张表：下一次开这一根的会话重新读配置那几层（方案 3.1）。
  // 宿主自己那一份不退，它没有装载侧可回去重算。
  function evictEnvironment(environment) {
    if (environment === defaultEnvironment) return;
    for (const other of sessions.values()) if (other.environment === environment) return;
    environments.delete(environment.projectRoot);
  }

  // 列清单与查记录扫的是同一格目录，两条路共用这一处判断（方案 3.2）。
  // 指名的项目还没装载过、装载侧又给不出那条路时，照当前这一份目录扫，过滤条件继续生效——
  // 扫一遍磁盘上的记录不逼出装载。
  async function scanDirectory(projectRoot) {
    const unloaded = projectRoot !== undefined && !environments.has(projectRoot) && loadEnvironment === undefined;
    return (unloaded ? defaultEnvironment : await environmentFor(projectRoot)).directory;
  }

  // 名字与归档标记读回的是记录里那几条 `label` 折出来的当前值：宿主不另存一份，两端看的是同一份事实（I5、方案 4.2）。
  async function labelOf(state) {
    let name = '';
    let archived = false;
    for (const event of await state.session.read()) {
      if (event.kind !== 'label') continue;
      if (typeof event.name === 'string') name = event.name;
      if (typeof event.archived === 'boolean') archived = event.archived;
    }
    return { sessionId: state.id, name, archived };
  }

  async function execute(state, action) {
    if (state.running !== undefined) throw new KernelError('run_already_running', { detail: state.id });
    const controller = new AbortController();
    const settleAsks = () => { for (const settle of state.asks) settle(); };
    controller.signal.addEventListener('abort', settleAsks, { once: true });
    state.running = controller;
    state.operation = (async () => {
      try {
        return await action(controller.signal);
      } finally {
        controller.signal.removeEventListener('abort', settleAsks);
        state.running = undefined;
        if (state.pending !== undefined) {
          const next = state.pending;
          state.pending = undefined;
          await state.adopt(next);
        }
      }
    })();
    try {
      return await state.operation;
    } finally {
      state.operation = undefined;
    }
  }

  // `<主干 id>.sub-<序号>` 是派生支线的名字（D71）：它的主干在这条连接上打开着，这一条才读得到（D74）。
  function branchOwner(id) {
    const matched = /^(.+)\.sub-(\d+)$/.exec(id);
    return matched !== null && sessions.has(matched[1]) ? matched[1] : undefined;
  }

  // 会话 id 那个串是从客户端来的，要拼成记录文件名：带目录分隔符时拼出的路径会走到记录目录外面。
  // 形状在这里查一次，打开、读取与支线三条路共用同一处，形状不对都报同一个码，不混进「找不到这份会话」。
  function assertSessionId(id) {
    if (typeof id !== 'string' || id === '' || id === '.' || id === '..'
      || id.includes('/') || id.includes('\\') || id.includes(':') || id.includes('\0')) {
      throw new KernelError('session_id_invalid', { detail: String(id).slice(0, 80) });
    }
  }

  function recordPathOf(id, env = defaultEnvironment) {
    assertSessionId(id);
    return join(env.directory, `${id}.jsonl`);
  }

  // 溢出的那一份完整正文只在被读到的那一页上取：一次读一百条时不该把整份记录的结果文件都翻一遍。
  async function fillSpills(events, env) {
    const base = await realpath(env.directory);
    const complete = [];
    for (const event of events) {
      const result = event.kind === 'tool' ? event.result : undefined;
      if (result?.spilled === undefined) { complete.push(event); continue; }
      if (typeof result.spilled !== 'string' || !/^result-\d+-[a-f0-9]{8}\.json$/.test(result.spilled)) {
        throw new KernelError('session_spill_reference_invalid', { detail: `event ${event.seq}` });
      }
      let content;
      try {
        const path = await realpath(join(env.directory, result.spilled));
        const local = relative(base, path);
        if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
          throw new KernelError('session_spill_reference_invalid', { detail: `event ${event.seq}` });
        }
        const text = await readFile(path, 'utf8');
        content = result.spillFormat === 'json' ? JSON.parse(text) : text;
      } catch (cause) {
        if (cause.code === 'session_spill_reference_invalid') throw cause;
        throw new KernelError('session_spill_read_failed', { cause, detail: `${result.spilled}: ${cause.message}` });
      }
      complete.push({ ...event, result: { ...result, content } });
    }
    return complete;
  }

  // 一页历史（实现顺序第 72 步，方案 4.1）：游标用的是记录里那一条事件自己的序号，它稳定且单调，
  // 所以往回翻只说「比这一页最早那一条更早」，翻页期间新事件只追加在末尾，旧页不重复也不漏。
  // 交回的 `endSeq` 是这一次读到的快照末端，`hasMore` 说这一页之前还有没有更早的。
  async function readForClient(session, sessionId, { fullResults, limit, before } = {}, env = defaultEnvironment) {
    const events = await session.read();
    const header = await session.header();
    // 游标归属那一格要说清它认不认得：不是这一份记录里的事件序号就是失效的游标，不静默当成第一页（E03）。
    if (before !== undefined && !events.some((event) => event.seq === before)) {
      throw new KernelError('session_cursor_invalid', { detail: `${sessionId} has no event ${before}` });
    }
    const page = (before === undefined ? events : events.filter((event) => event.seq < before)).slice(-(limit ?? events.length));
    return {
      sessionId,
      events: fullResults ? await fillSpills(page, env) : page,
      header: header ?? null,
      endSeq: page.length === 0 ? null : page.at(-1).seq,
      hasMore: page.length > 0 && page[0].seq > 1,
    };
  }

  // 一个会话一套内核、判定链与循环：判定链里的拒绝计数与档位按会话存活（D15、D17）。
  // ask 是这条会话的审批通道：客户端不在答复里说允许，就按不允许处理（D16 的询问走内核对外接口）。
  // 取消落在审批还没答复的时候要把这个问题收掉：答复不会再来了，而判定链在这里抛出，
  // 那一次调用就在记录里没人回答，之后每一轮都拼不出合法请求体（D11）。
  async function build(id, connection, recover = false, explicitMode, env = defaultEnvironment) {
    // 这一份会话读的项目环境就是它所属那一个：下面这些名字从这里取，不再读宿主闭包里的那一份（方案 3.1）。
    const { config, provider, policy, modePaths, directory, mcpConfigs, extensions, skillRegistry, templateRegistry } = env;
    // 扩展收事件的那一条通道（D37）：刚落盘的这一条同时送给客户端与扩展，两边读的是同一份事实（I5）。
    const listeners = [];
    // 首行那份元信息在第一次落笔时才写，所以模式身份用一条取当前值的函数给：建会话的那一刻常常还没选过模式（D73）。
    const session = observedSession(createSessionLog({
      directory,
      id,
      meta: () => ({
        projectRoot: config.boundary,
        mode: state.mode.file === undefined ? undefined : { name: state.mode.file.name, layer: state.mode.file.layer },
      }),
    }), (event) => {
      connection.notify({ notify: 'event', sessionId: id, event });
      for (const listener of listeners) listener(event);
    });
    const state = { id, session, listeners, asks: new Set(), running: undefined, mode: { file: undefined, tools: [], undo: () => {} }, pending: undefined, environment: env };
    await session.acquire();
    const cleanup = [];
    try {
    const chain = createDecisionChain({
      ...policy,
      ask: async ({ tool, input, command, reason, shell, executable }) => {
        let settle;
        const cancelled = new Promise((resolve) => {
          settle = () => resolve(false);
        });
        state.asks.add(settle);
        try {
          // 后端那两样只在真有一条命令要判时带上：没有命令文本的调用（读文件一类）不该在答复里多出一个空字段，
          // 否则同一条协议在按行转递的载体上与在进程内的那一种上读到的形状就不一样。
          const request = connection.request(APPROVAL_METHOD, {
            sessionId: id, tool, args: input, command, reason, ...(shell === undefined ? {} : { shell, executable }),
          });
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
    // MCP 的两件固定工具按配置里有没有服务器登记（D52、D60）：一件都没配时这一格是空的，模型可见清单不涨。
    const mcp = createMcpRegistry(mcpConfigs);
    cleanup.push(() => mcp.close());
    // 提示模板也是装载侧扫出来的事实（D45）：两处目录，靠近仓库的那一份胜出。展开发生在这一侧，
    // 三个客户端因此不必各写一份替换规则（D54）。
    const templates = templateRegistry ?? await discoverTemplates(templateDirectories(config.boundary));
    for (const diagnostic of templates.diagnostics) {
      logger?.log?.('prompt template is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 提示词的组装器先建好：扩展登记的那几段要进这一份，模式 `prompt` 那一格挑的也就是这几段（D35、D46）。
    const prompt = createPromptAssembly({ static: config.prompt?.static ?? '' });
    // 派生执行体那一件工具（D71）：它拿到的插件是这一套减去 `subagent` 自己（一层是「谁在跑」读得出来的下界），
    // 判定链沿用这一条实例，静态前缀沿用这一份（同一串字节让端点的缓存对派生体也成立，D9）。
    // 提供方直接用未装饰的那一份：派生体的流式事件不往客户端转，那一段的进度在它自己的记录里（与 pi 的差别记在 D71）。
    const basePlugins = [...loaded, createMcpPlugin(mcp)];
    const assembly = loadAssembly(kernel, [...basePlugins, createSubagentPlugin({
      config,
      provider,
      chain,
      prompt,
      directory,
      sessionId: id,
      logger,
      plugins: basePlugins,
      modePaths,
      modeFile: () => state.mode.file,
      loopLimits: loopLimitsOf(config),
    })]);
    cleanup.push(() => assembly.dispose());
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
    // 扩展的装载（D37、D68）：来源由装载侧算好交进来，这一处只管按次序 import、递出窄接口、留下反注册动作。
    // 窄接口只有那四件——注册工具、注册提示词片段、收事件、请求一次能力操作。这就是契约承诺的暴露面；
    // 它不是限制：进程内的模块技术上能做 Node 能做任何事，所以判定链、路径边界与参数校验对每一次调用照常生效（D37）。
    const fragments = [];
    for (const diagnostic of extensions.ignored) {
      logger?.log?.('extension source is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    const installedExtensions = await loadExtensions(extensions.paths, {
      config,
      registerTool: (tool) => kernel.register(tool),
      registerFragment: (fragment) => {
        // 两个扩展抢同一个片段名会让「这一格选了谁」读不出来：报出去，让后装的那一件自己改名字。
        if (fragments.some((entry) => entry.name === fragment.name)) throw new KernelError('extension_fragment_duplicate', { detail: fragment.name });
        fragments.push(fragment);
        return () => {
          const index = fragments.indexOf(fragment);
          if (index >= 0) fragments.splice(index, 1);
        };
      },
      addEventListener: (handler) => {
        state.listeners.push(handler);
        return () => {
          const index = state.listeners.indexOf(handler);
          if (index >= 0) state.listeners.splice(index, 1);
        };
      },
      // 请求一次能力操作走的就是内核那一条 call：判定链、会话记录与参数校验一件都少不了（D37、D11）。
      request: (tool, args) => kernel.call(tool, args),
    });
    cleanup.push(() => installedExtensions.dispose());
    for (const diagnostic of installedExtensions.diagnostics) {
      // 一件坏扩展不带走整次运行：它自己的登记全撤掉，别一条诊断，装载继续（D37 的承诺只到暴露面为止）。
      logger?.log?.('extension is not loaded', { code: diagnostic.code, path: diagnostic.path, reason: diagnostic.detail });
    }
    // 应用一份模式：先按新清单挑出提示词片段，再撤销上一次那一项收紧，然后装上新的片段。
    // 挑片段放在撤销之前：那一格写错了名字时不该留下「旧的已撤、新的没上」这一中间状态。
    // 记录里这一条是给「两条用户输入之间各自用的是哪一份清单」用的（I2、I5）；
    // 收紧只减不加，被藏起来的那几件仍然留在登记表里（I4）。
    state.adopt = async (file) => {
      const selected = file.prompt === '*'
        ? [...fragments]
        : file.prompt.map((name) => {
            const found = fragments.find((entry) => entry.name === name);
            if (found === undefined) {
              throw new KernelError('mode_prompt_unavailable', {
                detail: `${name} (mode ${file.name}; registered: ${fragments.map((entry) => entry.name).join(', ') || 'none'})`,
              });
            }
            return found;
          });
      state.mode.undo();
      const applied = applyMode(kernel, file);
      const fragmentUndo = selected.map((fragment, index) => prompt.fragment({
        name: `extension:${fragment.name}`,
        anchor: 2 + index,
        text: fragment.text,
        maxBytes: limitsOf(config).promptFragmentBytes,
      }));
      const tools = kernel.manifest().map((entry) => entry.name);
      Object.assign(state.mode, {
        file,
        tools,
        undo: () => {
          for (const remove of fragmentUndo.slice().reverse()) remove();
          applied.undo();
        },
      });
      // 同一份清单不重复记：重新attach 到一份已有记录上不写东西（客户端接上来读不该改动事实源）。
      // 名字、来源或那一栏工具变了才记一条，让「这一条输入用的是哪一份」在记录里读得出来（I5）。
      const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
      if (last === undefined || last.name !== file.name || last.layer !== file.layer || last.tools.join(' ') !== tools.join(' ') || last.digest !== file.digest) {
        await session.append({ kind: 'mode', name: file.name, layer: file.layer, path: file.path, tools, digest: file.digest });
      }
    };
    // 模式选中的那一栏工具与那几段片段在装载之后才生效（D35、D44）：清单里写了本次没有登记的名字会在这里失败，
    // 而不是静默少一件。
    // 打开一份已有的记录时，先把没人回答的那几次派发补成规范的工具结果（D72）：这一条只在可写的恢复路径上做一次，
    // 读的那几处（`session.read`、界面、列表）报告缺口而不改盘。新建的那一份里没有待补的东西。
    if (recover) {
      const repaired = await repairUnresolvedCalls(session, { readOnly: new Set(kernel.readOnly()) });
      for (const event of repaired) logger?.log?.('unanswered tool call repaired', { sessionId: id, callId: event.callId, tool: event.tool });
    }
    // 用哪一份模式清单：客户端显式选了就用它；打开一份已有记录时取记录里最后生效的那一条并比它的摘要（D78）；
    // 两者都没有时保持装配时那一份。静默换成磁盘上现在这一份等于在别人没选过的范围里决定这一次能用什么，
    // 所以摘要变了要报 `resume_mode_changed` 并要求显式选一次，而不是悄悄沿用。
    let wanted = explicitMode ?? modeName;
    if (explicitMode === undefined && recover && modePaths !== undefined) {
      const last = (await session.read()).filter((event) => event.kind === 'mode').at(-1);
      if (last !== undefined) {
        wanted = chooseResumeMode({
          recorded: { name: String(last.name), digest: last.digest },
          loaded: await loadMode(String(last.name), modePaths),
          fallback: modeName ?? DEFAULT_MODE,
        });
      }
    }
    if (wanted !== undefined) await state.adopt(await loadMode(wanted, modePaths));
    // 压缩挂在这一份会话上（D75）：两条触发都在循环里问它，摘要那一次调用走未装饰的提供方——
    // 它的流式增量不该转给客户端，而它写完检查点就退出这一轮的事，事件日志一条都不动。
    // 配置没写 `limits.contextTokens` 时这一件是 null：窗口大小是模型事实，不猜，正常聊天照跑。
    const limits = compactionLimitsOf(config);
    const compaction = limits === undefined ? null : createCompaction({
      provider,
      session,
      directory,
      id,
      limits,
      logger,
      requestPrefix: () => ({ system: prompt.render(), tools: kernel.manifest() }),
    });
    const loop = createLoop({
      kernel,
      provider: observedProvider(provider, (event) => connection.notify({ notify: 'delta', sessionId: id, event })),
      prompt,
      session,
      limits: loopLimitsOf(config),
      compaction,
    });
    // 一份会话一份状态，审批的等待与正在跑的那一轮都记在这里。
    return Object.assign(state, { chain, kernel, assembly, extensions: installedExtensions, mcp, loop, templates, compaction });
    } catch (error) {
      try {
        for (const dispose of cleanup.reverse()) await dispose();
      } finally {
        await session.close();
      }
      throw error;
    }
  }

  function buildSession(id, connection, recover = false, mode, env = defaultEnvironment) {
    const pending = build(id, connection, recover, mode, env).then((state) => {
      sessions.set(id, state);
      return { sessionId: id };
    });
    building.add(pending);
    return pending.finally(() => building.delete(pending));
  }

  return {
    async handle(message, connection) {
      if (closing !== undefined) throw new KernelError('host_closed');
      validateCall(message.method, message.params);
      const { sessionId, input } = message.params ?? {};

      switch (message.method) {
        case 'session.create': {
          const id = randomUUID();
          return await buildSession(id, connection, false, undefined, await environmentFor(message.params.projectRoot));
        }
        case 'session.open': {
          // 指名了项目就取那一份项目环境：记录在哪个目录、工具在哪个目录读写，都由它说（方案 3.2）。
          const env = await environmentFor(message.params.projectRoot);
          // 派生支线那一份记录说的是父侧那一次派生做过什么，它不是一份等着接回来的会话：把它当主干接开，
          // 人就在一份没人负责的对账单上继续写（D71、D74）。读它仍然走 `session.read` 带那一条支线的编号。
          const branch = /^(.+)\.sub-(\d+)$/.exec(sessionId);
          if (branch !== null) {
            throw new KernelError('session_is_branch', { detail: `${sessionId} is a derived branch of ${branch[1]}; open the parent, or read that record with session.read` });
          }
          // 记录不在磁盘上就是没有这份会话，把它当新的一次空记录打开会让人以为恢复成功了。
          // 形状不对的 id 先报自己那个码，不混进「找不到这份会话」。
          const path = recordPathOf(sessionId, env);
          try {
            await access(path);
          } catch {
            throw new KernelError('session_not_found', { detail: sessionId });
          }
          // 切回已经打开的会话时复用其状态；模式变更仍受当前轮次的边界约束。
          if (sessions.has(sessionId)) {
            const state = open(sessionId);
            if (state.running !== undefined) throw new KernelError('run_already_running', { detail: sessionId });
            if (message.params.mode !== undefined) {
              if (state.environment.modePaths === undefined) throw new KernelError('host_mode_paths_required');
              await state.adopt(await loadMode(message.params.mode, state.environment.modePaths));
            }
            return { sessionId };
          }
          return await buildSession(sessionId, connection, true, message.params.mode, env);
        }
        case 'session.close': {
          const state = open(sessionId);
          // 正在跑的那一轮不由这一次动作收尾：界面要先发 `run.cancel`，这里不暗中打断（D11 那一轮的结果要有人写进记录）。
          if (state.running !== undefined) throw new KernelError('run_already_running', { detail: sessionId });
          await retire(state);
          evictEnvironment(state.environment);
          return { sessionId };
        }
        case 'session.label': {
          const state = open(sessionId);
          const { name, archived } = message.params;
          // 什么都不改的一次调用没有意义，说出来比写一条空事件好。
          if (name === undefined && archived === undefined) throw new KernelError('session_label_empty', { detail: sessionId });
          const trimmed = name?.trim() ?? '';
          // 名字由人写、给列表那一行看：控制字符会把排版弄坏，整条空白不算一个名字（方案 4.2）。
          if (name !== undefined && (trimmed === '' || trimmed.length > SESSION_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))) {
            throw new KernelError('session_name_invalid', { detail: `wanted 1-${SESSION_NAME_MAX} visible characters` });
          }
          await state.session.append({
            kind: 'label',
            ignorable: true,
            ...(name === undefined ? {} : { name: trimmed }),
            ...(archived === undefined ? {} : { archived }),
          });
          return await labelOf(state);
        }
        case 'sessions.list': {
          // 与 `ligule sessions` 走的是同一个扫描器（D73）：协议只是把它递到界面那一边，
          // 记录目录仍然只有宿主这一处开盘。
          const { projectRoot, limit } = message.params;
          return { sessions: await listSessions(await scanDirectory(projectRoot), { projectRoot, limit }) };
        }
        case 'sessions.search': {
          // 第七条只为界面多出来的方法：扫的还是那一处记录目录，与列表同一个开盘处（方案 4.2）。
          // 空白的查询在所有记录里都能对上，那一份结果没有意义，所以在这里就拒掉，不扫一遍磁盘再说。
          const { query, projectRoot, limit } = message.params;
          const needle = query.trim();
          if (needle === '') throw new KernelError('search_query_empty', { detail: 'a search query has to say what to look for' });
          return { hits: await searchSessions(await scanDirectory(projectRoot), { query: needle, projectRoot, limit }) };
        }
        case 'session.read': {
          // 交回的是记录本身：客户端晚到了也能把已经发生过的事画出来（I5）。
          // 历史那一页由 `limit` 与 `before` 说（方案 4.1）：支线那份读的是同一套分页，两个入口不分两种形状。
          const { fullResults, limit, before } = message.params;
          const state = sessions.get(sessionId);
          if (state !== undefined) return await readForClient(state.session, sessionId, { fullResults, limit, before }, state.environment);
          // 派生支线那一份不在这轮的内核里（跑完就把装配撤了，D71），界面读它用的是这同一次动作（D74）。
          // 除这一种之外不读磁盘：这一次动作的语义是「把我这一份会话的事实拿回来」，不是记录目录的浏览器；
          // 发现历史会话归 sessions，接上别的会话归 session.open。
          assertSessionId(sessionId);
          const owner = branchOwner(sessionId);
          if (owner === undefined) throw new KernelError('session_not_open', { detail: sessionId });
          const env = sessions.get(owner)?.environment ?? defaultEnvironment;
          const path = recordPathOf(sessionId, env);
          try {
            await access(path);
          } catch {
            throw new KernelError('session_not_found', { detail: sessionId });
          }
          return await readForClient(createSessionLog({ directory: env.directory, id: sessionId }), sessionId, message.params.fullResults, env);
        }
        case 'run.start': {
          const state = open(sessionId);
          return await execute(state, async (signal) => {
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
          return await state.loop.run(text, { signal, user });
          });
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
          const requested = await loadMode(message.params.name, state.environment.modePaths);
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
            // 名字、说明与参数提示三样交出去，为的是界面上那一串候选：展开仍然只在这地方做一次（D24、D81）。
            templates: state.templates.templates.map(({ command, description, hint }) => ({ command, description, hint })),
            // 上下文压力那一格（D82）：窗口、压力线、当前投影的估算，加上记录里最后一次报回的用量。
            // 没写窗口时整格是 null，画面上那一段就不出现——那不是「还没压到」，是「线还没定」。
            usage: state.compaction === null ? null : await state.compaction.context(),
          };
        }
        case 'config.get': {
          // 边界在「结果由固定四格拼出来」这一句上，不在参数校验上：子集校验放过模式里没声明的键（D14）。
          // 白名单的理由：配置合并除 `__proto__` 之外接受任何键，项目层那一份可能出自别人写的仓库（D8）。
          // 凭据只走环境变量是一条约定，不是拦阻（D13、D60），所以交出整份快照证明不了帧里没有别的东西。
          return shownConfigOf(config);
        }
        case 'session.compact': {
          const state = open(sessionId);
          // 压的是下一次请求要用的那一份投影，正在跑的这一轮的上下文已经在路上：这时候压改变不了它（D83）。
          if (state.running !== undefined) throw new KernelError('compact_turn_running', { detail: sessionId });
          if (state.compaction === null) {
            throw new KernelError('compact_window_unset', { detail: 'limits.contextTokens is not written, so there is no window to compact against' });
          }
          return await execute(state, async (signal) => {
          const done = await state.compaction.compactNow(signal);
          // 压不动只可能是那一种：留下保留预算之后一段里找不到能切的边界。
          if (done === null) throw new KernelError('compact_nothing_to_cut', { detail: sessionId });
          return { sessionId, ...done };
          });
        }
        default:
          // validateCall 已经拦住了不认识的方法，走到这里说明分发表与协议表不是同一份。
          throw new KernelError('protocol_method_unhandled', { detail: message.method });
      }
    },

    // 一条连接断开时把它还占着的那一轮停下来，然后按装配清单的逆序把插件撤掉（I7）。
    release() {
      if (closing !== undefined) return closing;
      const states = [...sessions.values()];
      for (const state of states) {
        if (state.running !== undefined) state.running.abort();
      }
      closing = (async () => {
        const failures = [];
        await Promise.allSettled([...building]);
        const opened = [...sessions.values()];
        for (const state of opened) state.running?.abort();
        const retired = await Promise.allSettled(opened.map((state) => retire(state)));
        for (const result of retired) if (result.status === 'rejected') failures.push(result.reason);
        sessions.clear();
        if (failures.length > 0) throw new AggregateError(failures, 'host_release_failed');
      })();
      return closing;
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
  input.on('end', () => {
    void host.release().catch((error) => rest.logger?.error?.('host release failed', { code: error.code, detail: error.detail }));
  });
  return host;
}
