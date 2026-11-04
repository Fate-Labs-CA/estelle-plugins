---
name: grounded-generate
description: "Write several answers, keep the one that passes its own tests. Use when the task involves: best of n, dual-execution consensus, package hallucination, slopsquatting, grounded generation, execution filter."
user-invocable: false
---

# grounded-generate

Generate candidate solutions against real APIs and testable behavior.

1. Read the task's acceptance conditions, existing implementation and dependency versions. Use `find_definition`, `find_usages` and `research_ask` to resolve the APIs being called.
2. Prefer an existing or native solution before writing another implementation. Generate multiple candidates only when the tradeoff warrants the extra work.
3. Keep candidates isolated so their code and test results cannot contaminate one another. Use native host facilities within the user's authorized scope.
4. Run the same discriminating acceptance tests and relevant compatibility checks on each candidate. Use `verify` for applicable API claims and `review` for logic that tests do not settle.
5. Choose the smallest candidate supported by the evidence. Agreement among generated answers is not a substitute for a correct contract or an executable result.

Return the chosen implementation, measured results and relevant alternatives. Do not invent packages or claim a candidate passed a check that was not run.
