# OpenClaw (native plugin)

Package: `plugins/openclaw-native`: `openclaw.plugin.json`, an in-process JavaScript plugin and the shared runtime. It adds
what the [skills bundle](openclaw.md) cannot: recall, a write warning, session capture, checkpoints and mail, through
OpenClaw's typed plugin hooks. It also ships the 26 skills, the 7 commands and the 4 agents, all as skill roots (OpenClaw has
no command or agent format a plugin registers). Requires OpenClaw 2026.11 or later and Node.js 22 on the `PATH`
(OpenClaw's own plugin commands need 24.16). The bundle in `plugins/openclaw` is unchanged and still installs on its own; a
directory holding both would load as native only, so they are separate folders. Install one of them.

**Not run inside a live OpenClaw gateway.** It was written against the OpenClaw 2026.11.10 documentation and package, and its
handlers are tested with a stand-in `api`. Capture is marked unverified until a live run shows the real shape of
`agent_end`'s `messages`, which the docs name no fields for.

## Install

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
openclaw plugins install --link ./estelle-plugins/plugins/openclaw-native --force
openclaw plugins enable estelle
openclaw mcp add Estelle --url https://api.fatelabs.ca/mcp --transport streamable-http --auth oauth
openclaw mcp login Estelle
export ESTELLE_API_KEY=...   # the hooks need your key; the MCP sign-in does not give it to them
```

Prompt and capture hooks need conversation access. The manifest declares `contracts.conversationAccess: ["read"]`; if
OpenClaw asks for approval, give it, or set this in `openclaw.json` (under `hooks`, not under the plugin's `config`):

```json
{ "plugins": { "entries": { "estelle": { "enabled": true, "hooks": { "allowConversationAccess": true } } } } }
```

## What each hook does

| OpenClaw hook | Estelle |
|---|---|
| `session_start` | Asks for this session's identity (id and token) and any waiting mail. |
| `before_prompt_build` | Puts the instructions and identity in `prependSystemContext`; recall, a queued write warning and queued mail in `prependContext`. |
| `before_tool_call` | The write warning for an exact vendor key shape. It never blocks or rewrites. |
| `after_tool_call` | Reads this session's mail at the tool boundary. |
| `agent_end` | Writes the run to a transcript mirror, then captures and checkpoints it. |
| `before_compaction` / `session_end` | Checkpoint and exit save. |

Where text can go: OpenClaw's `after_tool_call` and `agent_end` return nothing the model reads. So mail pulled at a tool call
and a write warning wait for the next `before_prompt_build`, and reach the model there, not inside the tool result as on
Claude Code.

## Not done

- Subagent start and stop (`subagent_spawned` and `subagent_ended` exist; child capture and supervision are not wired).
- The MCP server is not in the package: a plugin's remote MCP entry cannot carry OAuth, so it stays `openclaw mcp add`.
- Capture is from `agent_end`'s messages, so a turn that never ends (a killed gateway) is not captured.

Details and sources: [docs/hosts/openclaw.md](../hosts/openclaw.md).
