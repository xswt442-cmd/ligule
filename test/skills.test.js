// 第 23 步的验收（D45、D49 到 D57）：四个目录的先后与同名诊断、头部的 schema 校验、预算内联与超预算的回落、
// `skill` 三个动作各自的边界与限额、缺能力时什么都不改，以及目录真的进到交给模型的那一份请求里。
// 目录、文件、内核与记录都是真的，提供方只用来把请求体交回来看见 tools 那一栏与 system 那一段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS, MESSAGES_CAPABILITIES, DEFAULT_MODE, SKILL_METADATA_BUDGET_BYTES,
  createConnection, createConfig, createKernel, createMemoryConnectionPair, createSessionLog, createSkillPlugin,
  discoverSkills, formatSkillCatalog, loadAssembly, minimalPlugin, modeDirectories, searchSkills,
  serveHost, skillDirectories,
} from '../dist/index.js';

const shippedModes = fileURLToPath(new URL('../modes/', import.meta.url));
// 四个来源目录在临时根下的相对写法，先后与 src/kernel/skills.ts 那一条一致（D57）。
const SOURCES = [
  join('project', '.ligule', 'skills'),
  join('project', '.agents', 'skills'),
  join('home', '.ligule', 'skills'),
  join('home', '.agents', 'skills'),
];

async function withSkills(run) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-skills-'));
  try {
    return await run({
      root,
      directories: skillDirectories(join(root, 'project'), join(root, 'home')),
      place: async (index, name, text) => {
        const directory = join(root, SOURCES[index], name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), text);
        return directory;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const header = ({ name, description = 'does one thing', requires, extra = '' }) => `---\nname: ${name}\n`
  + `description: ${description}\n${requires === undefined ? '' : `metadata:\n  ligule-requires: "${requires}"\n`}${extra}---\n`;

function kernelWithSkills(registry, options = {}) {
  const kernel = createKernel({
    config: createConfig({ user: { boundary: process.cwd(), limits: options.limits } }),
    session: options.session,
  });
  loadAssembly(kernel, [minimalPlugin, createSkillPlugin(registry)]);
  return kernel;
}

test('the four directories are scanned in a fixed order and a repeated name keeps the highest one', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(2, 'notes', `${header({ name: 'notes', description: 'from the user layer' })}User body`);
    await place(1, 'notes', `${header({ name: 'notes', description: 'from the agents layer' })}Agents body`);
    await place(0, 'notes', `${header({ name: 'notes', description: 'from the project layer' })}Project body`);
    await place(3, 'other', `${header({ name: 'other' })}Other body`);
    const registry = await discoverSkills(directories);
    assert.deepEqual(registry.skills.map((skill) => skill.name), ['notes', 'other']);
    assert.equal(registry.skills.find((skill) => skill.name === 'notes').description, 'from the project layer');
    // 同名两份是被目录先后决定的，不是扫描顺序；被压掉的那两份要说得出在哪。
    assert.equal(registry.diagnostics.length, 2);
    assert.deepEqual(registry.diagnostics.map((item) => item.code), ['skill_name_conflict', 'skill_name_conflict']);
    assert.match(registry.diagnostics[0].detail, /the loaded one is .*[\\/]project[\\/]\.ligule[\\/]skills[\\/]notes/);
  });
});

test('a header that cannot be read is reported by its own code instead of half loaded', async () => {
  await withSkills(async ({ directories, place }) => {
    const cases = [
      ['nohead', 'nothing here\n'],
      ['nodescription', '---\nname: nodescription\n---\nbody\n'],
      ['Bad_Name', `${header({ name: 'Bad_Name' })}body\n`],
      ['long-name', `${header({ name: `x-${'y'.repeat(70)}` })}body\n`],
      ['longdesc', `${header({ name: 'longdesc', description: 'd'.repeat(1100) })}body\n`],
      ['broken', '---\nname: broken\ndescription: [\n---\nbody\n'],
    ];
    for (const [name, text] of cases) await place(0, name, text);
    const registry = await discoverSkills(directories);
    assert.deepEqual(registry.skills, []);
    assert.deepEqual(registry.diagnostics.map((item) => item.code).sort(), [
      'skill_description_missing', 'skill_description_too_long', 'skill_frontmatter_invalid',
      'skill_frontmatter_missing', 'skill_name_invalid', 'skill_name_invalid',
    ]);
  });
});

