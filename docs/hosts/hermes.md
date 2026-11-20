# Hermes Agent: what the host offers and how Estelle uses it

"Hermes Agent" is Nous Research's agent ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)).
Read on 2026-11-20 from `hermes-agent` 0.19.0 on PyPI (published by Nous Research; installed and run) and the
repository at tag [v0.23.3](https://github.com/NousResearch/hermes-agent/tree/v0.23.3) (commit `caafe538`). The
official installer is `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; building v0.23.3 from git
with pip was refused by its build script outside that installer.

| Mechanism | Hermes Agent | Source |
|---|---|---|
| Plugins | A directory with `plugin.yaml` and an `__init__.py` whose `register(ctx)` registers hooks, tools, slash commands and skills. `hermes plugins install <owner/repo[/subdir] or git URL>`; plugins are off until enabled. | `hermes_cli/plugins.py`, `hermes_cli/plugins_cmd.py` |
| Hooks | In-process Python callbacks: `on_session_start`, `pre_llm_call` (returns `{"context": ...}`, added to the turn's user message), `pre_tool_call`, `post_tool_call`, `post_llm_call` (with `conversation_history`), `on_session_finalize` and more. No transcript path. | `VALID_HOOKS` in `hermes_cli/plugins.py`, `agent/turn_context.py`, `agent/turn_finalizer.py` |
| MCP | `mcp_servers` in `~/.hermes/config.yaml` (`url`, `headers` with `${VAR}`, `auth: oauth`); `hermes mcp add/list/test/login`. A plugin cannot register a server. The PyPI package needs the `mcp` extra. | `hermes_cli/mcp_config.py`, `website/docs/user-guide/features/mcp.md` |
| Sessions | SQLite (`~/.hermes/state.db`), not a file a plugin is given. | `website/docs/developer-guide/session-storage.md` |
| Skills | agentskills.io `SKILL.md`; a plugin's skills resolve as `<plugin>:<skill>`. | `ctx.register_skill` |

## How Estelle maps onto it

| Estelle needs | Hermes mechanism used |
|---|---|
| MCP | Hermes's own config: `hermes mcp add Estelle --url https://api.fatelabs.ca/mcp --auth oauth`, or a header with `${ESTELLE_API_KEY}`. |
| Start text, instructions, recall | `on_session_start` runs SessionStart; the first `pre_llm_call` returns Estelle's instructions and that text, and every `pre_llm_call` returns recall. |
| Write warning | `pre_tool_call` on `write_file` and `patch`, printed to stderr. It never blocks. |
| Capture and checkpoints | `post_llm_call` appends the turn's messages to a mirror under `~/.hermes/estelle/transcripts/` in Claude Code's line shape, then runs Stop on it (harness `hermes`). Event times are capture time. `on_session_finalize` queues the exit save. |
| Commands | `/estelle-cloud`, `/estelle-code`, `/estelle-handoff`, `/estelle-monitor`, `/estelle-resume`, `/estelle-review`, `/estelle-rooms`, each sent as the person's next message. |

Every hook is handed to the same `runtime/cli.mjs hook hermes` runner the other hosts use, in a child Node process.

## Gaps, said plainly

- Subagent (delegated) sessions are captured as their own sessions, not linked to their parent.
- Mail and room delivery at a tool boundary are not on: Estelle's server does not yet list `hermes` as a host it can mail.
- Commands use a dash (`/estelle-review`), not a colon, so they also work in Hermes's messaging gateway.
