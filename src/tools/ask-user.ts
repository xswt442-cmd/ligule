// 模型向人提问那一件工具（D107）：一次调用问一到四道题，等真人回答，答完才交回结果。
//
// 参数里的题目写成一段 JSON 文本：内核认下的参数子集（D14）只有标量，没有「对象数组」这一构造，
// 而提问天生是嵌套形状。`mcp.call` 的 `arguments` 走的是同一条路（D52），校验在装载这一侧按声明做，
// 模型可见的模式因此不随客户端形状变化。
//
// 这一件不进审批判定：审批问的是「能不能做这件操作」，提问问的是「这件事该怎么办」，两件事各自一条请求答复链。
import { KernelError } from '../kernel/error.js';

export type AskOption = { label: string; description?: string };
export type AskQuestion = { id: string; question: string; header?: string; options: AskOption[]; multiSelect: boolean };
export type AskAnswer = { id: string; selected: string[]; custom?: string };

// 题数与长度都有上限：一次问八道、每道二十个选项会把两张界面都挤出屏幕，也不让人一次读完。
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_QUESTION = 600;
const MAX_HEADER = 24;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;
const MAX_CUSTOM = 4000;

const text = (value: unknown, limit: number, at: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) {
    throw new KernelError('ask_user_questions_invalid', { detail: `${at} must be a text of 1-${limit} characters` });
  }
  return value;
};

/** 把模型交来的那段题目文本变成规范化的题目清单：编号由这一侧按顺序给，模型说不出重复或漏号的编号。 */
export function checkedQuestions(input: unknown): AskQuestion[] {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new KernelError('ask_user_questions_invalid', { detail: `questions is not JSON text: ${(error as Error).message}` });
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_QUESTIONS) {
    throw new KernelError('ask_user_questions_invalid', { detail: `questions must hold 1-${MAX_QUESTIONS} items` });
  }
  return parsed.map((item, index) => {
    const at = `questions[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new KernelError('ask_user_questions_invalid', { detail: `${at} must be an object` });
    }
    const entry = item as Record<string, unknown>;
    const options = entry.options;
    if (options !== undefined && (!Array.isArray(options) || options.length > MAX_OPTIONS)) {
      throw new KernelError('ask_user_questions_invalid', { detail: `${at}.options must hold at most ${MAX_OPTIONS} items` });
    }
    return {
      id: `q${index + 1}`,
      question: text(entry.question, MAX_QUESTION, `${at}.question`),
      ...(entry.header === undefined ? {} : { header: text(entry.header, MAX_HEADER, `${at}.header`) }),
      options: (options as unknown[] | undefined)?.map((option, position) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) {
          throw new KernelError('ask_user_questions_invalid', { detail: `${at}.options[${position}] must be an object` });
        }
        const choice = option as Record<string, unknown>;
        return {
          label: text(choice.label, MAX_LABEL, `${at}.options[${position}].label`),
          ...(choice.description === undefined ? {} : { description: text(choice.description, MAX_DESCRIPTION, `${at}.options[${position}].description`) }),
        };
      }) ?? [],
      multiSelect: entry.multiSelect === true,
    };
  });
}

/** 客户端交回的答复按题目编号对上：编号对不上的丢掉，一道题都没答就报告这条请求没拿到回答。 */
export function checkedAnswers(questions: readonly AskQuestion[], reply: unknown): AskAnswer[] {
  const items = (reply as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(items)) throw new KernelError('ask_user_answer_invalid', { detail: 'the reply holds no answers array' });
  const byId = new Map(questions.map((question) => [question.id, undefined as AskAnswer | undefined]));
  for (const item of items) {
    const entry = item as { id?: unknown; selected?: unknown; custom?: unknown };
    if (typeof entry.id !== 'string' || !byId.has(entry.id)) continue;
    const selected = Array.isArray(entry.selected) ? entry.selected.filter((one): one is string => typeof one === 'string') : [];
    const custom = typeof entry.custom === 'string' && entry.custom.trim() !== '' ? entry.custom.slice(0, MAX_CUSTOM) : undefined;
    byId.set(entry.id, { id: entry.id, ...(custom === undefined ? { selected } : { selected, custom }) });
  }
  const answers = questions.map((question) => byId.get(question.id)).filter((answer): answer is AskAnswer => answer !== undefined);
  if (answers.length === 0) throw new KernelError('ask_user_answer_invalid', { detail: 'no answer matches any question of this request' });
  return answers;
}

/** 交回给模型的那一段正文：题目与答案配着读，模型不必再从结构化那一格里拼一遍语义。 */
export function answersText(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): string {
  return questions.map((question, index) => {
    const answer = answers.find((one) => one.id === question.id);
    if (answer === undefined) return `${index + 1}. ${question.question}\n没有回答`;
    const chosen = answer.selected.length > 0 ? answer.selected.join('、') : '';
    return `${index + 1}. ${question.question}\n答：${[chosen, answer.custom].filter((one) => one !== '' && one !== undefined).join('；') || '没有选择，也没有补充'}`;
  }).join('\n\n');
}

export interface AskUserToolDeps {
  /** 发起一次请求并等回答：宿主那一侧交出的是那一条链的 promise，取消由 signal 说。 */
  ask: (questions: readonly AskQuestion[], signal?: AbortSignal) => Promise<unknown>;
}

export function createAskUserPlugin(deps: AskUserToolDeps) {
  return {
    name: 'ligule-ask-user',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'ask_user_question',
        // 模式不能把这一件关掉：一次模式写错就让人看不见模型的问题，而这张清单是模型此刻能做什么的披露入口（D63 同一条规则）。
        disclosure: true,
        description: 'Ask the user one to four questions and wait for a real answer. Use it when a choice or missing information blocks the next step; do not guess an answer or scan the user\'s text for one. Pass "questions" as a JSON array text of objects holding "question", optionally "header" (a short label), "options" (up to four objects with "label" and optional "description") and "multiSelect" (true when several choices may be picked). Every question also takes a free-text answer. The result carries the answers in the order you asked.',
        parameters: {
          type: 'object',
          properties: {
            questions: { type: 'string', description: 'A JSON array text of question objects: {"question":"...","header":"...","options":[{"label":"...","description":"..."}],"multiSelect":false}.' },
          },
          required: ['questions'],
        },
        async run(args: { questions?: string }, { signal }: { signal?: AbortSignal } = {}) {
          const questions = checkedQuestions(args.questions);
          const answers = checkedAnswers(questions, await deps.ask(questions, signal));
          return { text: answersText(questions, answers), questions, answers };
        },
      });
    },
  };
}
