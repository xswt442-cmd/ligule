// 技能通过固定的 `skill` 工具访问，支持 `search`、`activate` 和 `read` 三种动作。
// 动作名称使用运行时校验，因为 Kernel 参数模式子集不支持 enum；此处还会核对当前登记表。
// 每种动作结果受各自字节上限限制，之后还要遵守总工具结果上限。
import { marker } from './common.js';
import { limitsOf } from '../capability/limits.js';
import { KernelError } from '../kernel/error.js';
import { listSkillFiles, readSkillBody, readSkillFile, searchSkills } from '../kernel/skills.js';
import type { SkillEntry, SkillRegistry } from '../kernel/skills.js';

const ACTIONS = ['search', 'activate', 'read'];

// 所需能力必须属于当前模式实际提供给模型的工具集合；声明依赖本身不会创建工具。
// `mcp:<server>` 只检查服务器配置是否存在，不会启动服务器进程。
function hasCapability(token: string, visible: string[], mcpServers: string[]): boolean {
  if (token.startsWith('mcp:')) return mcpServers.includes(token.slice('mcp:'.length));
  return visible.includes(token);
}

function capped(text: string, maxBytes: number, detail: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let kept = bytes.subarray(0, maxBytes).toString('utf8');
  // 字节截断可能切开多字节字符；预算和标记长度按最终文本计算。
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

// `visibleTools` 由 Host 提供，反映当前运行中实际可用的工具。
export function createSkillTool(registry: SkillRegistry, visibleTools: () => string[], mcpServers: () => string[] = () => []) {
  return {
    name: 'skill',
  readOnly: true,
    // 技能工具是固定披露入口，不受模式筛选；有已登记技能时始终可用。
    disclosure: true,
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
        const missing = skill.requires.filter((token) => !hasCapability(token, visibleTools(), mcpServers()));
        if (missing.length > 0) {
          throw new KernelError('skill_missing_capability', {
            detail: `${skill.name} requires ${missing.join(', ')}, none of which is available; loading a skill grants nothing`,
          });
        }
        const { body, bytes, digest } = await readSkillBody(skill);
        const size = Buffer.byteLength(body, 'utf8');
        // 超限时返回错误，不截断说明，以免模型根据残缺内容生成无效调用。
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

export function createSkillPlugin(registry: SkillRegistry, mcpServers: () => string[] = () => []) {
  return {
    name: 'ligule-skills',
    setup(kernel: { manifest(): { name: string }[]; register(tool: unknown): () => void }) {
      return kernel.register(createSkillTool(registry, () => kernel.manifest().map((tool) => tool.name), mcpServers));
    },
  };
}
