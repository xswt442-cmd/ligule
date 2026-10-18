// `ask_user_question` 向用户提出一至四个问题，并等待答复后返回结果。
//
// 问题以 JSON 文本传递，因为 Kernel 参数模式子集不支持嵌套对象数组。
// MCP 工具参数也使用相同文本形式，由 Host 根据工具声明校验。
//
// 提问与审批使用不同请求和答复流程：审批判断是否允许操作，提问收集用户信息。
import { KernelError } from '../kernel/error.js';

export type AskOption = { label: string; description?: string };
export type AskQuestion = { id: string; question: string; header?: string; options: AskOption[]; multiSelect: boolean };
export type AskAnswer = { id: string; selected: string[]; custom?: string };

// 限制问题数、每题选项数和文本长度，确保请求可读且界面能够显示。
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

/** 解析并规范化模型提供的问题，由此处生成顺序 ID，避免编号重复或缺失。 */
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

/** 按题目 ID 匹配客户端答复；忽略未知 ID，且没有任何有效答复时返回未回答错误。 */
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

/** 将问题和答案组合成模型可读的文本，避免模型重复解释结构化字段。 */
export function answersText(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): string {
  return questions.map((question, index) => {
    const answer = answers.find((one) => one.id === question.id);
    if (answer === undefined) return `${index + 1}. ${question.question}\n没有回答`;
    const chosen = answer.selected.length > 0 ? answer.selected.join('、') : '';
    return `${index + 1}. ${question.question}\n答：${[chosen, answer.custom].filter((one) => one !== '' && one !== undefined).join('；') || '没有选择，也没有补充'}`;
  }).join('\n\n');
}

export interface AskUserToolDeps {
  /** 向客户端发送问题并等待答复；signal 取消时结束等待。 */
  ask: (questions: readonly AskQuestion[], signal?: AbortSignal) => Promise<unknown>;
}

export function createAskUserPlugin(deps: AskUserToolDeps) {
  return {
    name: 'ligule-ask-user',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'ask_user_question',
        access: 'interaction',
        // 提问工具是固定交互入口，不受模式筛选，避免模式配置错误导致用户无法回答模型问题。
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
