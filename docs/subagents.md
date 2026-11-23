# Subagents and Estelle

A subagent is its own session on Estelle's board, under its parent: `<parent session>/agent-<id>`. What Estelle does for
it, and what it does for the agent that started it (estelle#2157).

## What a subagent gets

At its start hook (Claude Code and Codex name the subagent on `SubagentStart`):

- the Estelle guidance the main agent gets at session start, plus a short subagent note: use the tools, hand back and
  stop, say so instead of retrying;
- the per-prompt memory read, with the subagent's task as the query (the task comes from the hook if it carries one,
  else from the first line of the subagent's own transcript; when neither exists yet the read is skipped and the hook
  status says so);
- its own Room identity and `session_token`: `<parent id>-agent-<agent id>`. A subagent used to be handed its parent's
  identity line, which let it speak as the parent. It is never given the parent's token now.

## Tools in a custom agent

`general-purpose` and any agent definition with no `tools:` line inherit every tool, Estelle's included. An agent
definition with a `tools:` list gets exactly that list. To keep Estelle, add its MCP tools by name:

```
tools: Read, Grep, Glob, Bash, mcp__plugin_estelle_Estelle__estelle_resume, mcp__plugin_estelle_Estelle__verify, mcp__plugin_estelle_Estelle__estelle_room, mcp__plugin_estelle_Estelle__session_message
```

Use the `mcp__Estelle__` prefix instead when Estelle was added with `claude mcp add` rather than the plugin.

## What the main agent is told

At its UserPromptSubmit, PostToolUse and Stop hooks the plugin asks the server one question. The answer is at most three
lines, each said once per transition:

```
Estelle: subagent "Review the diff" (toolu_01ab) has been quiet 22 min. You can: read its output, message it (SendMessage), or stop it (TaskStop).
Estelle: subagent "Run the tests" (toolu_01cd) keeps failing: the same tool error 3 times in a row: ModuleNotFoundError: foo. You can: ...
Estelle: 2 subagents still running: "Lint", "Types". Read their output or stop them before you finish.   (Stop only)
```

A Stop hook cannot add model context without blocking the stop, so the Stop line is shown to the person, and the next
prompt's check names whatever is still running. Quiet is "no event recorded for 15 minutes while the parent is active";
the server ends a subagent that did nothing for 2 hours as `abandoned` and one whose parent ended as `parent_ended`.

Kill switch (plugin and server): `ESTELLE_SUBAGENT_SUPERVISION=0`.

## Per host

| Host | Child recorded | Ended by | Parent told | Subagent gets Estelle |
|---|---|---|---|---|
| Claude Code | child transcript | `SubagentStop` with `agent_id`, the child's own final reply, `SubagentHandback`; server abandon after 2 h | yes | yes |
| Codex | child rollout | `task_complete`, `turn_aborted`; server abandon after 2 h | yes | start text and identity; memory only if the hook carries the task |
| Cursor, Grok Build, Qwen Code, Kimi Code | start and stop only (their steps are not captured) | `subagentStop`; server abandon after 2 h | no (no model-context channel at these boundaries) | no |
| OpenCode, Pi, Hermes, dsh | no subagent hook | n/a | n/a | n/a |
