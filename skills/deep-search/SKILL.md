---
name: deep-search
description: "Ask a question about your own repo and get a cited answer. Use when the task involves: deep search, deep-search, ask the codebase, natural language codebase question, question about the repo, grounded code q&a."
user-invocable: false
---

# deep-search

Answer a repository question with traceable source evidence.

1. Scope the repository and the precise question. Recall prior decisions with `estelle_resume` or `memory_chat` when they matter.
2. Choose the smallest applicable lookup: `locate` or `find_definition` for a symbol, `find_usages` for callers, `estelle_grep` for text, and `estelle_read` for the relevant source.
3. Read freshness and coverage. Follow continuations or narrow the subtree when the answer depends on omitted material.
4. Trace the actual path from caller to implementation and result. An author-written description shows intent; it does not prove the implementation runs.
5. Answer with file/line evidence and distinguish direct observations from inferences. Use `verify` for a concrete claim when appropriate.

If the connected index cannot answer, say why. A stale result or bounded no-match is not evidence that the feature is missing.
