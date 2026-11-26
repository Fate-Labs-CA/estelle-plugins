import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HOOK_EVENTS as CURSOR_EVENTS } from '../adapters/cursor.mjs';
import { WRITE_TOOL_MATCHER } from '../adapters/antigravity.mjs';
import { FILE_WRITE_MATCHER } from '../runtime/write-warning.mjs';

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const description = 'Estelle MCP, memory and session hooks for coding agents.';
// Root `commands/` holds the shared Claude-format markdown and, for `gemini extensions install <repo>`, `commands/estelle/*.toml`.
const commandFiles = async () => (await readdir(join(root, 'commands'))).filter(name => name.endsWith('.md')).sort();
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
  ['docs/install/grok.md', /^grok plugin install Fate-Labs-CA\/estelle-plugins@v\d+\.\d+\.\d+#plugins\/grok$/gm,
    `grok plugin install Fate-Labs-CA/estelle-plugins@v${version}#plugins/grok`],
]) {
  const source = await readFile(join(root, file), 'utf8');
  if ([...source.matchAll(pattern)].length !== 1) throw new Error(`Release metadata anchor missing or repeated: ${file}`);
  emit(file, source.replace(pattern, replacement));
}
// One intent map (what the person asks, the tool to call first) for every host. It is written into the generated region
// of each file every host reads at session start: instructions.md (Cursor, OpenCode, Pi, dsh) and the estelle skill
// (Claude Code, Codex, Kimi, Grok). Edit intent-map.md, never the region.
const INTENT_MAP = await readFile(join(root, 'intent-map.md'), 'utf8');
const INTENT_REGION = /(<!-- intent-map:start[^\n]*-->\n)[\s\S]*?(<!-- intent-map:end -->)/g;
for (const file of ['instructions.md', 'skills/estelle/SKILL.md']) {
  const source = await readFile(join(root, file), 'utf8');
  if ([...source.matchAll(INTENT_REGION)].length !== 1) throw new Error(`Intent map region missing or repeated: ${file}`);
  emit(file, source.replace(INTENT_REGION, (_, start, end) => `${start}${INTENT_MAP}${end}`));
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
emit('plugins/claude/.claude-plugin/plugin.json', { ...manifest, license: 'SEE LICENSE IN LICENSE', author: { name: 'Fate Labs' },
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
for (const entry of (await commandFiles()).sort()) {
  const name = entry.replace(/\.md$/, '');
  const source = await readFile(join(root, 'commands', entry), 'utf8');
  const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
  if (!description) throw new Error(`Command needs one description line: ${entry}`);
  // OpenClaw's native plugin takes the same skill roots (its `skills` manifest list), at the same depth from `runtime/`.
  const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
    + body.replaceAll('$ARGUMENTS', 'what the person asked for');
  emit(`plugins/codex/command-skills/${name}/SKILL.md`, skill);
  emit(`plugins/openclaw-native/command-skills/${name}/SKILL.md`, skill);
}
// OpenClaw has no agent format a plugin can register, and treats an `agents/` root as skill content. Each shared agent is
// a skill the main agent loads and follows itself; the Claude-only `tools` list is dropped.
for (const entry of (await readdir(join(root, 'agent-sources'))).sort()) {
  const source = await readFile(join(root, 'agent-sources', entry), 'utf8');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source) ?? [];
  const field = key => new RegExp(`^${key}: (.+)$`, 'm').exec(front ?? '')?.[1]?.trim();
  if (!field('name') || !field('description')) throw new Error(`Agent needs name and description: ${entry}`);
  emit(`plugins/openclaw-native/agent-skills/${field('name')}/SKILL.md`, `---\nname: ${field('name')}\ndescription: ${JSON.stringify(field('description'))}\n---\n\n`
    + 'Follow this as the role to take on for the task, in this conversation.\n\n' + body);
}
// Claude Code's own command copies. Two of them run one shell command and relay its last line, so they run on the
// small model: the session's main model re-read the whole context for every turn of that. The shared files carry
// only `description`, which every host and Codex's conversion above read.
const CLAUDE_COMMAND_MODEL = Object.freeze({ cloud: 'haiku', handoff: 'haiku' });
for (const entry of (await commandFiles()).sort()) {
  const name = entry.replace(/\.md$/, '');
  const source = await readFile(join(root, 'commands', entry), 'utf8');
  const model = CLAUDE_COMMAND_MODEL[name];
  if (model && !/^---\ndescription: .+\n---\n/.test(source)) throw new Error(`Command needs one description line: ${entry}`);
  emit(`plugins/claude/commands/${entry}`, model ? source.replace(/\n---\n/, `\nmodel: ${model}\n---\n`) : source);
}
emit('plugins/codex/.mcp.json', { mcpServers: { Estelle: server } });
emit('plugins/codex/hooks/hooks.json', nativeHooks('codex', 'PLUGIN_ROOT', [...common, 'Interrupt']));
for (const entry of (await readdir(join(root, 'agent-sources'))).sort()) emit(`kimi-agents/${entry}`, await readFile(join(root, 'agent-sources', entry), 'utf8'));
const kimiManifest = { ...manifest, skills: ['./skills'], commands: ['./commands'], agents: ['./kimi-agents'],
  sessionStart: { skill: 'estelle' },
  mcpServers: { Estelle: { transport: 'http', url: server.url, bearerTokenEnvVar: 'ESTELLE_API_KEY' } },
  hooks: [...common, 'Interrupt']
    .map(event => ({ event, command: command('kimi', 'KIMI_PLUGIN_ROOT'), timeout: ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 20 })),
};
emit('plugins/kimi/kimi.plugin.json', kimiManifest);
// GitHub archives expose only their repository root to Kimi; keep the same canonical assets.
// Both manifests name the agents explicitly (Kimi `agents` field: `./` paths inside the plugin root).
emit('kimi.plugin.json', kimiManifest);
emit('plugins/grok/plugin.json', { ...manifest, skills: './skills', commands: './commands',
  hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
emit('plugins/grok/.mcp.json', { mcpServers: { Estelle: server } });
emit('plugins/grok/hooks/hooks.json', nativeHooks('grok', 'GROK_PLUGIN_ROOT', common));
emit('plugins/cursor/.cursor-plugin/plugin.json', { ...manifest, author: { name: 'Fate Labs' }, license: 'SEE LICENSE IN LICENSE',
  skills: './skills', commands: './commands', rules: './rules', hooks: './hooks/hooks.json', mcpServers: './mcp.json' });
emit('plugins/cursor/mcp.json', { mcpServers: { Estelle: { url: server.url,
  headers: { Authorization: 'Bearer ${env:ESTELLE_API_KEY}' } } } });
emit('plugins/cursor/hooks/hooks.json', { version: 1, hooks: Object.fromEntries(CURSOR_EVENTS.map(event => [event,
  [{ command: command('cursor', 'CURSOR_PLUGIN_ROOT'), timeout: event === 'sessionEnd' ? 3 : 20 }]])) });
emit('plugins/cursor/rules/estelle.mdc', '---\ndescription: Use Estelle tools for repository context and shared work\nalwaysApply: true\n---\n'
  + generated.get('instructions.md'));

// A dsh plugin is an npm-shaped bundle: this manifest and one Cordis patch layer. `dsh plugin --profile <name> add` installs it.
const DSH_PEERS = ['@deepseek-ai/dsh-llm'];
emit('plugins/dsh/package.json', { name: 'dsh-plugin-estelle', version, description, license: 'SEE LICENSE IN LICENSE', type: 'module',
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

// OpenCode and Pi load an npm-shaped package and run its JavaScript in their own process (adapters/opencode-plugin.mjs,
// adapters/pi-extension.mjs). Both packages are published to npm under the Fate Labs scope; neither is published by this build.
const npmPackage = (host, name, extra) => ({ name, version, description, license: 'SEE LICENSE IN LICENSE', type: 'module',
  author: 'Fate Labs', homepage: `https://github.com/Fate-Labs-CA/estelle-plugins/blob/main/docs/install/${host}.md`,
  repository: { type: 'git', url: 'git+https://github.com/Fate-Labs-CA/estelle-plugins.git', directory: `plugins/${host}` },
  bugs: { url: 'https://github.com/Fate-Labs-CA/estelle-plugins/issues' }, engines: { node: '>=22' },
  publishConfig: { access: 'public' }, ...extra });
emit('plugins/opencode/package.json', npmPackage('opencode', '@fatelabs/opencode-estelle', {
  keywords: ['opencode', 'opencode-plugin', 'estelle', 'mcp', 'memory', 'code-review'],
  main: './adapters/opencode-plugin.mjs',
  exports: { '.': './adapters/opencode-plugin.mjs', './package.json': './package.json' } }));
const PI_MANIFEST = { extensions: ['./adapters/pi-extension.mjs'], skills: ['./skills'] };
emit('plugins/pi/package.json', npmPackage('pi', '@fatelabs/pi-estelle', {
  // `pi-package` is what lists an npm package in the pi.dev gallery (Pi docs/packages.md, "Create a package").
  keywords: ['pi-package', 'pi', 'pi-extension', 'estelle', 'mcp', 'memory', 'code-review'],
  pi: PI_MANIFEST }));
// npm and the pi.dev gallery show the package's own README: the install page, with its links made absolute.
const BLOB = 'https://github.com/Fate-Labs-CA/estelle-plugins/blob/main';
for (const host of ['opencode', 'pi']) {
  const page = await readFile(join(root, 'docs', 'install', `${host}.md`), 'utf8');
  emit(`plugins/${host}/README.md`, page.replace(/\]\((?!https?:|#)([^)]+)\)/g,
    (_, target) => `](${new URL(target, `${BLOB}/docs/install/`).href})`));
}
// `pi install git:github.com/Fate-Labs-CA/estelle-plugins` reads the repository root's package.json, so the root names
// the Pi package's resources. Hand-authored like the rest of that file; the build only checks it still agrees.
const rootPi = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).pi;
const expectedRootPi = Object.fromEntries(Object.entries(PI_MANIFEST).map(([key, paths]) => [key, paths.map(path => path.replace('./', './plugins/pi/'))]));
if (JSON.stringify(rootPi) !== JSON.stringify(expectedRootPi)) throw new Error(`package.json "pi" must be ${JSON.stringify(expectedRootPi)}`);

// Qwen Code: one extension directory (`qwen extensions install`). MCP is the URL alone, so Qwen Code's own OAuth signs in
// from `/mcp` (a pinned Authorization header would disable that, and an unset variable is sent as literal text). Hooks are
// Qwen Code's Claude-shaped command hooks. In an extension's hooks Qwen Code fills in `${CLAUDE_PLUGIN_ROOT}` only
// (core/src/extension/variables.ts, substituteHookVariables); `${extensionPath}` reached the shell empty in testing.
const QWEN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];
emit('plugins/qwen/qwen-extension.json', { name: 'estelle', version, description,
  mcpServers: { Estelle: { httpUrl: server.url } }, contextFileName: 'instructions.md', agents: 'agents' });
emit('plugins/qwen/hooks/hooks.json', nativeHooks('qwen-code', 'CLAUDE_PLUGIN_ROOT', QWEN_EVENTS));
// Qwen Code subagents are Markdown with `tools` naming Qwen's own tools (sub-agents docs: read_file, grep_search, glob,
// write_file, edit, run_shell_command; `mcp__<server>__<tool>` for MCP). The shared agents name Claude's tools, so the
// names are translated here, and the Claude-plugin-only `mcp__plugin_estelle_*` aliases are dropped.
const QWEN_TOOLS = { Read: 'read_file', Grep: 'grep_search', Glob: 'glob', Write: 'write_file', Edit: 'edit', Bash: 'run_shell_command' };
const qwenTools = list => list.split(',').map(tool => tool.trim()).filter(tool => tool && !tool.startsWith('mcp__plugin_'))
  .map(tool => QWEN_TOOLS[tool] ?? tool).join(', ');
for (const entry of (await readdir(join(root, 'agent-sources'))).filter(name => name.endsWith('.md')).sort()) {
  const source = await readFile(join(root, 'agent-sources', entry), 'utf8');
  if (!/^tools: .+$/m.test(source)) throw new Error(`Agent needs a tools line: ${entry}`);
  emit(`plugins/qwen/agents/${entry}`, source.replace(/^tools: (.+)$/m, (_, list) => `tools: ${qwenTools(list)}`));
}
// Qwen Code commands are Markdown with `{{args}}`; the runner path is where `qwen extensions install` puts the extension.
const QWEN_CLI = '~/.qwen/extensions/estelle/runtime/cli.mjs';
for (const entry of (await commandFiles()).sort()) {
  const source = await readFile(join(root, 'commands', entry), 'utf8');
  if (!/^---\ndescription: .+\n---\n/.test(source)) throw new Error(`Command needs one description line: ${entry}`);
  emit(`plugins/qwen/commands/estelle/${entry}`, source.replaceAll('$ARGUMENTS', '{{args}}').replaceAll('<Estelle cli.mjs>', QWEN_CLI));
}

// Gemini CLI: one extension directory (`gemini extensions install`). MCP is the URL alone (`httpUrl`), so Gemini CLI's own OAuth
// signs in from `/mcp auth Estelle` (a pinned Authorization header would disable that). Hooks are `hooks/hooks.json`, never the
// manifest. Gemini CLI fills in `${extensionPath}` and `${/}` there, takes `timeout` in MILLISECONDS, and names its events its
// own way (adapters/gemini.mjs renames them). BeforeTool only ever carries the write warning, so it is limited to the two
// file-writing tools. Notification, BeforeModel, AfterModel and BeforeToolSelection carry nothing Estelle uses.
const GEMINI_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'PreCompress', 'SessionEnd'];
// The same files are emitted twice: under plugins/gemini (clone-based installs) and at the repository root, because
// `gemini extensions install <github url>` reads the root and has no subdirectory option. At the root they sit beside the
// shared sources: `hooks/` is read by no other host, and Gemini reads only `commands/**/*.toml`, so `commands/*.md` is ignored.
const GEMINI_ROOTS = ['plugins/gemini/', ''];
for (const base of GEMINI_ROOTS) {
emit(`${base}gemini-extension.json`, { name: 'estelle', version, description: `Fate Labs Estelle: ${description}`,
  mcpServers: { Estelle: { httpUrl: server.url } }, contextFileName: 'instructions.md' });
emit(`${base}hooks/hooks.json`, { hooks: Object.fromEntries(GEMINI_EVENTS.map(event => [event, [{
  ...(event === 'BeforeTool' ? { matcher: 'write_file|replace' } : {}),
  hooks: [{ name: `estelle-${event}`, type: 'command', command: 'node "${extensionPath}${/}runtime${/}cli.mjs" hook gemini-cli',
    timeout: event === 'SessionEnd' ? 3000 : 20000 }] }]])) });
}
// Gemini CLI commands are TOML (`prompt`, `description`) with `{{args}}`; `commands/estelle/code.toml` becomes `/estelle:code`.
// The runner path is where `gemini extensions install` (and `link`) puts the extension. The prompt is a TOML literal string,
// so backslashes and quotes stay as written; one that held a triple quote or a Gemini injection token would not survive.
const GEMINI_CLI = '$HOME/.gemini/extensions/estelle/runtime/cli.mjs';
const TOML_LITERAL = "'" + "'" + "'";
for (const entry of (await commandFiles()).sort()) {
  const source = await readFile(join(root, 'commands', entry), 'utf8');
  const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
  if (!description) throw new Error(`Command needs one description line: ${entry}`);
  const prompt = body.replaceAll('$ARGUMENTS', '{{args}}').replaceAll('<Estelle cli.mjs>', GEMINI_CLI);
  if (prompt.includes(TOML_LITERAL) || /[!@]\{/.test(prompt)) throw new Error(`Command cannot be a Gemini CLI TOML literal: ${entry}`);
  for (const base of GEMINI_ROOTS) emit(`${base}commands/estelle/${entry.replace(/\.md$/, '.toml')}`,
    `description = ${JSON.stringify(description)}\nprompt = ${TOML_LITERAL}\n${prompt.trimEnd()}\n${TOML_LITERAL}\n`);
}
// Gemini CLI subagents (`agents/*.md`, preview): the same four definitions, with Gemini CLI's own tool names. Its loader is
// strict: `tools` is a list of Gemini tool names (MCP tools are `mcp_<server>_<tool>`), and an unknown key rejects the file.
const GEMINI_AGENT_TOOLS = { Read: 'read_file', Grep: 'grep_search', Glob: 'glob', Bash: 'run_shell_command', Write: 'write_file', Edit: 'replace' };
const geminiTool = tool => GEMINI_AGENT_TOOLS[tool] ?? (/^mcp__Estelle__/.test(tool) ? tool.replace(/^mcp__Estelle__/, 'mcp_Estelle_') : null);
for (const entry of (await readdir(join(root, 'agent-sources'))).sort()) {
  const source = await readFile(join(root, 'agent-sources', entry), 'utf8');
  const [, name, description, tools, body] = /^---\nname: (.+)\ndescription: (.+)\ntools: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
  if (!name) throw new Error(`Agent needs name, description and tools lines: ${entry}`);
  const mapped = [...new Set(tools.split(',').map(tool => geminiTool(tool.trim())).filter(Boolean))];
  for (const base of GEMINI_ROOTS) emit(`${base}agents/${entry}`, `---\nname: ${name}\ndescription: ${description}\ntools:\n${mapped.map(tool => `  - ${tool}`).join('\n')}\n---\n${body}`);
}

// Hermes Agent: a directory plugin (`plugin.yaml` and an `__init__.py` with `register(ctx)`), installed with
// `hermes plugins install Fate-Labs-CA/estelle-plugins/plugins/hermes`. The Python side is hosts/hermes/__init__.py.
emit('plugins/hermes/plugin.yaml', `name: estelle
version: ${version}
description: ${description}
author: Fate Labs
provides_hooks: [on_session_start, pre_llm_call, pre_tool_call, post_tool_call, post_llm_call, on_session_finalize, subagent_start, subagent_stop, post_compaction]
`);
emit('plugins/hermes/__init__.py', await readFile(join(root, 'hosts', 'hermes', '__init__.py'), 'utf8'));

// mini-swe-agent: bash is its only tool, so it gets no MCP client and no hooks. One config file it merges with its own
// (`mini -c mini.yaml -c estelle.yaml`) tells the model to reach Estelle through `runtime/cli.mjs mcp`.
emit('plugins/mini-swe-agent/estelle.yaml', await readFile(join(root, 'hosts', 'mini-swe-agent', 'estelle.yaml'), 'utf8'));

// OpenClaw: an Agent Plugins 1.0.0 bundle (root `plugin.json` with the standard's $schema, and `skills/`), which
// `openclaw plugins install` maps into native skills (OpenClaw docs/plugins/bundles.md). No `mcp.json`: the standard's
// remote entry carries only a URL and static headers, with no OAuth, so the server is added with `openclaw mcp add`.
emit('plugins/openclaw/plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'estelle', version, description: 'Estelle skills for OpenClaw. The Estelle MCP server is added with openclaw mcp add.' });
// fx (vercel-labs/fx): no plugin format and no hooks. The package is the skills fx reads from `~/.fx/skills` and an
// `mcp.json` entry to merge into `~/.fx/mcp.json` for key sign-in; `/mcp add Estelle <url>` signs in with OAuth instead.
// fx agent profiles (fx.sh/docs/configure-fx/agent-profiles): `~/.fx/agents/<name>/profile.json` and `prompt.md`. The shared
// agents name Claude Code's tools; each maps to fx's own, and every Estelle MCP tool becomes the `Estelle` server, which fx
// reaches through `toolbox`. `prompt: append` adds the agent's instructions after fx's own system prompt.
const FX_TOOLS = Object.freeze({ Read: 'read_file', Grep: 'grep_files', Glob: 'glob_files', Write: 'write_file',
  Edit: 'edit_file', Bash: 'shell' });
for (const entry of (await readdir(join(root, 'agent-sources'))).sort()) {
  const source = await readFile(join(root, 'agent-sources', entry), 'utf8');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source) ?? [];
  const field = key => new RegExp(`^${key}: (.+)$`, 'm').exec(front ?? '')?.[1]?.trim();
  const name = field('name');
  if (!/^[a-z0-9_-]{1,64}$/.test(name ?? '') || !field('description') || !field('tools')) throw new Error(`Agent needs a profile-safe name, description and tools: ${entry}`);
  const claudeTools = field('tools').split(',').map(tool => tool.trim()).filter(Boolean);
  const unmapped = claudeTools.filter(tool => !FX_TOOLS[tool] && !tool.startsWith('mcp__'));
  if (unmapped.length) throw new Error(`Agent ${name} uses tools with no fx equivalent: ${unmapped.join(', ')}`);
  const direct = claudeTools.filter(tool => FX_TOOLS[tool]).map(tool => FX_TOOLS[tool]);
  const mcp = claudeTools.some(tool => tool.startsWith('mcp__'));
  emit(`plugins/fx/agents/${name}/profile.json`, { description: field('description'),
    tools: [...new Set([...direct, ...(mcp ? ['toolbox'] : [])])], mcp_servers: mcp ? ['Estelle'] : [], prompt: 'append' });
  emit(`plugins/fx/agents/${name}/prompt.md`, body.trim() + '\n');
}
emit('plugins/fx/mcp.json', { mcpServers: { Estelle: { type: 'http', url: server.url, bearer_token_env: 'ESTELLE_API_KEY' } } });

// Google Antigravity (IDE and `agy` CLI): one plugin directory. `agy plugin validate` rejects unknown plugin.json fields.
// MCP is the URL alone, so Antigravity's own OAuth (CIMD or DCR, then a pasted code) signs in; a pinned header would disable
// it. Hook commands run with the plugin root as the working directory, so paths are relative. Antigravity has no prompt,
// compaction, session-end or subagent event: PreInvocation is the prompt, Stop is capture and checkpoint.
const AGY_COMMAND = event => ({ type: 'command', command: `node ./runtime/cli.mjs hook antigravity ${event}`, timeout: 20 });
emit('plugins/antigravity/plugin.json', { $schema: 'https://antigravity.google/schemas/v1/plugin.json', name: 'estelle',
  displayName: 'Fate Labs Estelle', logo: 'assets/logo.svg', version, license: 'SEE LICENSE IN LICENSE', author: { name: 'Fate Labs', url: 'https://fatelabs.ca' },
  description: 'Estelle gives Antigravity repository memory, grounded review and session capture through MCP, hooks, skills and agents.',
  homepage: 'https://github.com/Fate-Labs-CA/estelle-plugins/blob/main/docs/install/antigravity.md',
  repository: 'https://github.com/Fate-Labs-CA/estelle-plugins', keywords: ['estelle', 'memory', 'mcp', 'code-review'],
  suggestedPrompts: ['Resume where I left off with Estelle', 'Review my current change with Estelle'] });
emit('plugins/antigravity/mcp_config.json', { mcpServers: { Estelle: { serverUrl: server.url } } });
emit('plugins/antigravity/hooks.json', { estelle: {
  SessionStart: [AGY_COMMAND('SessionStart')], PreInvocation: [AGY_COMMAND('PreInvocation')],
  PreToolUse: [{ matcher: WRITE_TOOL_MATCHER, hooks: [AGY_COMMAND('PreToolUse')] }],
  PostToolUse: [{ matcher: '', hooks: [AGY_COMMAND('PostToolUse')] }], Stop: [AGY_COMMAND('Stop')] } });
emit('plugins/antigravity/rules/AGENTS.md', generated.get('instructions.md'));
// The Fate Labs mark (founder, 2026-11-25: the same logo as Eden's plugin), which plugin.json's `logo` names and the Marketplace needs.
emit('plugins/antigravity/assets/logo.svg', await readFile(join(root, 'assets', 'logo.svg'), 'utf8'));
// Commands are skills here (`/<skill-name>`), prefixed so they cannot shadow a person's own `/code` or `/review`. Only the
// person invokes them. `$ARGUMENTS` has no meaning in a skill, as in Codex's conversion above.
for (const entry of (await commandFiles()).sort()) {
  const name = entry.replace(/\.md$/, '');
  const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(await readFile(join(root, 'commands', entry), 'utf8')) ?? [];
  if (!description) throw new Error(`Command needs one description line: ${entry}`);
  emit(`plugins/antigravity/command-skills/estelle-${name}/SKILL.md`, `---\nname: estelle-${name}\ndescription: ${JSON.stringify(description)}\n`
    + `disable-model-invocation: true\n---\n\n${body.replaceAll('$ARGUMENTS', 'what the person asked for')}`);
}
// Agents: Antigravity's frontmatter has no Claude `tools` list (its tool names differ), so the agent keeps all tools.
for (const entry of (await readdir(join(root, 'agent-sources'))).sort()) {
  const [, name, description, body] = /^---\nname: (.+)\ndescription: (.+)\ntools: .+\n---\n([\s\S]+)$/.exec(await readFile(join(root, 'agent-sources', entry), 'utf8')) ?? [];
  if (!name) throw new Error(`Agent needs name, description and tools lines: ${entry}`);
  emit(`plugins/antigravity/agents/${entry}`, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmainAgent: false\nsubagent: true\nmodel: inherit\n---\n${body}`);
}

// OpenClaw, native: `openclaw.plugin.json` plus the in-process plugin (adapters/openclaw-plugin.mjs). A directory that held
// both this and the bundle's `plugin.json` would install as native only (OpenClaw docs/plugins/bundles.md, "Detection
// precedence"), so the native plugin has its own directory and `plugins/openclaw` stays the skills-only bundle.
emit('plugins/openclaw-native/openclaw.plugin.json', { id: 'estelle', name: 'Estelle', description: `${description} Hooks, recall, capture and skills.`,
  activation: { onStartup: true }, contracts: { conversationAccess: ['read'] },
  configSchema: { type: 'object', additionalProperties: false },
  skills: ['./skills', './command-skills', './agent-skills'] });
emit('plugins/openclaw-native/package.json', npmPackage('openclaw', '@fatelabs/openclaw-estelle', {
  keywords: ['openclaw', 'openclaw-plugin', 'estelle', 'memory', 'code-review'],
  repository: { type: 'git', url: 'git+https://github.com/Fate-Labs-CA/estelle-plugins.git', directory: 'plugins/openclaw-native' },
  main: './adapters/openclaw-plugin.mjs', openclaw: { extensions: ['./adapters/openclaw-plugin.mjs'] },
  exports: { '.': './adapters/openclaw-plugin.mjs', './package.json': './package.json' } }));

const HOSTS = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'dsh', 'opencode', 'pi', 'qwen', 'gemini', 'hermes', 'mini-swe-agent',
  'openclaw', 'openclaw-native', 'fx', 'antigravity'];
const ASSETS = ['runtime', 'adapters', 'skills', 'instructions.md', 'LICENSE'];
// Codex gets generated skills and Claude gets generated copies (both above); the other hosts copy commands as they are.
// mini-swe-agent needs only the runtime (its bridge); OpenClaw and fx take only content, no hook runner.
const CONTENT_ONLY = ['skills', 'instructions.md', 'LICENSE'];
const assetsFor = host => host === 'mini-swe-agent' ? ['runtime', 'LICENSE']
  : host === 'openclaw-native' ? ['runtime', 'adapters', 'skills', 'instructions.md', 'LICENSE']
  : ['openclaw', 'fx'].includes(host) ? CONTENT_ONLY : [...ASSETS, ...(['codex', 'claude', 'qwen', 'gemini', 'antigravity'].includes(host) ? [] : ['commands']),
  ...(['claude', 'opencode', 'cursor'].includes(host) ? ['agents'] : []), ...(host === 'kimi' ? ['kimi-agents'] : [])];
// Root `agents/` is Gemini's (GitHub-root install reads it) and root `kimi-agents/` is Kimi's; the shared sources live in `agent-sources/`.
const sourceOf = asset => (asset === 'agents' ? 'agent-sources' : asset);
async function inventory(directory, prefix = '') {
  const output = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (path === join(root, 'commands', 'estelle')) continue; // Gemini's root copy of the commands, not a shared source
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
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin', '.mcp.claude.json', '.mcp.codex.json', 'kimi.plugin.json']) {
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
  const original = join(root, sourceOf(asset)), target = join(root, 'plugins', host, asset);
  if (!check) { await cp(original, target, { recursive: true, filter: source => source !== join(root, 'commands', 'estelle') }); continue; }
  if (JSON.stringify([...(await digest(original))].sort()) !== JSON.stringify([...(await digest(target))].sort())) {
    throw new Error(`Bundle differs: ${host}/${asset}`);
  }
}
console.log(`Estelle plugins ${version}: ${check ? 'checked' : 'built'}`);
