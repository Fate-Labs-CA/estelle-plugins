import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HOOK_EVENTS as CURSOR_EVENTS } from '../adapters/cursor.mjs';

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const description = 'Estelle MCP, memory and session hooks for coding agents.';
const generated = new Map();
const json = value => JSON.stringify(value, null, 2) + '\n';
const emit = (file, value) => generated.set(file, typeof value === 'string' ? value : json(value));
const command = (host, variable) => `node "\${${variable}}/runtime/cli.mjs" hook ${host}`;
const common = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStart',
  'SubagentStop', 'PreCompact', 'SessionEnd', 'PreToolUse'];
const server = { url: 'https://api.fatelabs.ca/mcp', bearer_token_env_var: 'ESTELLE_API_KEY' };
const manifest = { name: 'estelle', version, description };
const marketplace = host => ({ name: 'estelle-plugins', owner: { name: 'Fate Labs' },
  plugins: [{ name: 'estelle', source: `./plugins/${host}` }] });
emit('runtime/version.mjs', `// Generated from package.json by scripts/build.mjs.\nexport const VERSION = '${version}';\n`);
// Only release metadata is generated in these otherwise hand-authored install documents.
for (const [file, pattern, replacement] of [
  ['README.md', /^Version: `\d+\.\d+\.\d+`\.$/gm, `Version: \`${version}\`.`],
  ['docs/install/grok.md', /^grok plugin install uqeu\/estelle-plugins@v\d+\.\d+\.\d+#plugins\/grok$/gm,
    `grok plugin install uqeu/estelle-plugins@v${version}#plugins/grok`],
]) {
  const source = await readFile(join(root, file), 'utf8');
  if ([...source.matchAll(pattern)].length !== 1) throw new Error(`Release metadata anchor missing or repeated: ${file}`);
  emit(file, source.replace(pattern, replacement));
}
emit('.claude-plugin/marketplace.json', marketplace('claude'));
emit('.agents/plugins/marketplace.json', marketplace('codex'));
emit('.grok-plugin/marketplace.json', { name: 'estelle-plugins', plugins: [{ name: 'estelle', source: './plugins/grok' }] });
emit('.cursor-plugin/marketplace.json', marketplace('cursor'));

