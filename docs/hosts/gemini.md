# Gemini CLI: what the host offers and how Estelle uses it

Read on 2026-11-25 from the released package `@google/gemini-cli@0.71.1` (installed, its bundle read, its extension, command
and agent loaders run against this package) and geminicli.com/docs (extensions reference, hooks reference, custom commands).
No Google sign-in was used and no model was called.

| Mechanism | Gemini CLI 0.71.1 | Source |
|---|---|---|
| Extensions | A directory with `gemini-extension.json` (`name`, `version`, `mcpServers`, `contextFileName`, `settings`, ...) plus `commands/`, `skills/`, `agents/`, `hooks/hooks.json`, `policies/`. `gemini extensions install <path or git URL>` copies it into `~/.gemini/extensions/<name>/`; `link` symlinks. | extensions reference, `gemini extensions validate` |
| MCP | `httpUrl` is streamable HTTP (validate warns it is deprecated for `url` with `type: "http"`; older releases need `httpUrl`). A 401 starts OAuth from `/mcp auth <server>`. | extension manager, `mcp-client` |
| Hooks | Command hooks in `hooks/hooks.json` (not the manifest), on by default. 11 events: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `PreCompress`, `Notification`. Stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp` and each event's fields. `timeout` is in milliseconds. Gemini CLI fills in `${extensionPath}`, `${workspacePath}` and `${/}` there. | hooks reference, `loadExtensionHooks` |
| Transcript | JSONL at `~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl` (subagents under `chats/<parent session id>/`). Line one is metadata; then `user` and `gemini` message records `{id, timestamp, type, content, thoughts, tokens, model, toolCalls[]}`, `info`/`error`/`warning` messages and `{$set}` updates. A message is appended again each time it changes, so ids repeat. `transcript_path` in every hook is this file. | `ChatRecordingService` in the bundle |
| Commands | TOML with `prompt` and `description` and `{{args}}`; an extension's `commands/estelle/*.toml` become `/estelle:*`. | custom commands, `FileCommandLoader` run on this package |
| Skills | `SKILL.md` folders in an extension's `skills/`. | `gemini extensions list` shows all 26 |
| Subagents | `agents/*.md` (preview, on by default): strict frontmatter `name`, `description`, `tools` (Gemini tool names; MCP tools `mcp_<server>_<tool>`). | `parseAgentMarkdown` run on all four |

## How Estelle maps onto it

| Estelle needs | Gemini CLI mechanism used |
|---|---|
| MCP | `mcpServers.Estelle.httpUrl`, URL only, so Gemini CLI's own OAuth signs in. |
| Start text | `SessionStart` returns `hookSpecificOutput.additionalContext`. |
| Prompt recall | `BeforeAgent` returns `additionalContext`, which Gemini CLI appends to that turn's prompt. |
| Tool events | `AfterTool` streams the transcript and queues a reindex after a file edit. |
| Write warning | `BeforeTool`, limited to `write_file` and `replace`. It never blocks. Its output cannot reach the model, so the warning is `systemMessage`, shown to the person. |
| Capture, checkpoints | `AfterAgent` streams and checkpoints Gemini CLI's own chat recording (harness `gemini-cli`); `PreCompress` checkpoints; `SessionEnd` queues the exit save and the next `SessionStart` sends it. |
| Update notice | `SessionStart` `systemMessage`, once a day. |
| Commands, skills, agents, instructions | `/estelle:*`, the shared skills, the four Estelle subagents, and `instructions.md` as the context file. |

## Event mapping

| Gemini CLI | Estelle runtime |
|---|---|
| `SessionStart` | `SessionStart` |
| `BeforeAgent` | `UserPromptSubmit` |
| `BeforeTool` (`write_file\|replace`) | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `AfterAgent` | `Stop` |
| `PreCompress` | `PreCompact` |
| `SessionEnd` | `SessionEnd` |
| `Notification`, `BeforeModel`, `AfterModel`, `BeforeToolSelection` | not used |

## Gaps, said plainly

- Gemini CLI has no subagent hooks (no `SubagentStart` or `SubagentStop`), so Estelle cannot supervise subagents or capture
  their sessions. The four Estelle subagent definitions load; what they do is not captured.
- Queued mail and Room delivery at a tool boundary are not on: Estelle's server does not yet list `gemini-cli` as a host it
  can mail.
- `/estelle:handoff` carries the code but cannot reopen the Gemini CLI conversation in a cloud machine: there is no proven way
  to do that, as for Qwen Code.
- `BeforeAgent` context is appended to the prompt for one turn, so a recalled memory is part of that turn's request (and is
  recorded in the chat file inside `<hook_context>`, which Estelle's capture strips).
- The transcript reader was written from the `ChatRecordingService` source and tested against a recording in that exact
  format, not a recording from a signed-in session. Chat files written by older releases as `.json` (not `.jsonl`) are not read.
- Hooks start with `ESTELLE_API_KEY` only if Gemini CLI passes it: see the redaction setting in the install guide.
- OAuth sign-in against Estelle's server and a live hook run were not exercised (they need a Google login and a model).
