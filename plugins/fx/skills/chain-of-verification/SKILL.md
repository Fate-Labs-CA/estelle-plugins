---
name: chain-of-verification
description: "Ask the questions that would prove a draft answer wrong. Use when the task involves: chain of verification, cove, verification questions, independent recall, strike unsupported clauses, draft then verify."
user-invocable: false
metadata:
  short-description: "Ask the questions that would prove a draft answer wrong."
---

# chain-of-verification

Check a draft by asking what evidence could contradict it.

1. Break the draft into separate checkable claims: a signature, a behavior, a default, a measured result, or a prior decision.
2. Turn each into a focused question. Retrieve evidence for the question with source/navigation tools or `memory_chat`, rather than searching only for words that support the draft.
3. Open the relevant source and check the claim's exact scope, freshness and provenance.
4. Mark each claim supported, contradicted, or unresolved. Rewrite contradicted claims and remove or qualify unresolved ones.
5. For executable behavior, run a test or probe that would fail if the claimed behavior were absent. Use `review` when an independent argument about correctness is needed.

Return the revised answer with the evidence and material limits. Re-reading your own draft is not independent verification.
