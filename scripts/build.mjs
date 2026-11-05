import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HOOK_EVENTS as CURSOR_EVENTS } from '../adapters/cursor.mjs';
import { FILE_WRITE_MATCHER } from '../runtime/write-warning.mjs';

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

// Codex prints one line per handler run, including every run it refuses after a plugin update, so a
// handler that does nothing for a given tool is a line of noise at the worst moment. The write guard
// only ever acts on file writes; other hosts' PreToolUse also carries queued context and stays unfiltered.
const matcherFor = (host, event) => (host === 'codex' && event === 'PreToolUse' ? { matcher: FILE_WRITE_MATCHER } : {});
function nativeHooks(host, variable, events) {
  return { hooks: Object.fromEntries(events.map(event => [event, [{ ...matcherFor(host, event), hooks: [{ type: 'command',
    command: command(host, variable), timeout: ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 20,
    ...(host === 'codex' ? { statusMessage: `Estelle: ${event}` } : {}) }],
  }]])) };
}
emit('plugins/claude/.claude-plugin/plugin.json', { ...manifest, license: 'Apache-2.0', author: { name: 'Fate Labs' },
  repository: 'https://github.com/uqeu/estelle-plugins', hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
// The helper prints the plugin's own sign-in, or nothing, in which case Claude Code signs in with its own OAuth as before.
// Never a pinned header: that disables OAuth, and an unset variable goes out literally.
emit('plugins/claude/.mcp.json', { mcpServers: { Estelle: { type: 'http', url: server.url,
  headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs" mcp-headers' } } });
emit('plugins/claude/hooks/hooks.json', nativeHooks('claude-code', 'CLAUDE_PLUGIN_ROOT', common));
emit('plugins/codex/.codex-plugin/plugin.json', { ...manifest, skills: ['./skills', './command-skills'],
  hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
// Codex has no command format of its own. It turns commands into skills at install, but silently skips any
// command using $ARGUMENTS, which is all of ours. So the Codex package gets those skills generated here.
for (const entry of (await readdir(join(root, 'commands'))).sort()) {
  const name = entry.replace(/\.md$/, '');
  const source = await readFile(join(root, 'commands', entry), 'utf8');
  const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
  if (!description) throw new Error(`Command needs one description line: ${entry}`);
  emit(`plugins/codex/command-skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
    + body.replaceAll('$ARGUMENTS', 'what the person asked for'));
}
emit('plugins/codex/.mcp.json', { mcpServers: { Estelle: server } });
emit('plugins/codex/hooks/hooks.json', nativeHooks('codex', 'PLUGIN_ROOT', [...common, 'Interrupt']));
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

// A dsh plugin is an npm-shaped bundle: this manifest and one Cordis patch layer. `dsh plugin --profile <name> add` installs it.
const DSH_PEERS = ['@deepseek-ai/dsh-llm'];
emit('plugins/dsh/package.json', { name: 'dsh-plugin-estelle', version, description, license: 'Apache-2.0', type: 'module',
  keywords: ['dsh-plugin'], repository: { type: 'git', url: 'git+https://github.com/uqeu/estelle-plugins.git', directory: 'plugins/dsh' },
  main: 'adapters/dsh-plugin.mjs', exports: { '.': './adapters/dsh-plugin.mjs', './package.json': './package.json' },
  engines: { node: '>=24.9.0', dsh: '>=0.2.1-rc.5 <0.3.0' },
  peerDependencies: Object.fromEntries(DSH_PEERS.map(name => [name, '*'])),
  // dsh resolves these from its own installation. Optional keeps pnpm from installing a second copy into the profile.
  peerDependenciesMeta: Object.fromEntries(DSH_PEERS.map(name => [name, { optional: true }])),
  dsh: { bundle: { patch: './cordis.patch.yml' } } });
emit('plugins/dsh/cordis.patch.yml', `# Estelle for DeepSeek Harness: memory and repository tools over MCP, session capture, skills and slash commands.

# No harness telemetry, on any route. Estelle's answers carry your repository and memory, and dsh would otherwise send them:
# the session log travels in the body of every request on its DeepSeek route, tool results included (session-log-deepseek),
# the session is exported to DeepSeek's collector on explicit feedback (session-telemetry-otel), and each request names your
# active plugins (plugin-package-inventory-deepseek). A row that is off cannot be switched back on from dsh's settings page.
- id: session-log-deepseek
  disabled: true

- id: session-telemetry-otel
  disabled: true

- id: plugin-package-inventory-deepseek
  disabled: true

# Product usage events. Only the web profile mounts this row; elsewhere dsh reports this target as unmatched and moves on.
- id: desktop-product-telemetry
  disabled: true

- insert:
    - id: estelle
      name: dsh-plugin-estelle

    # Absent without a key: an unset variable would otherwise go out as the literal header "Bearer undefined".
    - id: estelle-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: !!js '!process.env.ESTELLE_API_KEY'
      config:
        serverName: Estelle
        transport: streamable-http
        url: ${server.url}
        headers:
          Authorization: !!js '\`Bearer \${process.env.ESTELLE_API_KEY}\`'
          X-Estelle-Repo: !!js "process.env.ESTELLE_REPO ?? ''"
`);

const HOSTS = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'dsh'];
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
  if (JSON.stringify([...(await digest(original))].sort()) !== JSON.stringify([...(await digest(target))].sort())) {
    throw new Error(`Bundle differs: ${host}/${asset}`);
  }
}
console.log(`Estelle plugins ${version}: ${check ? 'checked' : 'built'}`);
