// 一轮循环（D20、D29）：迭代上限与模型调用预算在内核这一侧，取消边界是一条 AbortSignal，
// 「哪个工具算完成本轮」由宿主按工具名持有（D12 的模型可见白名单里没有它，与 D16 同一分工）。
// 提供方接口只定形状（D13）：接入走自己写的最小 HTTP 客户端，服务地址从配置读、凭据从环境变量读。
import { KernelError, KernelRuntimeError } from './error.js';
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

export function createLoop({ kernel, provider, prompt, session, limits = DEFAULT_LOOP_LIMITS, completesRun = [] }) {
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
      if (session) await session.append({ kind: 'user', text: input, ...user });

      try {
        for (let iteration = 1; iteration <= limits.iterations; iteration += 1) {
          if (calls >= limits.modelCalls) throw new KernelError('loop_model_budget_exhausted');
          calls += 1;

          const events = [];
          // 流式接收期间就开始拼装工具调用（D13）。
          for await (const event of provider.stream(
            {
              system: prompt?.render() ?? '',
              tools: kernel.manifest(),
              messages: session ? await session.modelView() : [{ role: 'user', text: input }],
            },
            { signal: controller.signal },
          )) events.push(event);

          text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
          const reasoning = events.filter((event) => event.type === 'reasoning').map((event) => event.text).join('');
          const toolCalls = events
            .filter((event) => event.type === 'tool-call')
            .map((event) => ({ id: event.id, name: event.name, args: event.args ?? {} }));
          // 推理段进记录，不进投影（D32）：它是这一轮真的发生过的事，界面与重开时要能看见，
          // 而下一轮的请求体里没有它的位置，进了投影就是每轮重复占一份上下文。
          if (session && reasoning !== '') await session.append({ kind: 'reasoning', text: reasoning });
          if (session) await session.append({ kind: 'assistant', text, toolCalls });
          if (toolCalls.length === 0) return { text, iterations: iteration, modelCalls: calls };

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
