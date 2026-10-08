// 一轮循环（D20、D29）：迭代上限与模型调用预算在内核这一侧，取消边界是一条 AbortSignal，
// 「哪个工具算完成本轮」由宿主按工具名持有（D12 的模型可见白名单里没有它，与 D16 同一分工）。
// 提供方接口只定形状（D13）：接入走自己写的最小 HTTP 客户端，服务地址从配置读、凭据从环境变量读。
import { KernelError, KernelRuntimeError } from './error.js';
import { usageEvent } from '../session/usage.js';
import { failureOf } from './result.js';

export const DEFAULT_LOOP_LIMITS = Object.freeze({ iterations: 32, modelCalls: 64 });

// 相邻的并发调用合成一组同时开始，串行调用自成一组、构成前后边界（D29）。
function groupCalls(calls, executionOf) {
  const groups = [];
  for (const call of calls) {
    const parallel = executionOf(call.name) === 'parallel';
    const last = groups[groups.length - 1];
    if (parallel && last?.parallel) last.calls.push(call);
    else groups.push({ parallel, calls: [call] });
  }
  return groups;
}

// 从 groups[groupIndex] 这一组的第 index 条之后算起，交出还没有执行的那些调用。
function restOf(groups, groupIndex, index = -1) {
  return groups.slice(groupIndex).flatMap((group, offset) => group.calls.slice(offset === 0 ? index + 1 : 0));
}

