---
name: program-repair
description: "Localise, write several patches, and keep the one that holds. Use when the task involves: automated program repair, fault localization, majority vote patch, repair, localize, patch generation."
user-invocable: false
---

# program-repair

Repair a reproducible failure with bounded candidate evaluation.

1. Identify the failing test or executable acceptance condition. If there is none, establish a reproducer before generating patches.
2. Use the traceback and `find_definition`, `find_usages` and `blast_radius` to localize the cause and affected contracts.
3. Set the candidate count, time limit and resource budget. Prefer one minimal fix; use isolated alternatives when the cause or design remains contested.
4. Compile/type-check and run the reproducer for each candidate. Discard candidates that do not fix the target behavior.
5. Run the relevant regression tests and `scan` for changes to security-sensitive surfaces. Use `review` to inspect arguable logic and examine every material finding.
6. Keep the smallest supported repair. If no candidate works within the bounds, report the experiments and unresolved cause rather than declaring success.

Return a reviewable patch and measured before/after evidence. Do not select correctness by model majority vote, merge automatically, or launch paid work without authorization.
