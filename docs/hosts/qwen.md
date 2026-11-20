# Qwen Code: what the host offers and how Estelle uses it

Read on 2026-11-20 from the released package `@qwen-code/qwen-code@0.28.0` (installed and run) and the repository at
tag [v0.28.0](https://github.com/QwenLM/qwen-code/tree/v0.28.0) (commit `895dfca8`).

| Mechanism | Qwen Code 0.28.0 | Source |
|---|---|---|
| Extensions | A directory with `qwen-extension.json` (`name`, `version`, `mcpServers`, `contextFileName`, `commands/`, `skills/`, `agents/`, `hooks`), installed with `qwen extensions install <path or git URL>` into `~/.qwen/extensions/<name>/`. | `packages/core/src/extension/extensionManager.ts`, `docs/users/extension/introduction.md` |
| MCP | `httpUrl` is streamable HTTP. A 401 with `WWW-Authenticate` starts OAuth (discovery and dynamic client registration) from the `/mcp` dialog. `qwen mcp add -t http -H` for a header. | `packages/core/src/tools/mcp-client.ts`, `docs/users/features/mcp.md` |
| Hooks | Command hooks in Claude Code's shape, on by default: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd` and more. Stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `hookSpecificOutput.additionalContext` reaches the model. An extension ships them as `hooks/hooks.json`, where Qwen Code fills in `${CLAUDE_PLUGIN_ROOT}` only. | `packages/core/src/hooks/types.ts`, `docs/users/features/hooks.md`, `packages/core/src/extension/variables.ts` |
| Transcript | JSONL at `~/.qwen/projects/<cwd>/chats/<session>.jsonl`: `user`, `assistant`, `tool_result` and `system` records with Gemini-style `message.parts`. Hook context is appended to the prompt as a `<qwen:user-prompt-submit-context>` part. | A real 0.28.0 session (`test/fixtures/qwen/`) |
| Commands | Markdown with a `description` and `{{args}}`; an extension's `commands/estelle/*.md` become `/estelle:*`. | `docs/users/features/commands.md`, `qwen extensions list` |
| Skills | `SKILL.md` folders in an extension's `skills/`. | `docs/users/features/skills.md` |

## How Estelle maps onto it

| Estelle needs | Qwen Code mechanism used |
|---|---|
| MCP | `mcpServers.Estelle.httpUrl`, URL only, so Qwen Code's own OAuth signs in. |
| Start text, recall | `SessionStart` and `UserPromptSubmit` hooks return `hookSpecificOutput.additionalContext`. |
| Write warning | `PreToolUse` on `write_file` and `edit`. It never blocks. |
| Capture and checkpoints | `Stop` streams and checkpoints Qwen Code's own chat recording (harness `qwen-code`); `PreCompact` checkpoints; `SessionEnd` queues the exit save. |
| Commands, skills, instructions | `/estelle:*`, the shared skills, and `instructions.md` as the context file. |

## Gaps, said plainly

- Subagent sessions are not captured separately.
- Mail and room delivery at a tool boundary are not on: Estelle's server does not yet list `qwen-code` as a host it can
  mail.
- OAuth sign-in against Estelle's server was not run here (it needs a person's browser and account).
