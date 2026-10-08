// 工具结果的统一形状（D19）：内容、是否失败、错误码、拒绝理由分开，调用方按类别与码分支，不读文案。
// 失败是工具自己没做成，拒绝是判定链没让做，两类混在一起就统计不到误拦截。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelRuntimeError } from './error.js';

export function resultOf(content, extra) {
  return { kind: 'result', failed: false, code: undefined, reason: undefined, content, ...extra };
}

// 拒绝理由进 reason，不进 content：理由给人看，content 是给模型的那一份。
export function refusalOf(code, reason) {
  return { kind: 'refusal', failed: true, code, reason, content: '' };
}

export function failureOf(code, extra) {
  return { kind: 'failure', failed: true, code, reason: undefined, content: '', ...extra };
}

// 工具交回的内容注入给模型之前的字节上限，起点值由本项目自定，配置层可以覆盖。
export const DEFAULT_RESULT_BYTES = 16_000;

export function resultLimit(config) {
  return config.limits?.resultBytes ?? DEFAULT_RESULT_BYTES;
}

// 超限的内容改为可取回的引用：完整那一份另存一个文件，交回的文本留头尾与一行说明（I6、D19）。
// 上限算在包括标记在内的完整结果上，所以先算标记要占的字节，再决定头尾各留多少。
// 那一个文件名要按这一串查过才敢读回来：名字出自记录，而记录里的东西不能拼出走到目录外面去的路（D85）。
export const SPILL_NAME = /^result-\d+-[a-f0-9]{8}\.json$/;

export async function spillContent(text, { limit, directory, name }) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  const note = `\n[omitted: full output is ${bytes.length} bytes, kept in ${name}]\n`;
  const budget = Math.max(0, limit - Buffer.byteLength(note, 'utf8'));
  const half = Math.floor(budget / 2);
  // 会话记录可能还没写过任何东西，目录这时还不存在，先建再写。
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), text, 'utf8');
  } catch (error) {
    // 完整那一份存不下去就没有可取回的引用，交回截断文本等于把内容丢了，按内核自身的故障停住。
    throw new KernelRuntimeError('session_spill_failed', { cause: error });
  }
  // 按字节切可能把多字节字符切成一半，Node 用一个替换符顶上那残缺的几字节，而它占三字节，两头各多出一点来。
  // 上限算在完整结果上，所以把那两头不成字符的残余去掉，留在记录里的那一段才真的不超过 limit。
  return `${bytes.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '')}${note}${bytes.subarray(bytes.length - half).toString('utf8').replace(/^\uFFFD+/, '')}`;
}