export function createLoop({ kernel, provider, prompt, session, limits = DEFAULT_LOOP_LIMITS, completesRun = [], compaction = null, turnContext = null }) {
  if (typeof provider?.stream !== 'function') throw new KernelError('loop_provider_required');
  const completing = new Set(completesRun);

  return {
    // signal 由适配器或上层交进来；每一轮自己再派生一个取消令牌，工具、提供方与本循环看到的是同一次取消。
    // options.user 是宿主交进来的那一条用户记录的附加字段（模板展开时是原始调用、参数、来源与摘要，D54）：
    // 循环只把它们并进记录，模型看见的仍然是 input 那一份文本。
    async run(input, { signal, user } = {}) {
      const controller = new AbortController();
      const forward = () => controller.abort();
      signal?.addEventListener('abort', forward, { once: true });
      let calls = 0;
      let text = '';

      // 许出去却没执行的调用要留下一条结果：请求体里每个工具调用都要有对应的结果顶着，
      // 少一条，端点把整份请求拒掉，而这一轮之后每一轮都拼不出合法请求。
      // 同一种情形下也记一条错误结果：留着没人回答，之后每一轮都拼不出合法的请求体。
      async function answerRemaining(skipped, content) {
        if (!session) return;
        for (const call of skipped) {
          await session.append({
            kind: 'tool', tool: call.name, callId: call.id, args: call.args,
            result: failureOf('tool_skipped', { content }),
          });
        }
      }

      // 这一轮的用户输入同样进记录：模型看见的每一条都要能从记录重建出来（I5）。
      // 它的序号就是这一轮的身份证：轮次完成标记与分支选点都指着它（实现顺序第 68 步）。
      let userSeq;
      if (session) userSeq = (await session.append({ kind: 'user', text: input, ...user })).seq;
      // 开轮时生效的那一份参数冻进记录（D104）：轮中改了模型或档位，事后也读得出这一轮当时用的是哪一份。
      // 它不进模型投影也不进检查点哈希（`PROJECTED_KINDS` 是白名单），界面按事件序号读它。
      if (session && turnContext !== null) await session.append({ kind: 'turnContext', ignorable: true, userSeq, ...turnContext() });

      // 一轮正常完整结束时留下一条事实（D88 之外的界面契约要的是「这一轮真的收尾了」，
      // 不是「最后一条助手消息出现了」）。取消、失败、上限与恢复补写都走不到这一行。
      // 这一条不进模型投影，也不进检查点那一段哈希的输入；它带 `ignorable`，旧版本读得懂。
      async function markTurn(iteration, completedBy) {
        if (!session || userSeq === undefined) return;
        await session.append({
          kind: 'turn', ignorable: true, status: 'completed', userSeq,
          iterations: iteration, modelCalls: calls,
          ...(completedBy === undefined ? {} : { completedBy }),
        });
      }

      try {
        for (let iteration = 1; iteration <= limits.iterations; iteration += 1) {
          if (calls >= limits.modelCalls) throw new KernelError('loop_model_budget_exhausted');
          calls += 1;

          const events = [];
          const system = prompt?.render() ?? '';
          const tools = kernel.manifest();
          let messages = session ? await session.modelView() : [{ role: 'user', text: input }];
          // 压力那一条触发在请求拼好之后、发出去之前：宿主交进来的那一件量一次，越线就先压一次再重拼（D75）。
          if (compaction !== null) messages = await compaction.prepare({ system, tools, messages }, controller.signal);
          // 流式接收期间就开始拼装工具调用（D13）。
          for (let attempt = 0; ; attempt += 1) {
            try {
              for await (const event of provider.stream({ system, tools, messages }, { signal: controller.signal })) {
                events.push(event);
              }
              break;
            } catch (error) {
              // 超长那一条只在端点报回之后走，而整个运行只允许一次压缩加一次重试（D75）：
              // 压不成、已经压过一次、或者不是超长，都让原来那个错误说话。
              const retried = attempt === 0 && compaction !== null
                ? await compaction.recover(error, { system, tools, messages }, controller.signal)
                : null;
              if (retried === null) throw error;
              events.length = 0;
              messages = retried;
            }
          }
          // 端点交回的真实用量用来修正本地估算：没有这一句，压力那一条可能永远不响。
          // 这一句同时也是把那一格落进记录的地方（D82）：界面与恢复都从记录读它，不读内存。
          if (compaction !== null) await compaction.observe({ system, tools, messages }, events);
          else if (session !== undefined) {
            const usage = usageEvent({ system, tools, messages }, events);
            if (usage !== null) await session.append(usage);
          }

          text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
          const reasoning = events.filter((event) => event.type === 'reasoning').map((event) => event.text).join('');
          const toolCalls = events
            .filter((event) => event.type === 'tool-call')
            .map((event) => ({ id: event.id, name: event.name, args: event.args ?? {} }));
          // 推理段进记录，不进投影（D32）：它是这一轮真的发生过的事，界面与重开时要能看见，
          // 而下一轮的请求体里没有它的位置，进了投影就是每轮重复占一份上下文。
          if (session && reasoning !== '') await session.append({ kind: 'reasoning', text: reasoning });
          if (session) await session.append({ kind: 'assistant', text, toolCalls });
          if (toolCalls.length === 0) {
            await markTurn(iteration);
            return { text, iterations: iteration, modelCalls: calls };
          }

          const groups = groupCalls(toolCalls, (name) => kernel.execution(name));
          for (const [groupIndex, group] of groups.entries()) {
            const settled = await Promise.allSettled(
              group.calls.map((call) => kernel.call(call.name, call.args, { signal: controller.signal, callId: call.id })),
            );
            for (const [index, outcome] of settled.entries()) {
              // 工具没做成都已经由内核包成稳定码并记进会话，循环带着这条失败继续问模型；
              // 停住这一轮的只有内核自身的故障，以及不属于内核错误的意外（那是缺陷，不吞）。
              const reason = outcome.reason;
              if (outcome.status === 'rejected' && (!(reason instanceof KernelError) || reason instanceof KernelRuntimeError)) {
                throw reason;
              }
              if (outcome.status === 'fulfilled' && completing.has(group.calls[index].name)) {
                // 这一轮算完成了，同一条助手消息里后面的那些调用就再也不会有机会执行：同样逐条留下不执行的结果。
                const name = group.calls[index].name;
                await answerRemaining(restOf(groups, groupIndex, index), `${name} ended this round before this call ran`);
                await markTurn(iteration, name);
                return { text, completedBy: name, iterations: iteration, modelCalls: calls };
              }
            }
            if (controller.signal.aborted) {
              // 取消落在两组之间：后面那几组已经在助手那一条里许出去了，但把它们执行一遍是错的——
              // 用户按的就是停，插件那一个工具未必看信号。留下不执行的结果，理由是给模型看的那一份。
              await answerRemaining(restOf(groups, groupIndex + 1), 'the run was cancelled before this call ran');
              throw new KernelError('loop_cancelled');
            }
          }
        }
        throw new KernelError('loop_iteration_limit');
      } finally {
        signal?.removeEventListener('abort', forward);
      }
    },
  };
}
