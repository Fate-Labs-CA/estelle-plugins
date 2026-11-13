// Everything a person or a model reads from these packages: names, one-line descriptions, tool references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const HOSTS = ['claude', 'codex', 'cursor', 'dsh', 'grok', 'kimi'];
const COMMANDS = ['cloud', 'code', 'handoff', 'login', 'logout', 'monitor', 'resume', 'review', 'rooms'];
const MAX_DESCRIPTION = 100;
const read = file => readFile(join(root, file), 'utf8');
const tools = JSON.parse(await read('test/fixtures/mcp-tools.json'));
const KNOWN = new Set([...tools.base, ...tools.gated]);
const frontMatter = text => {
  const end = text.indexOf('\n---\n', 4);
  assert(text.startsWith('---\n') && end > 0, 'front matter is missing');
  return text.slice(4, end);
};

// A tool name is a snake_case word with one of the prefixes tools use. Bare one-word tools (`verify`,
// `locate`, `scan`, `review`, `orchestra`) read as English outside code font, so they are checked only there.
const TOOL_SHAPE = /\b(?:estelle_[a-z_]+|monitor_[a-z_]+|kb_[a-z_]+|research_[a-z_]+|find_[a-z_]+|list_[a-z_]+|get_session|memory_chat|session_message|dependency_path|blast_radius|import_cycles)\b/g;
const CODE_WORD = /`([a-z]+)`/g;
const CODE_WORDS_THAT_ARE_NOT_TOOLS = new Set(['handoff', 'cloud', 'list', 'get', 'tail', 'args', 'query', 'page', 'applied', 'unchanged', 'unknown', 'partial', 't', 'confirmed', 'refuted']);
function unknownTools(text) {
  const named = [...text.matchAll(TOOL_SHAPE)].map(match => match[0]);
  const codeWords = [...text.matchAll(CODE_WORD)].map(match => match[1]).filter(word => !CODE_WORDS_THAT_ARE_NOT_TOOLS.has(word));
  return [...new Set([...named, ...codeWords].filter(name => !KNOWN.has(name)))];
}

async function surfaceFiles() {
  const skills = (await readdir(join(root, 'skills'))).map(name => `skills/${name}/SKILL.md`);
  const commands = (await readdir(join(root, 'commands'))).map(name => `commands/${name}`);
  const agents = (await readdir(join(root, 'agents'))).map(name => `agents/${name}`);
  return [...skills, ...commands, ...agents, 'instructions.md'];
}

test('the fixture is the 40 tools the server reports, so a stale list cannot pass quietly', () => {
  assert.equal(tools.base.length, 40);
  assert.equal(new Set(tools.base).size, 40);
  for (const name of tools.gated) assert(!tools.base.includes(name), name);
});

test('every tool named in a skill, command, agent or the instructions exists', async () => {
  const files = await surfaceFiles();
  assert(files.length >= 30);
  let names = 0;
  for (const file of files) {
    const text = await read(file);
    names += [...text.matchAll(TOOL_SHAPE)].length;
    assert.deepEqual(unknownTools(text), [], file);
  }
  assert(names > 50, `only ${names} tool references found; the scanner is not reading these files`);
});

test('the tool name check can fail', () => {
  assert.deepEqual(unknownTools('call estelle_gate then `find_nothing` then `reviewer`'), ['estelle_gate', 'find_nothing', 'reviewer']);
  assert.deepEqual(unknownTools('call `estelle_docs`, `verify` and `list`, then verify the rest'), []);
});

test('retired names stay gone from every surface', async () => {
  const retired = [/\bQA\b/, /\bgate\b/i, /verify-gate/, /per-edit/i, /estelle@fatelabs/, /\bEstelle QA\b/];
  for (const file of await surfaceFiles()) {
    const text = await read(file);
    for (const pattern of retired) assert.doesNotMatch(text, pattern, file);
  }
  const skill = await read('skills/estelle/SKILL.md');
  assert.match(skill, /Twice \| Tests a web app/);
  assert.match(skill, /`estelle_docs`/);
});

