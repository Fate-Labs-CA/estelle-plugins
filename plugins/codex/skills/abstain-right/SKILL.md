---
name: abstain-right
description: "Say \"I don't know\" instead of guessing, and ask for what's missing. Use when the task involves: abstain, refuse to guess, guess, fabricate, fabricated answer, no citation."
user-invocable: false
metadata:
  short-description: "Say \"I don't know\" instead of guessing, and ask for what's missing."
---

# abstain-right

Separate an unanswered question from a negative finding.

1. Identify the claim that needs evidence. Use `estelle_resume` or `memory_chat` for a prior decision; use `find_definition`, `locate`, `estelle_grep` or `estelle_read` for source facts.
2. Read coverage and freshness before using the result. No matches in a bounded search do not establish absence from the repository.
3. Use `verify` for a concrete code or repository claim when its scope fits. State what was checked and what the result could not establish.
4. When evidence is missing, name the missing fact and the smallest lookup that could settle it. Ask one focused question only when the answer depends on the user.
5. Continue useful independent work. Do not fill the gap with a remembered signature or turn a stale-index refusal into a false claim that a feature is absent.

Return the supported answer and its source, or a clear statement of the unresolved fact.