function nativeHooks(host, variable, events) {
  return { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command',
    command: command(host, variable), timeout: ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 20,
    ...(host === 'codex' ? { statusMessage: `Estelle: ${event}` } : {}) }],
  }]])) };
}
emit('plugins/claude/.claude-plugin/plugin.json', { ...manifest, license: 'Apache-2.0', author: { name: 'Fate Labs' },
  repository: 'https://github.com/uqeu/estelle-plugins', hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
// URL only: Claude Code signs in with OAuth. A pinned header disables that, and an unset variable goes out literally.
emit('plugins/claude/.mcp.json', { mcpServers: { Estelle: { type: 'http', url: server.url } } });
emit('plugins/claude/hooks/hooks.json', nativeHooks('claude-code', 'CLAUDE_PLUGIN_ROOT', common));
emit('plugins/codex/.codex-plugin/plugin.json', { ...manifest, skills: './skills',
  hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
emit('plugins/codex/.mcp.json', { mcpServers: { Estelle: server } });
emit('plugins/codex/hooks/hooks.json', nativeHooks('codex', 'PLUGIN_ROOT', [...common, 'Interrupt',
  'PreModelRequest', 'PostModelRequest']));
const kimiManifest = { ...manifest, skills: ['./skills'], commands: ['./commands'],
  sessionStart: { skill: 'estelle' },
  mcpServers: { Estelle: { transport: 'http', url: server.url, bearerTokenEnvVar: 'ESTELLE_API_KEY' } },
  hooks: [...common.filter(event => event !== 'SubagentStart'), 'Interrupt']
    .map(event => ({ event, command: command('kimi', 'KIMI_PLUGIN_ROOT'), timeout: ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 20 })),
};
emit('plugins/kimi/kimi.plugin.json', kimiManifest);
// GitHub archives expose only their repository root to Kimi; keep the same canonical assets.
// An explicit empty list prevents Kimi's fallback from discovering the root's Claude-only agents.
emit('kimi.plugin.json', { ...kimiManifest, agents: [] });
emit('plugins/grok/plugin.json', { ...manifest, skills: './skills', commands: './commands',
  hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
emit('plugins/grok/.mcp.json', { mcpServers: { Estelle: server } });
emit('plugins/grok/hooks/hooks.json', nativeHooks('grok', 'GROK_PLUGIN_ROOT', common.filter(event => event !== 'SubagentStart')));
emit('plugins/cursor/.cursor-plugin/plugin.json', { ...manifest, author: { name: 'Fate Labs' }, license: 'Apache-2.0',
  skills: './skills', commands: './commands', rules: './rules', hooks: './hooks/hooks.json', mcpServers: './mcp.json' });
emit('plugins/cursor/mcp.json', { mcpServers: { Estelle: { url: server.url,
  headers: { Authorization: 'Bearer ${env:ESTELLE_API_KEY}' } } } });
emit('plugins/cursor/hooks/hooks.json', { version: 1, hooks: Object.fromEntries(CURSOR_EVENTS.filter(event => event !== 'subagentStart').map(event => [event,
  [{ command: command('cursor', 'CURSOR_PLUGIN_ROOT'), timeout: event === 'sessionEnd' ? 3 : 20 }]])) });
emit('plugins/cursor/rules/estelle.mdc', '---\ndescription: Use Estelle tools for repository context and shared work\nalwaysApply: true\n---\n'
  + await readFile(join(root, 'instructions.md'), 'utf8'));

// Codex has no plugin commands, so the two commands that move work reach it as skills with the same words.
const CODEX_COMMAND_SKILLS = ['handoff', 'cloud'];
for (const name of CODEX_COMMAND_SKILLS) {
  const source = await readFile(join(root, 'commands', `${name}.md`), 'utf8');
  const description = /^description: (.+)$/m.exec(source)[1];
  const body = source.replace(/^---[\s\S]*?---\n/, '').replaceAll('$ARGUMENTS', '<the words the person typed after the skill name>')
    .replace("In Claude Code the file is\n`${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is", 'The file is')
    .replace("In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is", 'The file is');
  emit(`plugins/codex/skills/estelle-${name}/SKILL.md`,
    `---\nname: estelle-${name}\ndescription: "${description} Use only when the person asks for it by name."\n---\n\n${body}`);
}
const HOSTS = ['claude', 'codex', 'kimi', 'grok', 'cursor'];
const ASSETS = ['runtime', 'adapters', 'skills', 'instructions.md', 'LICENSE', 'NOTICE'];
const assetsFor = host => [...ASSETS, ...(host === 'codex' ? [] : ['commands']), ...(host === 'claude' ? ['agents'] : [])];
async function inventory(directory, prefix = '') {
  const output = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Bundle symlinks are forbidden');
    if (entry.isDirectory()) for (const pair of await inventory(path, relative)) output.set(...pair);
    else if (entry.isFile()) output.set(relative, createHash('sha256').update(await readFile(path)).digest('hex'));
  }
  return output;
}
const digest = async path => statSync(path).isDirectory() ? inventory(path)
  : new Map([['file', createHash('sha256').update(await readFile(path)).digest('hex')]]);
if (!check) {
  // Regenerate derived packages and release metadata; user installations are untouched.
  await rm(join(root, 'plugins'), { recursive: true, force: true });
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin', '.mcp.claude.json', '.mcp.codex.json', 'hooks', 'kimi.plugin.json']) {
    await rm(join(root, file), { recursive: true, force: true });
  }
}
for (const [file, content] of generated) {
  if (check) {
    if (await readFile(join(root, file), 'utf8') !== content) throw new Error(`Generated file differs: ${file}`);
  } else {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), content);
  }
}
for (const host of HOSTS) for (const asset of assetsFor(host)) {
  const original = join(root, asset), target = join(root, 'plugins', host, asset);
  if (!check) { await cp(original, target, { recursive: true }); continue; }
  const built = [...(await digest(target))].filter(([file]) => !(host === 'codex' && asset === 'skills'
    && CODEX_COMMAND_SKILLS.some(name => file.startsWith(`estelle-${name}/`))));
  if (JSON.stringify([...(await digest(original))].sort()) !== JSON.stringify(built.sort())) {
    throw new Error(`Bundle differs: ${host}/${asset}`);
  }
}
console.log(`Estelle plugins ${version}: ${check ? 'checked' : 'built'}`);