test('each command is one plain line, on every host', async () => {
  for (const name of COMMANDS) {
    const head = frontMatter(await read(`commands/${name}.md`));
    const rows = head.split('\n');
    assert.equal(rows.length, 1, `${name}: only a description`);
    const description = rows[0].replace(/^description: /, '');
    assert(description.length <= MAX_DESCRIPTION, `${name}: ${description.length} characters`);
    assert.match(description, /^[A-Z][^:]*\.$/, `${name}: one sentence, no label`);
    assert.doesNotMatch(description, /Use when|Use for|you can|\bAI\b/, name);
    for (const host of HOSTS.filter(host => host !== 'codex')) {
      assert.equal(await read(`plugins/${host}/commands/${name}.md`), await read(`commands/${name}.md`), `${host}/${name}`);
    }
    const codex = await read(`plugins/codex/command-skills/${name}/SKILL.md`);
    assert.match(frontMatter(codex), new RegExp(`^name: ${name}$`, 'm'));
    assert(frontMatter(codex).includes(JSON.stringify(description)), `${name}: Codex shows a different line`);
    assert.doesNotMatch(codex, /\$ARGUMENTS/, `${name}: Codex drops anything that uses this placeholder`);
  }
  assert.deepEqual((await readdir(join(root, 'commands'))).sort(), COMMANDS.map(name => `${name}.md`).sort(),
    'a new command reaches every editor; add it here on purpose, with a plain line');
});

test('the slash menu shows the commands: every skill stays available to the model and off the menu', async () => {
  const names = await readdir(join(root, 'skills'));
  assert(names.length >= 26, 'a skill was removed; say so in the release notes');
  for (const name of names) {
    const head = frontMatter(await read(`skills/${name}/SKILL.md`));
    assert.match(head, /^user-invocable: false$/m, `${name} would crowd the slash menu`);
    assert.doesNotMatch(head, /disable-model-invocation/, `${name} must stay reachable by the model`);
    assert.match(head, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(head, /^description: /m);
  }
  assert.match(await read('commands/code.md'), /coding-workflow skill/);
  await access(join(root, 'skills', 'coding-workflow', 'SKILL.md'));
});

test('agents can reach Estelle whichever way it was installed', async () => {
  const agents = await readdir(join(root, 'agents'));
  assert.equal(agents.length, 4);
  for (const name of agents) {
    const line = (await read(`agents/${name}`)).split('\n').find(row => row.startsWith('tools: '));
    const listed = line.slice('tools: '.length).split(', ');
    const plugin = listed.filter(tool => tool.startsWith('mcp__plugin_estelle_Estelle__'));
    assert(plugin.length > 0, `${name} names no tool a plugin install has`);
    for (const tool of plugin) {
      const bare = tool.replace('mcp__plugin_estelle_Estelle__', '');
      assert(KNOWN.has(bare), `${name}: ${bare} does not exist`);
      assert(listed.includes(`mcp__Estelle__${bare}`), `${name}: ${bare} missing for a hand-added server`);
    }
    for (const tool of listed.filter(entry => entry.startsWith('mcp__') && !entry.startsWith('mcp__plugin_') && !entry.startsWith('mcp__Estelle__'))) {
      assert.fail(`${name}: ${tool} is under a server name nothing configures`);
    }
  }
});

test('every skill has one plain line for the pickers that prefer it', async () => {
  for (const name of await readdir(join(root, 'skills'))) {
    const head = frontMatter(await read(`skills/${name}/SKILL.md`));
    const match = /^metadata:\n {2}short-description: "(.+)"$/m.exec(head);
    assert(match, `${name} has no short description`);
    assert(match[1].length <= MAX_DESCRIPTION, name);
    assert.match(match[1], /\.$/, name);
    assert.doesNotMatch(match[1], /Use when/, name);
  }
});

test('the Codex package lists its command skills beside its skills', async () => {
  const manifest = JSON.parse(await read('plugins/codex/.codex-plugin/plugin.json'));
  assert.deepEqual(manifest.skills, ['./skills', './command-skills']);
  assert.deepEqual((await readdir(join(root, 'plugins', 'codex', 'command-skills'))).sort(), [...COMMANDS].sort());
});

test('update copy names the exact Codex step, and the setup prompt defers to the person', async () => {
  const guide = await read('docs/install/codex.md');
  assert.match(guide, /Trust all and continue/);
  assert.match(guide, /run `\/hooks` and press `t`/);
  assert.match(guide, /plugin contents changed; hook approval required/);
  assert.match(guide, /do not approve hooks for me/);
  const readme = await read('README.md');
  assert.match(readme, /do not approve hooks for me/);
  const skill = await read('skills/estelle/SKILL.md');
  assert.match(skill, /Approving is theirs to do, never yours/);
});
