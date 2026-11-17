import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentPresetDirectories, listAgentPresets, loadAgentPreset } from '../dist/kernel/agent-presets.js';
import type { AgentPresetDirectories, AgentPresetLayer } from '../dist/kernel/agent-presets.js';

type Layer = AgentPresetLayer;

async function withLayout(run: (directories: AgentPresetDirectories) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ligule-agent-presets-'));
  const directories = agentPresetDirectories(join(root, 'project'), join(root, 'shipped'), join(root, 'home', '.ligule'));
  try {
    await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true })));
    await run(directories);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePreset(directories: AgentPresetDirectories, layer: Layer, id: string, text: string) {
  const path = join(directories[layer], `${id}.toml`);
  await writeFile(path, text);
  return path;
}

const preset = (description: string, instruction = 'Read the supplied material and report supported facts.') =>
  `schemaVersion = 1\ndescription = ${JSON.stringify(description)}\ninstruction = ${JSON.stringify(instruction)}\nmode = "minimal"\n`;

test('agent presets use whole-file project, user, then shipped precedence', async () => {
  await withLayout(async directories => {
    await writePreset(directories, 'shipped', 'research', preset('Built-in research'));
    await writePreset(directories, 'user', 'research', preset('Personal research'));
    await writePreset(directories, 'project', 'research', preset('Project research', 'Use only the current project inputs.'));

    const loaded = await loadAgentPreset('research', directories);
    assert.equal(loaded.layer, 'project');
    assert.equal(loaded.description, 'Project research');
    assert.equal(loaded.instruction, 'Use only the current project inputs.');
  });
});

test('an invalid higher-priority preset fails instead of falling back', async () => {
  await withLayout(async directories => {
    await writePreset(directories, 'shipped', 'research', preset('Shipped fallback'));
    await writePreset(directories, 'project', 'research', `${preset('Invalid project')}unknown = true\n`);

    await assert.rejects(loadAgentPreset('research', directories), { code: 'agent_preset_field_unknown' });
  });
});

test('preset IDs, required fields, and unknown fields are checked strictly', async () => {
  await withLayout(async directories => {
    await assert.rejects(loadAgentPreset('../research', directories), { code: 'agent_preset_name_invalid' });
    await writePreset(directories, 'user', 'missing-mode', 'schemaVersion = 1\ndescription = "Missing mode"\ninstruction = "Do work."\n');
    await assert.rejects(loadAgentPreset('missing-mode', directories), { code: 'agent_preset_field_missing' });
    await writePreset(directories, 'user', 'unknown-field', `${preset('Unknown field')}script = "echo unsafe"\n`);
    await assert.rejects(loadAgentPreset('unknown-field', directories), { code: 'agent_preset_field_unknown' });
  });
});

test('preset files over the size limit are rejected before parsing', async () => {
  await withLayout(async directories => {
    await writePreset(directories, 'user', 'large', `${preset('Large')}#${'x'.repeat(65_536)}\n`);
    await assert.rejects(loadAgentPreset('large', directories), { code: 'agent_preset_too_large' });
  });
});

test('preset fields, supported schemas, and required check names are bounded and validated', async () => {
  await withLayout(async directories => {
    await writePreset(directories, 'user', 'bad-description', preset('x'.repeat(513)));
    await assert.rejects(loadAgentPreset('bad-description', directories), { code: 'agent_preset_field_invalid' });
    await writePreset(directories, 'user', 'bad-output-tokens', `${preset('Bad limit')}outputTokens = 0\n`);
    await assert.rejects(loadAgentPreset('bad-output-tokens', directories), { code: 'agent_preset_field_invalid' });
    await writePreset(directories, 'user', 'duplicate-check', `${preset('Duplicate checks')}requiredChecks = ["tests", "tests"]\n`);
    await assert.rejects(loadAgentPreset('duplicate-check', directories), { code: 'agent_preset_checks_invalid' });
    await writePreset(directories, 'user', 'unsupported-schema', `${preset('Unsupported schema')}outputSchema = { type = "unknown" }\n`);
    await assert.rejects(loadAgentPreset('unsupported-schema', directories), { code: 'agent_preset_schema_invalid' });
    await writePreset(directories, 'user', 'valid-schema', `${preset('Valid schema')}outputSchema = { type = "object", properties = { answer = { type = "string" } }, required = ["answer"], additionalProperties = false }\nrequiredChecks = ["tests", "lint"]\n`);
    const valid = await loadAgentPreset('valid-schema', directories);
    assert.deepEqual(valid.requiredChecks, ['tests', 'lint']);
    assert.equal((valid.outputSchema?.properties as Record<string, unknown>).answer !== undefined, true);
    assert.match(valid.digest, /^[a-f0-9]{64}$/u);
  });
});

test('preset files cannot be symbolic links', async () => {
  await withLayout(async directories => {
    const outside = join(directories.user, 'outside.toml');
    await writeFile(outside, preset('Outside'));
    await symlink(outside, join(directories.project, 'link.toml'));
    await assert.rejects(loadAgentPreset('link', directories), { code: 'agent_preset_path_invalid' });
  });
});

test('preset listing is paged, reports invalid definitions, and never includes filesystem paths', async () => {
  await withLayout(async directories => {
    await writePreset(directories, 'project', 'alpha', `${preset('Invalid project')}unknown = true\n`);
    await writePreset(directories, 'user', 'beta', preset('User beta'));
    await writePreset(directories, 'shipped', 'charlie', preset('Shipped charlie'));

    const first = await listAgentPresets(directories, { limit: 2 });
    assert.deepEqual(first.presets.map(item => item.id), ['alpha', 'beta']);
    assert.equal(first.presets[0]?.errorCode, 'agent_preset_field_unknown');
    assert.equal(first.truncated, true);
    assert.equal(typeof first.nextCursor, 'string');
    assert.equal(typeof first.nextCursor, 'string');
    const second = await listAgentPresets(directories, { limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(second.presets.map(item => item.id), ['charlie']);
    assert.equal(second.nextCursor, undefined);
    assert.equal(JSON.stringify([first, second]).includes(directories.project), false);
    await assert.rejects(listAgentPresets(directories, { limit: 65 }), { code: 'agent_preset_page_limit_invalid' });
  });
});

test('preset discovery inspects no more than 128 definitions in one layer', async () => {
  await withLayout(async directories => {
    await Promise.all(Array.from({ length: 130 }, (_, index) => writePreset(
      directories, 'user', `preset-${String(index).padStart(3, '0')}`, preset(`Preset ${index}`),
    )));
    const page = await listAgentPresets(directories, { limit: 64 });
    assert.equal(page.presets.length, 64);
    assert.equal(page.truncated, true);
    assert.equal(typeof page.nextCursor, 'string');
  });
});
