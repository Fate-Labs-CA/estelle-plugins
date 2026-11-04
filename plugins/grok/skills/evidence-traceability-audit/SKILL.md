---
name: evidence-traceability-audit
description: "Re-open every citation and check it says what was claimed. Use when the task involves: evidence traceability, traceable to evidence, fabricated citation, unreproducible number, untraceable claim, citation audit."
user-invocable: false
---

# evidence-traceability-audit

Check that each important claim can be reproduced from its cited evidence.

1. List the claims that influence a decision: behavior, completeness, safety, performance, state and prior agreement.
2. Open every supporting source using `estelle_read`, navigation tools, session tools or the original artifact. Check freshness, commit, scope and exact wording.
3. Reproduce measurements from their recorded command and inputs when feasible. Keep local results distinct from remote read-back.
4. Check that negative claims have positive controls and that reported counts cover the same population the prose describes.
5. Correct unsupported wording and stale references. Mark an unavailable source or a partial instrument as a limit, not as supporting evidence.

Return the claims that held, corrections with sources, and the unresolved evidence gaps. Do not manufacture a citation or measurement.
