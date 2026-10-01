// 项目指令文件（D10）：四层，管理端 < 用户 < 项目根 < 逐目录上溯的目录级规则；
// 越靠近当前目录的那一层越晚装载、优先级越高。文件名只读 `AGENTS.md`。
// 每一层的内容都是注入给模型的，所以整段受 I6 的字节上限约束，超限时在末尾留下一行看得见的说明。
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { KernelError } from './error.js';
import { matchesName } from './match.js';
import { isWithin } from './paths.js';

const FILE_NAME = 'AGENTS.md';

// 排除项按斜杠形式比较，两种系统同一套写法。
const toPosix = (path) => path.split(sep).join('/');

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new KernelError('instructions_read_failed', { cause: error });
  }
}

async function identity(path) {
  try {
    return await realpath(path);
  } catch {
    // 文件在读取与解析真实路径之间消失了，用原路径去重不会造成重复装载。
    return path;
  }
}

// 从当前目录上溯到项目根，逐层看有没有 AGENTS.md。不越过项目根（对照 Codex 的那条硬规则）。
// 「到了根」与「还在根之内」都按同一个依据判：包含关系用入口那一条词法判断，是不是根本身用真实路径，
// 就是下面去重用的同一个 identity。大小写只差一点的两种写法在 Windows 上指同一个目录，
// 用字符串相等判时对不上，上溯会一路走到文件系统根，把项目根之外的 AGENTS.md 读进来（本机实测：九层）。
async function walkUpTo(boundary, current) {
  const found = [];
  const root = resolve(boundary);
  const realRoot = await identity(root);
  let directory = resolve(current);
  while (isWithin(root, directory) && (await identity(directory)) !== realRoot) {
    found.unshift(directory);
    directory = dirname(directory);
  }
  found.unshift(root);
  return found;
}

export async function loadInstructions(options = {}) {
  const { boundary, current = boundary, managed, user, maxBytes = 32_000, exclude = [] } = options;
  if (typeof boundary !== 'string' || boundary === '') throw new KernelError('instructions_boundary_required');
  if (!(maxBytes >= 1)) throw new KernelError('instructions_max_bytes_required');
  // 上溯的起点必须在项目根之内，否则会读到边界之外的规则文件。
  if (!isWithin(resolve(boundary), resolve(current))) throw new KernelError('instructions_current_outside_boundary');

  const layers = [];
  const push = async (layer, path) => {
    if (path === undefined) return;
    const comparable = toPosix(path);
    if ((layer === 'project' || layer === 'directory') && exclude.some((pattern) => matchesName(comparable, toPosix(pattern)))) return;
    const text = await readIfExists(path);
    if (text === undefined) return;
    layers.push({ layer, path, text, key: await identity(path) });
  };

  await push('managed', managed);
  await push('user', user);
  const directories = await walkUpTo(boundary, current);
  for (const [index, directory] of directories.entries()) {
    await push(index === 0 ? 'project' : 'directory', join(directory, FILE_NAME));
  }

  // 同一份内容可能通过符号链接或嵌套仓库被走到两次，按真实路径去重，保留更靠近当前目录的那一次。
  const unique = [];
  for (const file of layers) {
    const duplicate = unique.findIndex((entry) => entry.key === file.key);
    if (duplicate >= 0) unique.splice(duplicate, 1);
    unique.push(file);
  }

  // 上限算在完整结果上：每一段的标题、段间空行与末尾的说明行都算字节（I6）。
  // 标题与说明行里写相对项目根的路径，绝对路径会把预算占满。
  const nameOf = (item) => toPosix(relative(resolve(boundary), item.path ?? item));
  const headingOf = (file) => `## ${nameOf(file)}\n\n`;
  const listed = (files, name) => (files.length <= 3
    ? `${name} ${files.map(nameOf).join(', ')}`
    : `${name} ${files.slice(0, 3).map(nameOf).join(', ')} and ${files.length - 3} more`);
  const markerFor = (keptFiles, omittedFiles, truncatedFiles, detailed) => {
    const notes = [];
    if (omittedFiles.length > 0) {
      notes.push(detailed ? listed(omittedFiles, 'omitted') : `omitted ${omittedFiles.length} file(s)`);
    }
    if (truncatedFiles.length > 0) {
      notes.push(detailed
        ? `truncated ${truncatedFiles.map((item) => `${nameOf(item)} from ${item.from} to ${item.to} bytes`).join(', ')}`
        : `truncated ${truncatedFiles.length} file(s)`);
    }
    return notes.length === 0 ? '' : `\n\n[Instruction budget ${maxBytes} bytes: ${notes.join('; ')}]`;
  };
  const assemble = (keptFiles, omittedFiles, truncatedFiles, detailed) => `${
    keptFiles.map((file) => `${headingOf(file)}${file.text}`).join('\n\n')
  }${markerFor(keptFiles, omittedFiles, truncatedFiles, detailed)}`;

  // 预算从优先级最高的那一份开始占；占不满整份但还剩位置的就截断它，一点位置都不剩的整份丢掉。
  // 先给末尾的说明行留出 MARKER_RESERVE 字节：不留的话最后占位的那一份会把预算用光，
  // 再被说明行挤出去，内容反而全丢了。
  const MARKER_RESERVE = 96;
  const kept = [];
  const omitted = [];
  const truncated = [];
  let used = 0;
  for (const file of [...unique].reverse()) {
    const separator = used > 0 ? 2 : 0;
    const heading = Buffer.byteLength(headingOf(file), 'utf8');
    const bytes = Buffer.byteLength(file.text, 'utf8');
    const room = maxBytes - MARKER_RESERVE - used - separator - heading;
    if (room < 1) {
      omitted.unshift(file);
      continue;
    }
    if (bytes <= room) {
      kept.unshift(file);
      used += separator + heading + bytes;
      continue;
    }
    const note = `\n[truncated from ${bytes} bytes]`;
    const budget = room - Buffer.byteLength(note, 'utf8');
    if (budget < 1) {
      omitted.unshift(file);
      continue;
    }
    let head = Buffer.from(file.text, 'utf8').subarray(0, budget).toString('utf8');
    while (Buffer.byteLength(head, 'utf8') > budget) head = head.slice(0, -1);
    // 切在一个多字节字符中间时那半个字符留不住，实际留下的比预算少：标记与用量都按实际的算。
    const keptBytes = Buffer.byteLength(head, 'utf8');
    kept.unshift({ ...file, text: `${head}${note}` });
    truncated.unshift({ path: file.path, from: bytes, to: keptBytes });
    used += separator + heading + keptBytes + Buffer.byteLength(note, 'utf8');
  }

  // 说明行本身也要位置。顺序是：先把说明行压成计数形式，还不够再丢最低优先级的内容——
  // 内容比「描述丢了什么」的那段话更该占预算。
  let detailed = true;
  let text = assemble(kept, omitted, truncated, detailed);
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    if (detailed) {
      detailed = false;
    } else if (kept.length > 0) {
      omitted.unshift(kept.pop());
    } else {
      break;
    }
    text = assemble(kept, omitted, truncated, detailed);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    // 连计数形式的说明行都放不下：按字节切，宁可留下一段看得见的残缺说明，也不静默交回空文本。
    let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
    while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, -1);
    text = cut;
  }
  return { text, files: kept.map((file) => ({ path: file.path, layer: file.layer })) };
}