test('the catalog inlines every name and description until the budget is spent', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(0, 'pdf-tools', `${header({ name: 'pdf-tools', description: 'read a report' })}body\n`);
    const inlined = formatSkillCatalog(await discoverSkills(directories));
    assert.match(inlined, /- pdf-tools: read a report/);
    assert.match(inlined, /action "activate"/);

    // 说明按规范那档最多 1024 字符（D49），所以要八份顶满的技能才把 8 KB 的预算用完（D55）。
    for (const [number, index] of [1, 2, 3, 0, 1, 2, 3, 0].entries()) {
      await place(index, `big${number + 1}`, `${header({ name: `big${number + 1}`, description: 'd'.repeat(1000) })}body\n`);
    }
    const registry = await discoverSkills(directories);
    const fallback = formatSkillCatalog(registry);
    assert.ok(Buffer.byteLength(fallback, 'utf8') <= SKILL_METADATA_BUDGET_BYTES);
    // 超预算不列半份目录：那一句使用说明是唯一稳定注入的东西（D55）。
    assert.match(fallback, /too many to list here/);
    assert.doesNotMatch(fallback, /- big1:/);
    assert.ok(Buffer.byteLength(formatSkillCatalog(registry, 1_000_000), 'utf8') > SKILL_METADATA_BUDGET_BYTES);
  });
});

test('search ranks the name before the description words', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(0, 'git-commit', `${header({ name: 'git-commit', description: 'stage and describe a change' })}body\n`);
    await place(1, 'review', `${header({ name: 'review', description: 'git history and commit messages' })}body\n`);
    await place(2, 'unrelated', `${header({ name: 'unrelated', description: 'nothing about either here' })}body\n`);
    const { skills } = await discoverSkills(directories);
    assert.deepEqual(searchSkills(skills, 'git-commit').map((skill) => skill.name), ['git-commit', 'review']);
    assert.deepEqual(searchSkills(skills, 'commit').map((skill) => skill.name)[0], 'git-commit');
    assert.deepEqual(searchSkills(skills, 'zzzz-yyyy-qqqq'), []);
    assert.deepEqual(searchSkills(skills, '   '), []);
  });
});

test('activate hands over the instructions without the header and names the supporting files', async () => {
  await withSkills(async ({ directories, place }) => {
    const root = await place(0, 'pdf-tools', `${header({ name: 'pdf-tools', description: 'read a report' })}Open the file, then summarise.\n`);
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'guide.md'), 'the long part');
    const kernel = kernelWithSkills(await discoverSkills(directories));
    const value = await kernel.call('skill', { action: 'activate', name: 'pdf-tools' });
    assert.match(value.text, /digest [0-9a-f]{12}/);
    assert.match(value.text, /references\/guide\.md/);
    assert.match(value.text, /Open the file, then summarise/);
    assert.doesNotMatch(value.text, /description: read a report/);
    // 同一份内容两次激活给出同一个摘要：改了 SKILL.md 才换（D53 判「模型看的还是旧版」的依据）。
    const again = await kernel.call('skill', { action: 'activate', name: 'pdf-tools' });
    assert.equal(value.text.match(/digest ([0-9a-f]{12})/)[1], again.text.match(/digest ([0-9a-f]{12})/)[1]);
  });
});

