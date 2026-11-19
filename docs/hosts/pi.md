# Pi: what the host offers and how Estelle uses it

"Pi" here is the terminal coding agent by Mario Zechner. It started as `badlogic/pi-mono` with the npm package
`@mariozechner/pi-coding-agent`; that package is now deprecated on npm ("please use @earendil-works/pi-coding-agent
instead going forward", last version 0.73.1) and the project lives at
[earendil-works/pi](https://github.com/earendil-works/pi) (`badlogic/pi-mono` redirects there). Its site is
[pi.dev](https://pi.dev). No other coding agent called Pi was considered.

Read on 2026-11-18. Sources, in the order they were trusted:

1. The released package, installed and read: `@earendil-works/pi-coding-agent@1.5.2` (release
   [v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2), 2026-11-10), including the docs it ships:
   `docs/extensions.md`, `docs/mcp.md`, `docs/packages.md`, `docs/prompt-templates.md`, `docs/skills.md`,
   `docs/session-format.md`, `docs/message-types.md`, `docs/usage.md`. Repository `main` at
   `5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9`.
2. The CLI itself: `pi --help`, `pi mcp list`, `pi --list-models`, and runs in JSON and RPC mode.
3. The gallery: [pi.dev/packages](https://pi.dev/packages) and
   [`.github/ISSUE_TEMPLATE/package-report.yml`](https://github.com/earendil-works/pi/blob/main/.github/ISSUE_TEMPLATE/package-report.yml).

⚠️ Pi changed a lot between 0.73 and 1.5. The 0.73 README said "No MCP"; 1.5.2 has built-in MCP (stdio and
streamable HTTP, OAuth) and lets an extension register a server. This document is about 1.5.2.

## What Pi can do

| Mechanism | Pi 1.5.2 | Source |
|---|---|---|
| Extensions | A TS/JS module whose default export receives `ExtensionAPI` (`pi.on`, `pi.registerTool`, `pi.registerCommand`, `pi.registerMcpServer`, `pi.sendUserMessage`, …). Loaded by jiti, so no build step. | `docs/extensions.md` |
| Events | `session_start` (startup, new, resume, fork, reload), `session_shutdown`, `session_before_compact` / `session_compact`, `input` (raw prompt; can transform or handle), `before_agent_start` (inject a session message, edit system prompt sections), `agent_start` / `agent_end` / `agent_settled`, `turn_*`, `message_*`, `context`, `tool_call` (can block or patch input), `tool_result` (can replace content), `tool_execution_*`, `model_select`, `project_trust`, `resources_discover`, `mcp_servers_change`. | `docs/extensions.md` "Events" |
| MCP | Built in. `~/.pi/agent/mcp.json` and `.pi/mcp.json` (`mcpServers`, Claude-compatible shape), or `pi.registerMcpServer(name, config)` from an extension. HTTP servers take `url`, `headers` (`${VAR}` expands), `oauth`; without an `Authorization` header Pi signs in with OAuth (`/mcp login <name>`, `pi mcp login`). Tools are `mcp__<server>__<tool>`, with `exposure` `codemode` (default), `deferred` (found by `tool_search`), `direct` or `hidden`, per tool through `toolExposure`. | `docs/mcp.md` |
| Commands | Prompt templates (`prompts/*.md`, `$ARGUMENTS`, `$1`…), extension commands (`pi.registerCommand`), skill commands (`/skill:<name>`). | `docs/prompt-templates.md`, `docs/extensions.md` |
| Skills | Agent Skills standard; from `~/.pi/agent/skills`, `.pi/skills`, `.agents/skills`, settings, or a package's `pi.skills`. | `docs/skills.md` |
| Instructions | `AGENTS.md` / `CLAUDE.md` from `~/.pi/agent` and the cwd upward; extensions can add system prompt sections in `before_agent_start`. | `docs/usage.md`, `docs/extensions.md` |
| Sub-agents | None built in, by design. | `docs/usage.md` "Design Principles" |
| Settings | `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project; read only after project trust). `PI_CODING_AGENT_DIR` moves the global folder. | `docs/settings.md`, `docs/usage.md` |
| Sessions | JSONL files under `~/.pi/agent/sessions/`, documented format (version 3). `ctx.sessionManager.getSessionId()` / `getSessionFile()`. | `docs/session-format.md` |
| Packages | npm or git packages with a `pi` key in `package.json` (`extensions`, `skills`, `prompts`, `themes`). `pi install npm:<name>` / `git:<host>/<repo>@<ref>` / a local path; `-l` writes project settings; `pi -e <source>` tries one without installing. | `docs/packages.md` |
| Headless | `-p` (print), `--mode json` (event stream), `--mode rpc`. | `docs/usage.md`, `docs/rpc.md` |

## How Estelle maps onto it

One package, `plugins/pi` (`@fatelabs/pi-estelle`), with `pi.extensions: ["./adapters/pi-extension.mjs"]` and
`pi.skills: ["./skills"]`. The repository root's `package.json` names the same files so a git install works.

| Estelle needs | Pi mechanism used |
|---|---|
| MCP tools with the same key as the hooks | `pi.registerMcpServer("Estelle", …)` with `https://api.fatelabs.ca/mcp`. With `ESTELLE_API_KEY` it sends `Authorization: Bearer <key>`; without it, Pi's own MCP OAuth (`/mcp login Estelle`). Exposure is `deferred` (Pi's `tool_search`) with `estelle_resume`, `estelle_grep`, `verify`, `find_definition`, `find_usages`, `locate`, `memory_chat` and `estelle_move` declared directly. A server named `Estelle` in `mcp.json` wins. |
| Session start text and this session's identity line | `session_start` runs SessionStart; its text becomes the `estelle_session` system prompt section in `before_agent_start`, beside an `estelle` section holding `instructions.md`. System prompt sections survive compaction. `session_start` fires again on `/new`, `/resume`, `/fork` and reload. |
| Prompt-time recall | `before_agent_start` (person's prompts only) runs UserPromptSubmit and returns the recall as a session message (`customType: estelle-recall`, not displayed). |
| Mail at the tool boundary | `tool_result` runs PostToolUse and appends the delivered mail to the result content the model reads next. |
| Write warning | `tool_call` runs PreToolUse; a warning is shown with `ctx.ui.notify` and appended to that tool's result. It never blocks. |
| Capture and checkpoints | `agent_settled` runs Stop with Pi's own session file, which the runner streams and checkpoints as harness `pi` (a reader for Pi's documented format, version 3). `session_before_compact` runs PreCompact; `session_shutdown` queues the exit save. |
| Commands | `/estelle:cloud`, `/estelle:code`, `/estelle:handoff`, `/estelle:monitor`, `/estelle:resume`, `/estelle:review`, `/estelle:rooms`: the `input` event turns the command into the shared command's prompt (runner path filled in), the way a prompt template expands. An autocomplete provider offers them in the TUI. |
| Skills | The 26 shared skills, through the package manifest (`/skill:<name>`). |
| Agents | No equivalent: Pi has no sub-agents. The four agents' workflows are covered by the skills and commands. |

Every event is handed to the same `runtime/cli.mjs hook pi` runner the other hosts use, in a child Node process.

## Gaps, said plainly

- No sub-agents, so no SubagentStart/SubagentStop and no Estelle agents.
- The `/estelle:*` commands are input transforms, not registered commands: they work in the TUI, print, JSON and RPC
  modes, but Pi's command list (`get_commands`) does not name them. A registered command was tried first: in JSON mode
  the process ends when its handler returns, before the turn it started, and a handler that waits for that turn hangs.
- `review` stays deferred: its root `oneOf` schema makes xAI refuse the whole request when declared (measured).
- Rooms membership and mail sent to a Pi session need the server to list `pi` as a local host
  (Fate-Labs-CA/estelle server PR). Until then the explicit identity request is refused (HTTP 400); the start
  delivery still prints the session's id and token.
- `pi -p` (print mode) did not exit in this environment whenever any remote MCP server was configured, Estelle's or
  `mcp.deepwiki.com` with no extension at all. `--mode json` and `--mode rpc` exit normally. Use JSON mode headlessly.
- Project-level packages (`.pi/settings.json`) load only after Pi's project trust is granted.

## Listing on pi.dev and publishing

The [pi.dev gallery](https://pi.dev/packages) lists npm packages that carry the `pi-package` keyword ("The `pi-package`
keyword makes an npm package eligible for discovery in the Pi package gallery", `docs/packages.md`). There is no
submission form and no review before listing; packages can be sorted by downloads, recency and name, and anyone can
report one through the `package-report` issue template (malicious or unsafe behaviour, impersonation,
trademark/TOS), which maintainers triage. Scoped names are fine (the template's placeholder is `@scope/package`).
Optional `pi.image` or `pi.video` fields add a preview; a `CHANGELOG.md` with `## [x.y.z]` headings is shown to people
after an update.

`plugins/pi/package.json` is ready for that: name `@fatelabs/pi-estelle`, keywords including `pi-package`, the `pi`
manifest, `publishConfig.access: public`, Apache-2.0, repository and homepage links, and the install page as README.

Steps (nothing here has been published):

1. `npm run build`, then from `plugins/pi`: `npm publish --access public` with an npm account that can publish to
   the `@fatelabs` scope.
2. Check it: `npm view @fatelabs/pi-estelle keywords pi`, then `pi -e npm:@fatelabs/pi-estelle --mode json "hi"` in a
   scratch `PI_CODING_AGENT_DIR`.
3. Wait for pi.dev to pick it up (it reads npm; no Pi account or approval is involved), then look for it at
   pi.dev/packages. Optional before publishing: add `pi.image` (PNG/JPEG/GIF/WebP URL) for the gallery card.
