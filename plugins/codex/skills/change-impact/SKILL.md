---
name: change-impact
description: "Change this and what else has to change? Nothing missed. Use when the task involves: change impact, blast radius, cross-cutting change, what breaks if I change, ripple effect, impact analysis."
user-invocable: false
metadata:
  short-description: "Change this and what else has to change? Nothing missed."
---

# change-impact

Map a proposed change through its real callers and contracts.

1. Name the symbol or file and the behavior or signature that will change. Locate its definition with `find_definition` or `locate`.
2. Use `find_usages` for symbol callers, `find_references` for files importing a file, and `blast_radius` for transitive dependents. Keep their reported coverage limits.
3. Check the affected data model, serializer, API, frontend, migration, job and test boundaries. Include only boundaries supported by the source.
4. Compare the proposed diff with the affected sites. Name callers that still expect the old contract and explain why each needs a change or remains compatible.
5. Run relevant contract/type checks and behavioral tests. Use `verify` for source/API claims and `review` for arguable logic.

Return an affected-file list with reasons, the order of edits, and the checks that will show compatibility. Do not call a partial graph a complete impact map.
