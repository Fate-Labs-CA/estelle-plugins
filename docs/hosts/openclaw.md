# OpenClaw: what the host offers and how Estelle uses it

Read on 2026-11-20 from the repository at tag [v2026.11.6](https://github.com/openclaw/openclaw/tree/v2026.11.6)
(commit `06afb10d`) and the npm package `openclaw@2026.11.6`, installed here. `openclaw --version` ran; its MCP and
plugin commands refuse Node.js 22 (they need 24.16 or later), so nothing past that was run.

| Mechanism | OpenClaw 2026.11.6 | Source |
|---|---|---|
| Bundles | Agent Plugins 1.0.0 (`plugin.json` with the standard's `$schema`, `skills/`, optional `mcp.json`), Codex, Claude and Cursor bundles map into native skills and MCP. A bundle's remote MCP entry takes only `type`, `url` and `headers`. | `docs/plugins/bundles.md`, `src/plugins/bundle-manifest.ts`, `src/plugins/bundle-mcp.ts` |
| Native plugins | `openclaw.plugin.json` plus TypeScript code with in-process hooks (`before_prompt_build`, `session_start`, `after_tool_call`, `agent_end`, ...); prompt hooks need `allowConversationAccess`. | `docs/plugins/manifest.md`, `docs/plugins/hooks.md` |
| MCP | `mcp.servers` in `~/.openclaw/openclaw.json`; `transport: streamable-http` must be set (the default is SSE); `auth: oauth` with `openclaw mcp login`; `openclaw mcp add/probe/tools`. | `docs/cli/mcp/transports.md`, `docs/cli/mcp/registry.md` |
| Sessions | SQLite under `~/.openclaw/agents/<agentId>/agent/`. | `docs/concepts/session.md` |

## How Estelle maps onto it

| Estelle needs | OpenClaw mechanism used |
|---|---|
| Skills | The Agent Plugins bundle in `plugins/openclaw`, or `plugins/openclaw-native`'s `skills` list. |
| Commands, agents | Skill roots in `plugins/openclaw-native` (`command-skills`, `agent-skills`), listed in its manifest `skills`. |
| Hooks, recall, capture, mail | `plugins/openclaw-native`: `adapters/openclaw-plugin.mjs` (`session_start`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_end`, `before_compaction`, `session_end`). |
| MCP | OpenClaw's own MCP config, added with `openclaw mcp add ... --transport streamable-http --auth oauth` (a bundle entry cannot carry OAuth). |

## Gaps, said plainly

- The bundle (`plugins/openclaw`) has no capture, recall or write warning; the native plugin (`plugins/openclaw-native`) has them. See [install/openclaw-native.md](../install/openclaw-native.md).
- The native plugin was read against openclaw 2026.11.10 (`docs/plugins/hooks/*`, `dist`). Its docs name no fields for `agent_end`'s `messages`, so the mirror reads both shapes seen in agent hosts and capture is marked `current_format_verified: false`.
- Observe hooks (`after_tool_call`, `agent_end`) return nothing the model sees, so mail and a write warning arrive at the next prompt build.
- Not run end to end here (Node.js 24 was not available on the test machine); handlers are tested with a stand-in `api`.
