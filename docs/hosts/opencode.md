# OpenCode: what the host offers and how Estelle uses it

Read on 2026-11-18. Sources, in the order they were trusted:

1. The released packages, installed and read: `opencode-ai@1.19.6` (release
   [v1.19.6](https://github.com/anomalyco/opencode/releases/tag/v1.19.6), 2026-11-17), its plugin types
   `@opencode-ai/plugin@1.19.6` (`dist/index.d.ts`: `PluginModule`, `PluginInput`, `Hooks`) and config types
   `@opencode-ai/sdk@1.19.6` (`dist/gen/types.gen.d.ts` and `dist/v2/gen/types.gen.d.ts`: `Config`, `McpRemoteConfig`).
2. The CLI itself: `opencode --help`, `opencode plugin --help`, `opencode run --help` from 1.19.6.
3. The project repository, [anomalyco/opencode](https://github.com/anomalyco/opencode) (`sst/opencode` redirects
   there), `dev` at `88ca792e024aa2085fa6e15288be37037c4871d2`.
4. The docs: [Plugins](https://opencode.ai/docs/plugins/), [Build a plugin](https://opencode.ai/docs/build/plugins/),
   [Server plugins](https://opencode.ai/docs/build/plugins/server/), [Ecosystem](https://opencode.ai/docs/ecosystem/).

⚠️ The docs site already describes the next plugin API (`@opencode/plugin` 2.x, `Plugin.define({ id, setup })`, a
`plugins` config key). The released 1.19.6 binary loads the `@opencode-ai/plugin` 1.x shape (`{ id, server }` and the
`plugin` config key). The docs say the object form with both `setup` and `server` needs 1.18.29 or later. Estelle's
plugin is written against what 1.19.6 actually runs, and every claim below was checked against that binary.

## What OpenCode can do

| Mechanism | OpenCode 1.19.6 | Source |
|---|---|---|
| Plugins | A JS/TS module, default export `{ id, server }`, where `server(input)` returns `Hooks`. `input` carries `client` (the SDK client of the running server), `project`, `directory`, `worktree`, `serverUrl`, `$` (Bun shell). | `@opencode-ai/plugin` `PluginModule`, `PluginInput` |
| Plugin loading | `plugin` array in `opencode.json`: npm specs or `file://` paths. Files in `.opencode/plugins/` and `~/.config/opencode/plugins/` load automatically. `opencode plugin <module>` installs an npm module and adds it to the config (`-g` for the global config). | `Config.plugin`; `opencode plugin --help`; Plugins docs |
| Hooks | `event` (every bus event: `session.created`, `session.idle`, `session.deleted`, …), `config` (mutate the loaded config), `chat.message` (the person's message and its parts, before it is stored), `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before` (args), `tool.execute.after` (title, output, metadata), `shell.env`, `experimental.chat.system.transform` (the system prompt array, per model call), `experimental.chat.messages.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `tool.definition`, `tool` (custom tools), `auth`, `provider`, `dispose`. | `Hooks` in `dist/index.d.ts` |
| MCP | `mcp` config: `{ type: "remote", url, headers, oauth, enabled, timeout }` or `{ type: "local", command, environment }`. Remote servers without an `Authorization` header use OAuth (`opencode mcp auth <name>`); `oauth: false` disables it. Tools are named `<server>_<tool>`. | `McpRemoteConfig`, `McpOAuthConfig`; `opencode mcp --help` |
| Commands | `command` config: `{ template, description, agent, model, subtask }`; `$ARGUMENTS` in the template. Also Markdown files under `.opencode/command/`. `opencode run --command <name>` runs one headlessly. | `Config.command`; `opencode run --help` |
| Agents | `agent` config entries with `description`, `prompt`, `mode: "subagent" \| "primary"`, tools and permissions. | `Config.agent`, `AgentConfig` |
| Skills | `skills.paths` / `skills.urls` in config; skills also appear as commands. | v2 `Config.skills` |
| Instructions | `instructions`: extra instruction files, alongside `AGENTS.md`. | `Config.instructions` |
| Config locations | `~/.config/opencode/opencode.json(c)` (global), `./opencode.json(c)` and `./.opencode/opencode.json(c)` (project). Plugin arrays merge across files. | Plugins docs; observed load order in `--print-logs` |
| Headless | `opencode run [message]` with `--format json`, `--model`, `--command`, `--session`; `opencode serve` exposes the HTTP API (`/command`, `/agent`, `/mcp`, `/config`). | `opencode run --help`; observed |

What OpenCode does not have: a hook process protocol like Claude Code's (hooks are functions in its own Bun process),
a transcript file it names to a plugin (sessions live in its database, read through `client.session.messages`), and a
plugin marketplace.

## How Estelle maps onto it

One npm-shaped package, `plugins/opencode` (`@fatelabs/opencode-estelle`), one module
(`adapters/opencode-plugin.mjs`):

| Estelle needs | OpenCode mechanism used |
|---|---|
| MCP tools with the same key as the hooks | The `config` hook adds `mcp.Estelle` (`type: remote`, `https://api.fatelabs.ca/mcp`). With `ESTELLE_API_KEY` in the environment it sends `Authorization: Bearer <key>`, the same key the hooks use. Without it the header is left out so OpenCode's own MCP OAuth can sign in. A server the person already named `Estelle` wins. |
| Session start text and this session's identity line | `event: session.created` runs SessionStart once (or the first hook that meets a resumed session does). Its text goes into `experimental.chat.system.transform`, so it is in the system prompt of every model call and survives compaction. A child session (`parentID`) starts as SubagentStart. |
| Prompt-time recall | `chat.message` runs UserPromptSubmit and adds the recall as a `synthetic: true` text part of the person's message. The model reads it; the transcript mirror skips it. |
| Mail at the tool boundary | `tool.execute.after` runs PostToolUse and appends the delivered mail to the tool's output, which is what the model reads next. Throttled and skipped for subagent sessions by the shared runner. |
| Write warning | `tool.execute.before` runs PreToolUse; a warning is appended to that tool's output. It never blocks. OpenCode's `write`, `edit`, `multiedit`, `patch` and `apply_patch` map to the names the shared warning knows. |
| Capture and checkpoints | `event: session.idle` reads the session through `client.session.messages` and appends what is new to `~/.estelle-plugins/…/transcripts/opencode-<session>.jsonl` (Claude Code's line shape, append-only), then runs Stop, which streams and checkpoints it as harness `opencode`. `experimental.session.compacting` runs PreCompact. `session.deleted` queues the exit save. |
| Commands | The `config` hook adds `estelle:cloud`, `estelle:code`, `estelle:handoff`, `estelle:monitor`, `estelle:resume`, `estelle:review`, `estelle:rooms` from `commands/*.md`, with the runner path filled in exactly. |
| Agents | The `config` hook adds `estelle-grounder`, `estelle-historian`, `estelle-repair`, `estelle-reviewer` as subagents (their prompts; OpenCode gives them its own tools). |
| Skills and instructions | `skills.paths` gets the package's `skills/`; `instructions` gets its `instructions.md`. |

Every event is handed to the same `runtime/cli.mjs hook opencode` runner the other hosts use, in a child Node process,
so a failure there cannot take OpenCode down and `node runtime/cli.mjs doctor` reports it.

## Gaps, said plainly

- Recall cannot be injected without a prompt: a session that only runs commands gets recall when the command's prompt
  is sent, as on every host.
- The transcript is a mirror the plugin writes after each turn, not a file OpenCode keeps. Parts OpenCode never
  finishes (an aborted tool) are not written. A subagent's work is captured as its own session.
- `review`'s input schema has a root `oneOf`. xAI refuses the whole request when any declared tool has one (measured:
  400 `invalid_client_tool_schema`), and OpenCode declares every MCP tool. On xAI models, until the server schema
  change lands, set `"tools": { "Estelle_review": false }`. Other providers were not tested.
- Rooms membership and mail sent to an OpenCode session need the server to list `opencode` as a local host
  (Fate-Labs-CA/estelle server PR). Until then the explicit identity request is refused (HTTP 400); the start
  delivery still prints the session's id and token.
- Headless runs: in this environment `opencode run` sometimes hung during startup whenever any remote MCP server was
  configured, including one with no Estelle involvement (`mcp.deepwiki.com`) and with Estelle configured by hand and no
  plugin. Runs without an MCP server never hung. This is recorded, not explained.

## Listing and publishing

OpenCode has no plugin marketplace or registry. Distribution is npm: a person runs
`opencode plugin @fatelabs/opencode-estelle -g` or adds the name to `plugin` in `opencode.json`.
The community list is the [Ecosystem](https://opencode.ai/docs/ecosystem/) page, whose source is
`services/site/src/docs/v1/content/ecosystem.mdx` in anomalyco/opencode. Its only instruction is "Submit a PR"; there
is no stated review bar. [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) and opencode.cafe
are separate community lists.

0.0.18 is published (`npm view @fatelabs/opencode-estelle time` shows it on 2026-11-19), and it was installed
from npm with `opencode plugin @fatelabs/opencode-estelle -g` in a scratch home: `opencode mcp list` showed
`Estelle connected` and a model turn called `estelle_resume` and `estelle_grep`. No ecosystem listing has been
requested. Steps for a later release:

1. `npm run build`, then from `plugins/opencode`: `npm publish --access public` with an npm account that can publish
   to the `@fatelabs` scope (the scope exists: `@fatelabs/estelle` is published).
2. Check it: `npm view @fatelabs/opencode-estelle version`, then in a scratch config
   `opencode plugin @fatelabs/opencode-estelle` and `opencode mcp list`.
3. Optional listing: a PR to anomalyco/opencode adding one row to `ecosystem.mdx` (a GitHub account; the OpenCode
   maintainers merge or not).
