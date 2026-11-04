---
name: root-cause-loop
description: "Find why it happens before changing anything. Use when the task involves: debug, root cause, systematic, heisenbug, flaky, investigate."
user-invocable: false
metadata:
  short-description: "Find why it happens before changing anything."
---

# root-cause-loop

Choose experiments that distinguish causes before editing the implementation.

1. Record the observed failure, expected behavior and minimal input/state. Confirm the failure is current.
2. Trace the real path with `find_definition` and `find_usages`; identify the point where expected and observed states diverge.
3. List the competing explanations and the evidence each predicts. Run the cheapest controlled experiment that would separate them.
4. Update the explanation from results, including evidence that disproves your first guess. Bound repetitions and state what remains unknown.
5. Fix the confirmed shared cause and prove it with a regression that fails before and passes after. Check other affected callers with `blast_radius` and relevant tests.

Return the confirmed cause, decisive experiment and fix. If the evidence only narrows the candidates, say that rather than labeling a hypothesis as the cause.
