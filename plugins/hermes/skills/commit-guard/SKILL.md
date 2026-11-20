---
name: commit-guard
description: "Format, lint, typecheck and test before a commit lands. Use when the task involves: commit, pre-commit, hook, staged, format, lint."
user-invocable: false
metadata:
  short-description: "Format, lint, typecheck and test before a commit lands."
---

# commit-guard

Check the exact change that will be committed.

1. Inspect the working tree and staged diff. Separate your files from other people's edits; never discard someone else's work to clean the tree.
2. Read the repository's required checks and run the formatter, linter, type checker, build and targeted tests that apply to this diff. Do not invent a universal command or coverage target.
3. Check that new files and required generated artifacts are included. Verify that tests ran the implementation that is actually staged.
4. Use `scan` on diffs touching credentials, user input, paths, queries or dependencies. Use `review` when correctness needs judgment. Resolve findings or record a justified limit.
5. Recheck status before committing. Commit only the intended paths, using the repository's conventions.
6. When a push is authorized, read the remote commit back before claiming it landed. A successful local command is not a remote receipt.

Return the committed scope and checks that ran, naming skipped or failing checks.
