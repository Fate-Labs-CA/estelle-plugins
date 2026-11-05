---
name: dead-code-sweep
description: "Find what nothing uses, and remove it safely. Use when the task involves: dead code, cleanup, unused, duplicate, refactor, remove."
user-invocable: false
metadata:
  short-description: "Find what nothing uses, and remove it safely."
---

# dead-code-sweep

Remove code only after checking the ways it can be reached.

1. Establish the actual pain and deletion scope. Do not start a repository-wide cleanup during an unrelated bug fix.
2. Use `find_usages`, `find_references` and `blast_radius` to identify candidates. Read the response's graph coverage before interpreting zero references.
3. Check dynamic registration, command dispatch, reflection, configuration names, plugin entry points, scheduled jobs, migrations and public exports in the affected subsystem.
4. Remove one supported candidate or consolidate one duplicate at its shared owner. Preserve compatibility that callers still use.
5. Run the affected build/type checks and behavior tests, including an actual registration or dispatch path where relevant.

Return what was removed, the evidence that made removal reasonable, and any dynamic paths you could not inspect. Zero indexed callers alone is not proof of dead code.
