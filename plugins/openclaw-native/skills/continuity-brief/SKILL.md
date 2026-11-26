---
name: continuity-brief
description: "Start a session knowing what the last one did and decided. Use when the task involves: session start, what did i do last, wake up, continuity, resume, brief."
user-invocable: false
metadata:
  short-description: "Start a session knowing what the last one did and decided."
---

# continuity-brief

Resume prior work from evidence and current state.

1. Call `estelle_resume` with the current task and repository. If the user supplies a handoff id, use `estelle_handoff_resume` and read its freshness verdict.
2. Use `memory_chat` for a focused past decision, or `list_sessions` then `get_session` for a named session. A diary or recalled summary is not automatically the original full chat.
3. If the work is in a Room, inspect `estelle_room` using its current schema: list, get and tail are the read paths. Read the owner's latest status and open tasks.
4. Check the current files, branch, commit and remote status before relying on earlier results. An earlier deployment or test result does not certify the present tree.
5. State what was done, what is still open, and the next concrete action. Preserve the user's settled decisions unless they changed them.

Never impersonate the prior agent or reuse its Rooms write identity. You can continue its work while writing as your own session.
