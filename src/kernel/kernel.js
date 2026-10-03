// 内核的工具表从空开始：新建的内核不提供任何能力（I1），它所能做的一切都由 register() 登记进来。
//
// 内核不引入传输层、界面框架和适配器。命令行与桌面壳是同一个对象之上的适配器，
// 新增一个适配器不改动这里的任何一行。
import { randomUUID } from 'node:crypto';
import { KernelError } from './error.js';
import { createConfig } from './config.js';
import { createLogger } from './log.js';
import { failureOf, refusalOf, resultLimit, resultOf, spillContent } from './result.js';
import { createObservationLog } from '../session/observe.js';
import { resolveTarget } from '../capability/network.js';
import { assertSupportedSchema, validateArgs } from './schema.js';

// options.config 是装载侧折好的配置快照，options.logger 是宿主自己的日志后端（D8、D26），
// options.policy 是这条调用要过的判定链（D15），options.session 是这次运行的会话记录（D11）。
// 不传判定链时内核只查登记表与拒绝集，不传会话记录时调用不落盘。
export function createKernel(options = {}) {
  const config = options.config ?? createConfig({});
  // 快照必须是 createConfig 折出来的那一份：工具读到的是同一个对象，宿主之后改不动它。
  if (!Object.isFrozen(config)) throw new KernelError('config_snapshot_must_be_frozen');
  const policy = options.policy;
  const session = options.session;
  const logger = createLogger(options.logger);
  // 本次运行的文件观察记录，与工具表同寿：读过的文件登记在这里，覆盖之前要对上它（D3）。
  const observations = createObservationLog();
  const context = Object.freeze({ config, logger, observations });

  const tools = new Map();
  // 宿主交给内核的按工具名拒绝集。每一项由一次 restrict() 追加，可以重叠。
  const restrictions = [];

  function isDenied(name) {
    return restrictions.some((denied) => denied.has(name));
  }

  // 注入给模型的这一份受字节上限约束，超限时完整内容另存一个文件，记录里留下可取回的引用（D19、I6）。
  async function withinLimit(result) {
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const limit = resultLimit(config);
    if (Buffer.byteLength(text, 'utf8') <= limit) return result;
    const name = `result-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    return { ...result, content: await spillContent(text, { limit, directory: session.directory, name }), spilled: name };
  }

  async function record(entry, result) {
    if (!session) return;
    await session.append({ ...entry, result: await withinLimit(result) });
  }

  // 失败记进会话再抛出去：码给调用方分支，detail 是给模型看的那一份说明（D19）。
  async function fail(entry, error) {
    await record(entry, failureOf(error.code, error.detail === undefined ? undefined : { content: error.detail }));
    throw error;
  }

  return {
    // 本次运行登记了哪些工具，从这一处读出（I2）。
    list() {
      return [...tools.keys()].sort();
    },

    // 模式能从哪几件里挑：登记表里去掉固定披露入口（D63）。被模式藏起来不该是一种可能，
    // 否则默认档位下模型连发现技能的入口都没有，而注册表里明明有东西。
    selectable() {
      return [...tools.values()].filter((tool) => !tool.disclosure).map((tool) => tool.name).sort();
    },

    // 循环按这一条决定分组：没有声明、或者登记名不存在，一律按串行处理（D29）。
    execution(name) {
      return tools.get(name)?.execution ?? 'serial';
    },

    // 登记返回反注册动作。重名是错误，不覆盖前一个，也不丢弃后一个。
    register(tool) {
      if (!tool || typeof tool.name !== 'string' || tool.name === '') {
        throw new KernelError('tool_name_required');
      }
      if (typeof tool.description !== 'string' || tool.description === '') {
        throw new KernelError('tool_description_required');
      }
      if (typeof tool.run !== 'function') {
        throw new KernelError('tool_run_required');
      }
      // 参数模式顶层必须是对象，这条判据由本项目写进内核（D14）。
      const schema = tool.parameters;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new KernelError('tool_parameters_must_be_object');
      }
      if (schema.type !== 'object') {
        throw new KernelError('tool_parameters_type_not_object');
      }
      if (tools.has(tool.name)) {
        throw new KernelError('tool_already_registered');
      }
      let parameters;
      try {
        // 存下与插件那个对象断开的一份拷贝：插件之后修改自己交出的模式，改动不到已登记的清单。
        parameters = structuredClone(schema);
      } catch {
        // structuredClone 对函数和 Symbol 抛 DataCloneError，这样的模式与 JSON 不能无损往返。
        throw new KernelError('tool_parameters_not_serializable');
      }
      // 检查的是要存下的那一份：模式只能用受控子集里的构造，子集之外的当场拒（D14）。
      assertSupportedSchema(parameters);
      // 只留名字、描述、参数模式那三项，插件附带的其他字段进不了模型可见清单（D12）。
      // 执行策略声明按工具名留在内核这一侧，循环读它，模型看不见（D29、I3）。
      // 披露入口也留在内核这一侧：固定那几件工具由注册表里有没有内容决定，不进模式的选择范围（D63）。
      // 哪个参数是要取回的目标同样留在内核这一侧：判定链看的是解析之后的地址类别，不是模型写的字符串（D58）。
      const entry = {
        name: tool.name,
        description: tool.description,
        parameters,
        execution: tool.execution === 'parallel' ? 'parallel' : 'serial',
        disclosure: tool.disclosure === true,
        targetArgument: typeof tool.targetArgument === 'string' ? tool.targetArgument : undefined,
        run: tool.run,
      };
      tools.set(tool.name, entry);
      return () => {
        // 只撤销自己这一次登记：同名工具被再次登记之后，旧的卸载动作不能删掉新的那一个。
        if (tools.get(tool.name) === entry) tools.delete(tool.name);
      };
    },

    // 被拒绝的工具在生成清单之前删掉。每项的 parameters 是新拷贝，调用方修改影响不到内核保存的那份。
    manifest() {
      return [...tools.values()]
        .filter((tool) => !isDenied(tool.name))
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        }));
    },

    // 拒绝只收紧：后一次 restrict() 不撤销前一次的拒绝，卸载自己这一项也不解除重叠的那一份。
    // 名字对不上任何已登记工具时什么都不拦，规则表可以写出本次运行没有装载的工具。
    restrict(names) {
      const denied = new Set(names);
      restrictions.push(denied);
      return () => {
        // 重复卸载只撤销自己那一项，不能删掉别的 restrict() 追加的拒绝。
        const index = restrictions.indexOf(denied);
        if (index >= 0) restrictions.splice(index, 1);
      };
    },

    // 每次失败都带一个让调用方可以分支的稳定错误码（I9）。
    // 工具从第二个参数的 context 里读配置快照与日志接口，不自己去拿（D8、D26）；
    // options.signal 是这次调用的取消边界，由循环或适配器交进来（D20）。
    // 判定链在这一步上，所以没有任何一条执行路径绕得开它；每一次拒绝、失败与成功都进会话记录。
    async call(name, args, options = {}) {
      // options.callId 是模型那一次调用的 id，进记录用来把工具结果挂回助手那一轮（D11、D13）。
      const entry = { kind: 'tool', tool: name, callId: options.callId, args };
      const tool = tools.get(name);
      if (!tool) {
        // 没登记的名字也要留下一条结果：助手那一轮已经带着这次调用，记录里少一条跟它的 id 对上，
        // 下一次请求体里那个调用就悬空，端点会把整份请求拒掉，而代价只是模型打错了一个名字。
        // 参照实现同样是交回一条错误结果而不是抛一个没人接收的异常（Cline 的循环）。
        await fail(entry, new KernelError('tool_not_found', { detail: `no tool named "${name}" is registered for this run` }));
      }
      if (isDenied(name)) {
        await record(entry, refusalOf('tool_denied', 'the tool is restricted for this run'));
        throw new KernelError('tool_denied');
      }
      // 参数校验排在判定链之前：形状不对的调用不是一次有意义的调用，
      // 送去询问只会让用户为一次注定失败的调用做决定，也不该把拒绝计数推上去。
      const violations = validateArgs(tool.parameters, args);
      if (violations.length > 0) {
        await fail(entry, new KernelError('tool_args_invalid', { detail: violations.join('; ') }));
      }
      // 目标地址在这里解析一次：判定链判断的就是这一次解析出的地址，工具随后连的也是这几个地址（D58）。
      // 分两次解析的话，链条批准了一个 IP 而连接自己又查一次 DNS，两次可以不是同一个地址。
      const network = tool.targetArgument === undefined || typeof args?.[tool.targetArgument] !== 'string'
        ? undefined
        : await resolveTarget(args[tool.targetArgument]);
      if (policy) {
        const verdict = await policy.evaluate({ tool: name, input: args, target: network });
        if (verdict.decision !== 'allow') {
          // 拒绝理由进日志与记录，抛出去的那一份只带错误码（D19 把文本与码分开）。
          logger.log(`tool ${name} is not allowed`, { tool: name, code: verdict.code, reason: verdict.reason });
          await record(entry, refusalOf(verdict.code, verdict.reason));
          throw new KernelError(verdict.code);
        }
      }
      let value;
      try {
        value = await tool.run(args, { ...context, signal: options.signal, target: network });
      } catch (error) {
        // 工具没把错误包成内核错误码时由内核接住：统一成一个稳定码，原始错误进 cause，
        // 它自己的消息作为给模型看的那一份说明。半成品工具抛出的异常不该停住循环，
        // 所以这一类同样作为一条失败事件进会话记录，模型下一轮看得见（D19、D20）。
        const failure = error instanceof KernelError
          ? error
          : new KernelError('tool_failed', { cause: error, detail: typeof error?.message === 'string' ? error.message : undefined });
        await fail(entry, failure);
      }
      await record(entry, resultOf(value));
      return value;
    },
  };
}