test('a declared capability that is not there stops activation and changes nothing', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(0, 'needs-browser', `${header({ name: 'needs-browser', requires: 'browser mcp:github' })}body\n`);
    await place(1, 'needs-read', `${header({ name: 'needs-read', requires: 'read' })}body\n`);
    const kernel = kernelWithSkills(await discoverSkills(directories));
    const before = kernel.list();
    const error = await kernel.call('skill', { action: 'activate', name: 'needs-browser' }).catch((failure) => failure);
    assert.equal(error.code, 'skill_missing_capability');
    assert.match(error.detail, /browser/);
    assert.match(error.detail, /mcp:github/);
    // 声明不产生工具也不改档位：登记表与之前一字不差（D51、I4）。
    assert.deepEqual(kernel.list(), before);
    assert.match((await kernel.call('skill', { action: 'activate', name: 'needs-read' })).text, /body/);
  });
});

test('read stays inside that one skill directory and pages by bytes', async () => {
  await withSkills(async ({ directories, place }) => {
    const root = await place(0, 'withfiles', `${header({ name: 'withfiles' })}body\n`);
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'guide.md'), 'a'.repeat(60));
    const registry = await discoverSkills(directories);
    const kernel = kernelWithSkills(registry, { limits: { skillFileBytes: 20 } });
    const first = await kernel.call('skill', { action: 'read', name: 'withfiles', path: 'references/guide.md' });
    assert.match(first.text, /^a{20}/);
    assert.match(first.text, /offsetBytes=20/);
    const middle = await kernel.call('skill', {
      action: 'read', name: 'withfiles', path: 'references/guide.md', offsetBytes: 20,
    });
    assert.match(middle.text, /offsetBytes=40/);
    const last = await kernel.call('skill', {
      action: 'read', name: 'withfiles', path: 'references/guide.md', offsetBytes: 40,
    });
    assert.doesNotMatch(last.text, /truncated/);
    // SKILL.md 自己也在这一份边界之内：它是技能根里的一个文件，不该由技能边界外面那条规则管（D50）。
    assert.match((await kernel.call('skill', { action: 'read', name: 'withfiles', path: 'SKILL.md' })).text, /name: withfiles/);
    for (const path of ['../outside.md', '../../outside.md', '/etc/hosts']) {
      const error = await kernel.call('skill', { action: 'read', name: 'withfiles', path }).catch((failure) => failure);
      // 技能根与工作区边界是两套，越出技能根就报自己的码（D50）。
      assert.equal(error.code, 'skill_path_escapes_root', path);
    }
    const missing = await kernel.call('skill', { action: 'read', name: 'withfiles', path: 'nope.md' }).catch((f) => f);
    assert.equal(missing.code, 'skill_file_not_found');
  });
});

test('a body over the cap is refused whole, not cut', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(0, 'long', `${header({ name: 'long' })}${'x'.repeat(200)}\n`);
    const kernel = kernelWithSkills(await discoverSkills(directories), { limits: { skillBodyBytes: 100 } });
    const error = await kernel.call('skill', { action: 'activate', name: 'long' }).catch((failure) => failure);
    assert.equal(error.code, 'skill_too_large');
    assert.match(error.detail, /action "read"/);
    assert.equal(DEFAULT_LIMITS.skillBodyBytes, 24_000);
  });
});

test('an unknown name and a bad action each get their own code', async () => {
  await withSkills(async ({ directories, place }) => {
    await place(0, 'present', `${header({ name: 'present' })}body\n`);
    const kernel = kernelWithSkills(await discoverSkills(directories));
    assert.equal((await kernel.call('skill', { action: 'activate', name: 'absent' }).catch((f) => f)).code, 'skill_unknown');
    assert.equal((await kernel.call('skill', { action: 'launch', name: 'x' }).catch((f) => f)).code, 'skill_action_invalid');
    assert.equal((await kernel.call('skill', { action: 'search' }).catch((f) => f)).code, 'skill_query_required');
    assert.equal((await kernel.call('skill', { action: 'activate' }).catch((f) => f)).code, 'skill_name_required');
    assert.equal((await kernel.call('skill', { action: 'read', name: 'present' }).catch((f) => f)).code, 'skill_path_required');
  });
});

