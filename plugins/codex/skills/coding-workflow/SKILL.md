---
name: coding-workflow
description: "Use for implementing features, fixing bugs and refactoring with existing code, native capabilities, measured tests and review. Keep the change as small as the real contract allows."
user-invocable: false
metadata:
  short-description: "Implement a change with existing code, real tests and review."
---

# Coding workflow

1. Understand the request and the observable acceptance conditions. Call `estelle_resume` for prior context, then inspect current source and relevant callers. Do not replace the user's task with a larger speculative rewrite.
2. Before writing new code, stop at the first supported option: remove an unnecessary requirement; reuse repository code; use the standard library; use a native platform feature; reuse an installed dependency; or write the minimum missing implementation. Check reuse through `locate`, `find_definition` and `find_usages`. Check dependency APIs through `research_ask` or their actual source. This is a reasoning discipline, not a blocking scanner.
3. Trace each affected caller and trust boundary. Fix a shared cause once. Preserve input validation, authorization, data-loss handling, security, accessibility and explicitly requested behavior.
4. Work in a reviewable slice. Use isolated worktrees when needed and keep other people's edits intact. Set bounds before retries, scans, batches, background work or paid execution.
5. Test the behavior that matters through the real interface. For a bug, reproduce the failure before fixing it. For an important guard, show that a plausible broken version makes a named test fail. A positive and a negative control should measure the same boundary.
6. Run the repository's required relevant checks. Use `review` for correctness that requires judgment and `scan` for sensitive diffs. Inspect findings, address material defects and state skipped checks. Do not manufacture extra tests for trivial reversible changes or repeat broad suites without a reason.
7. Within the user's authorized scope, commit the intended files and read remote state back after a push or deployment. Do not infer publication, delivery or production behavior from a local success line.
8. Report the changed behavior, evidence and remaining limits. Distinguish built, wired, tested, deployed and probed; a queue receipt is not execution, and a partial read is not complete history. Save a concrete handoff when another session needs to continue.

A smaller implementation is useful only when it preserves the required contract. If a deliberate limitation is necessary, record its owner and upgrade trigger where a future maintainer will see it.
