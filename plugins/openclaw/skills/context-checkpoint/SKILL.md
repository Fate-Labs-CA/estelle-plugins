---
name: context-checkpoint
description: "Summarise, pin what matters, drop the noise, keep going. Use when the task involves: checkpoint, compact, context, summarize, phase, long session."
user-invocable: false
metadata:
  short-description: "Summarise, pin what matters, drop the noise, keep going."
---

# context-checkpoint

Preserve enough evidence for another session to continue accurately.

1. Record the task, user constraints, decisions, changed files, branch/commit, commands with results, and unresolved questions. Distinguish what is built, wired, tested, deployed and probed; mark inapplicable or unfinished states.
2. If you have an actual transcript or conversation messages, call `estelle_checkpoint` with this host's session identity, messages and harness. Do not describe a hand-written summary as the full transcript.
3. When switching hosts, use `estelle_handoff` with the concrete files and next actions. Retain the returned handoff id.
4. Without conversation capture, use `estelle_activity` for this MCP client's activity and state that it does not contain all chat turns.
5. Read the response. A request accepted, a deferred hook, or a local queue file is not proof that the full conversation was stored.

Return where the handoff or checkpoint can be resumed, what it contains, and the known capture limits. Never include credentials in the packet.