test('one disclosure is an ordinary tool call in the session record', async () => {
  await withSkills(async ({ directories, place, root }) => {
    await place(0, 'recorded', `${header({ name: 'recorded' })}body\n`);
    const session = createSessionLog({ directory: join(root, 'sessions'), id: 'one' });
    const kernel = kernelWithSkills(await discoverSkills(directories), { session });
    await kernel.call('skill', { action: 'activate', name: 'recorded' });
    await kernel.call('skill', { action: 'activate', name: 'absent' }).catch(() => {});
    const events = await session.read();
    // 披露没有自己的事件类型：它就是一条普通的工具调用，失败的也一样进记录（D53、I9）。
    assert.deepEqual(events.map((event) => [event.kind, event.tool]), [['tool', 'skill'], ['tool', 'skill']]);
    assert.equal(events[0].result.failed, false);
    assert.equal(events[1].result.failed, true);
    assert.equal(events[1].result.code, 'skill_unknown');
  });
});

test('a mode narrows the capability tools and cannot reach the disclosure entry', async () => {
  await withSkills(async ({ directories, place, root }) => {
    await place(0, 'pdf-tools', `${header({ name: 'pdf-tools', description: 'read a report' })}body\n`);
    const registry = await discoverSkills(directories);
    const projectRoot = join(root, 'project');
    const userHome = join(root, 'home');
    await mkdir(join(userHome, '.ligule', 'modes'), { recursive: true });
    await writeFile(join(userHome, '.ligule', 'modes', 'readonly.toml'), 'tools = ["read"]\nprompt = []\n');
    const modePaths = modeDirectories(projectRoot, shippedModes, userHome);
    const capture = async (modeName) => {
      const config = createConfig({
        user: {
          boundary: projectRoot,
          model: { api: 'messages', baseURL: 'http://127.0.0.1:1', model: 'test-model' },
          policy: { mode: 'ask' },
        },
      });
      const requests = [];
      const provider = {
        capabilities: MESSAGES_CAPABILITIES,
        model: 'test-model',
        async *stream(request) {
          requests.push(request);
          yield { type: 'message_start', message: { usage: {} } };
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_stop' };
        },
      };
      const pair = createMemoryConnectionPair();
      const host = serveHost({
        input: pair.host.input, output: pair.host.output, config, provider, policy: config.policy, modeName, modePaths, skillRegistry: registry,
      });
      const connection = createConnection(pair.client);
      try {
        const { sessionId } = await connection.request('session.create', {});
        await connection.request('run.start', { sessionId, input: 'say ok' });
      } finally {
        pair.client.output.end();
        host.release();
      }
      return requests[0];
    };

    // 没有模式收紧时八件加可选的那一件、派生那一件都在，`skill` 与目录那一段都在。
    const everything = await capture(undefined);
    assert.ok(everything.tools.some((entry) => entry.name === 'skill'), 'the disclosure entry is offered');
    assert.equal(everything.tools.length, 11);
    assert.match(everything.system, /- pdf-tools: read a report/);

    // 模式只筛直接能力工具：藏掉其余几件之后 `skill` 仍然留着（D63），目录那一段也跟着留着。
    const readonly = await capture('readonly');
    assert.deepEqual(readonly.tools.map((entry) => entry.name), ['read', 'skill']);
    assert.match(readonly.system, /- pdf-tools: read a report/);
    const minimal = await capture(DEFAULT_MODE);
    assert.ok(minimal.tools.some((entry) => entry.name === 'skill'));
    // 可选的第一方工具由模式装上或藏掉：`minimal` 里没写 `fetch` 就看不见它（D48）。
    assert.ok(!minimal.tools.some((entry) => entry.name === 'fetch'), 'minimal keeps the optional tool out');
    assert.equal(minimal.tools.length, 9);
  });
});
