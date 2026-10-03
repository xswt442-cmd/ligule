// 技能那一件固定元工具（D50、D55、D56）：模型长期只看到 `skill` 一件，动作是 search、activate、read 三种。
// 动作名写成普通字符串加运行期校验，而不是参数模式里的 enum：内核认的参数子集只有那几种构造（D14），
// 而合法与否本来就该在这一侧查——这里也是唯一看得见注册表真实状态的地方（D52 同一条理由）。
// 三个动作的结果各自受 D55 的字节上限约束，注入那一层的总量上限（D19）仍然在它之上。
import { marker } from './common.js';
import { limitsOf } from '../capability/limits.js';
import { KernelError } from '../kernel/error.js';
import { listSkillFiles, readSkillBody, readSkillFile, searchSkills } from '../kernel/skills.js';
import type { SkillEntry, SkillRegistry } from '../kernel/skills.js';

const ACTIONS = ['search', 'activate', 'read'];

// 能力在不在按这一次运行真的交给模型的那一份清单判（I2）：被模式藏起来的工具满足不了声明，
// 正如声明本身产生不了工具（D51）。`mcp:` 前缀的那种要等 MCP 接上（D60），在那之前一律算缺。
function hasCapability(token: string, visible: string[]): boolean {
  return token.startsWith('mcp:') ? false : visible.includes(token);
}

function capped(text: string, maxBytes: number, detail: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let kept = bytes.subarray(0, maxBytes).toString('utf8');
  // 切在多字节字符中间时那半个字符留不住，标记与用量都按实际留下的算。
  while (Buffer.byteLength(kept, 'utf8') > maxBytes) kept = kept.slice(0, -1);
  return `${kept}${marker(detail)}`;
}

async function namedSkill(registry: SkillRegistry, name: unknown): Promise<SkillEntry> {
  if (typeof name !== 'string' || name === '') {
    throw new KernelError('skill_name_required', { detail: 'activate and read take the skill name' });
  }
  const skill = registry.skills.find((item) => item.name === name);
  if (skill === undefined) {
    throw new KernelError('skill_unknown', { detail: `no loaded skill is named ${name}; use action "search" to find one` });
  }
  return skill;
}

// visibleTools 由装载侧的插件闭包递进来：判定要看的是这一次运行的真实状态，不是配置里写过什么。
export function createSkillTool(registry: SkillRegistry, visibleTools: () => string[]) {
  return {
    name: 'skill',
    description: 'Load packaged instructions kept on disk. action "search" needs a query, action "activate" needs a name, '
      + 'action "read" needs a name and a file path inside that skill. Loading a skill grants no tool and changes no permission.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of search, activate, read.' },
        query: { type: 'string', description: 'Words to rank skill names and descriptions by, for action "search".' },
        name: { type: 'string', description: 'Skill name, for action "activate" or "read".' },
        path: { type: 'string', description: 'File inside that skill directory, for action "read".' },
        offsetBytes: { type: 'integer', minimum: 0, description: 'Byte offset to continue from after a truncation, for action "read".' },
      },
      required: ['action'],
    },
    async run(args: { action: string; query?: string; name?: string; path?: string; offsetBytes?: number }, { config }: { config: Record<string, unknown> }) {
      const { resultCount, skillSearchBytes, skillBodyBytes, skillFileBytes } = limitsOf(config);
      if (!ACTIONS.includes(args.action)) {
        throw new KernelError('skill_action_invalid', { detail: `action must be one of ${ACTIONS.join(', ')}` });
      }
      if (args.action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim() === '') {
          throw new KernelError('skill_query_required', { detail: 'action "search" takes a query' });
        }
        const found = searchSkills(registry.skills, args.query);
        if (found.length === 0) {
          return { text: `no skill matches "${args.query}" among ${registry.skills.length} loaded` };
        }
        return { text: capped(found.map((skill, index) => `${index + 1}. ${skill.name}: ${skill.description}`).join('\n'),
          skillSearchBytes, `truncated: search results are longer than ${skillSearchBytes} bytes, narrow the query`) };
      }
      const skill = await namedSkill(registry, args.name);
      if (args.action === 'activate') {
        const missing = skill.requires.filter((token) => !hasCapability(token, visibleTools()));
        if (missing.length > 0) {
          throw new KernelError('skill_missing_capability', {
            detail: `${skill.name} requires ${missing.join(', ')}, none of which is available; loading a skill grants nothing`,
          });
        }
        const { body, bytes, digest } = await readSkillBody(skill);
        const size = Buffer.byteLength(body, 'utf8');
        // 超限报错而不是截断（D55）：说明少一半只会让模型照着做出一份失败的调用，而作者不在这个界面上。
        if (size > skillBodyBytes) {
          throw new KernelError('skill_too_large', {
            detail: `${skill.name} carries ${size} bytes of instructions and the cap is ${skillBodyBytes}; `
              + 'move the long parts into files that action "read" can take',
          });
        }
        const { files, more } = await listSkillFiles(skill, resultCount);
        const listed = files.length === 0 ? '' : `\nSupporting files: ${files.join(', ')}${more ? ', and more' : ''}`;
        return { text: `Skill "${skill.name}" activated from ${skill.root} (${bytes} bytes, digest ${digest}).${listed}\n\n${body}` };
      }
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new KernelError('skill_path_required', { detail: 'action "read" takes a path inside that skill directory' });
      }
      const content = await readSkillFile(skill, args.path);
      const offset = args.offsetBytes ?? 0;
      const slice = content.subarray(offset, offset + skillFileBytes);
      const left = content.length - offset - slice.length;
      return {
        text: slice.toString('utf8')
          + (left > 0 ? marker(`truncated: ${slice.length} of ${content.length - offset} bytes shown, continue with offsetBytes=${offset + slice.length}`) : ''),
      };
    },
  };
}

export function createSkillPlugin(registry: SkillRegistry) {
  return {
    name: 'ligule-skills',
    setup(kernel: { manifest(): { name: string }[]; register(tool: unknown): () => void }) {
      return kernel.register(createSkillTool(registry, () => kernel.manifest().map((tool) => tool.name)));
    },
  };
}
