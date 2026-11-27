# Google Antigravity: what the host offers and how Estelle uses it

Read on 2026-11-25 from Antigravity's published documentation, then checked on 2026-11-27 against `agy` 1.5.18 (its
`agy plugin validate`, `agy plugin install` into an isolated HOME, and the docs and changelog bundled in the binary). Never
run signed in. Anything below not marked as checked is read from documentation or third-party write-ups.

Checked with agy 1.5.18: a plugin's slash commands are its skills, read from `skills/` only (a `command-skills/` folder is
ignored, which made `/estelle-login` an unknown command); a plugin's MCP server is named `<plugin>_<server>` with no
de-duplication (so key `tools` shows as `estelle_tools`); MCP sign-in is `/mcp`, the server, `Authenticate`, then the pasted code.

| Mechanism | Antigravity | Source |
|---|---|---|
| Plugin | A directory with `plugin.json` (or `.antigravity-plugin/plugin.json`), `skills/`, `agents/`, `rules/`, `mcp_config.json`, `hooks.json`. The schema rejects unknown manifest fields. One format for IDE and CLI. | [build-plugins](https://antigravity.google/docs/build-plugins), [plugins](https://antigravity.google/docs/plugins) |
| Install | `agy plugin install <name, GitHub URL or path>`, global `~/.gemini/config/plugins/<name>/`, workspace `.agents/plugins/`. `agy plugin validate [--strict] [--json]`. | [plugins](https://antigravity.google/docs/plugins) |
| MCP | `mcp_config.json`, `serverUrl` is Streamable HTTP only. With no `headers` or `oauth`, OAuth 2.0 with PKCE runs on its own through CIMD or dynamic client registration; the code is pasted back into the app. Tokens live in `~/.gemini/antigravity/mcp_oauth_tokens.json`. Tools are named `<plugin>_<server>`. | [mcp](https://antigravity.google/docs/mcp) |
| Hooks | `hooks.json`: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. camelCase stdin (`conversationId`, `workspacePaths`, `transcriptPath`, `lastUserInput`, `toolCall`). Context reaches the model only as `injectSteps` from `SessionStart` and `PreInvocation`. Non-zero exit fails open. | [hooks](https://antigravity.google/docs/hooks) |
| Commands | None of their own. A skill in the plugin's `skills/` folder is invoked as `/<skill-name>`; `disable-model-invocation: true` limits it to that. Other folders are not read. | [build-plugins](https://antigravity.google/docs/build-plugins) |
| Rules | `rules/AGENTS.md` is always on while the plugin is enabled. | build-plugins |
| Agents | `agents/<name>.md` with `mainAgent`, `subagent`, `model`, `tools`, `skills`. | build-plugins |
| Transcript | `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl` (`transcript_full.jsonl` untruncated beside it) for the CLI; the app uses `~/.gemini/antigravity/`. One step per line: `step_index`, `source`, `type`, `status`, `created_at`, `content`, `tool_calls`. Conversation stores (`conversations/<id>.db` or `.pb`) are not read. | Unverified: third-party write-ups, [dev.to](https://dev.to/iromin/antigravity-cli-tutorial-series-part-2-conversations-conversations-and-conversations-j39). The hook passes the real path as `transcriptPath`. |

## How Estelle maps onto it

| Estelle needs | Claude Code | Antigravity |
|---|---|---|
| MCP and one browser sign-in | OAuth from `/mcp` | `serverUrl` only; Antigravity's own OAuth. Not run against Estelle's server. |
| Start text, identity | `SessionStart` context | `SessionStart` `injectSteps`. |
| Prompt memory recall | `UserPromptSubmit` | `PreInvocation` `injectSteps`; one recall per (invocation number, prompt). |
| Conversation capture, checkpoints | `Stop`, `PreCompact`, `SessionEnd` | `Stop` streams and checkpoints the transcript. Format is inferred, so every capture says `current_format_verified: false`. |
| Tool events, reindex after an edit | `PostToolUse` | `PostToolUse`. Antigravity sends the call and any error but not the output, so tool results come from the transcript. |
| Write warning | `PreToolUse` | `PreToolUse` on `write_to_file`, `replace_file_content`, `multi_replace_file_content` (names unverified). Answers `allow` with a reason; never blocks. |
| Daily update notice | `systemMessage` | Added to the start text, which tells the model to say it once. |
| Skills, commands, agents, instructions | native | skills; command skills `estelle-*`; agents (no `tools` list); `rules/AGENTS.md`. |
| Compaction checkpoint | `PreCompact` | Not possible: no compaction event. `Stop` checkpoints after each run. |
| Session-end save | `SessionEnd` | Not possible: no event. `Stop` covers it. |
| Subagent supervision, subagent capture | `SubagentStart/Stop` | Not possible: no subagent event, so the parent is not told what its subagents need and their sessions are not linked. |
| Queued context and mail at a tool boundary | `PreToolUse` and `PostToolUse` context | Not possible: tool hooks cannot inject, and Estelle's server does not list `antigravity` as a host it can mail. |

## Gaps, said plainly

- No signed-in Antigravity session has run these hooks or commands. The plugin passes `agy plugin validate --strict` and
  installs with all components, and is checked against the documented schema by `test/antigravity.test.mjs`.
- The transcript layout and the file-writing tool names are not verified. Recall, `injectSteps` and the decision shape are
  documented.
- Antigravity expands `${VAR}` in `mcp_config.json` only for values it prompts the person for, so the plugin does not send
  `ESTELLE_API_KEY` to MCP. MCP signs in with OAuth and hooks use the environment key, separately.
- A marketplace listing needs `logo` (square, 128 px or more), which this repository does not have yet.
