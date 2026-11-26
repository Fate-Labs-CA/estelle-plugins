---
name: bug-hunt
description: "Reproduce, shrink, instrument, fix — then lock it with a test. Use when the task involves: bug, debug, diagnose, crash, incident, repro."
user-invocable: false
metadata:
  short-description: "Reproduce, shrink, instrument, fix — then lock it with a test."
---

# bug-hunt

Find a reproducible failure before choosing a fix.

1. Record observed and expected behavior, the exact failing command or request, and the relevant version or commit. Keep credentials out of logs and fixtures.
2. Shrink the reproducer until the necessary input and state are clear.
3. Use `find_definition`, `find_usages` and `blast_radius` to trace the failing path and other callers of the suspected shared function.
4. Rank competing causes. Run a small experiment whose outcomes distinguish them before changing the implementation.
5. Fix the confirmed cause at its owner. Add a regression test that fails on the old behavior and passes on the fix.
6. Run the affected checks and inspect `review` findings when the logic merits review. Broaden testing only for unresolved risks or new failures.

Report the cause, the change, the reproducer's before/after result, and any remaining uncertainty.
