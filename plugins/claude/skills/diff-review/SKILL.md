---
name: diff-review
description: "Review a change against both the house style and what was asked. Use when the task involves: review, pr, code review, diff, standards, spec."
user-invocable: false
---

# diff-review

Review the diff against its intended behavior and surrounding contracts.

1. Read the request, constraints, actual diff and repository review rules. Identify the trigger and resulting behavior the change promises.
2. Trace changed interfaces with `find_definition`, `find_usages` and `blast_radius`. Check callers and unchanged paths as well as the edited lines.
3. Look for wrong assumptions, ordering problems, omitted error handling, incompatible data shapes, security boundaries and missing resource limits.
4. Check test evidence. A test should distinguish correct behavior from the plausible broken version; a passing stub that is more forgiving than production does not establish compatibility.
5. Use `review` for a grounded second opinion and `scan` for relevant diff-level security checks. Read and resolve their findings rather than treating a tool call as approval.

Return actionable findings with location, trigger, impact and a suggested correction. State what was reviewed and what remains untested.
