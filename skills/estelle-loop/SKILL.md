---
name: estelle-loop
description: "Complete a bounded implementation or repair loop. Use for autonomous build loops, iterative repair, acceptance tests, and propose-test-repair work."
user-invocable: false
---

# estelle-loop

Run an implementation or repair loop under explicit limits.

1. Write the acceptance conditions and inspect the existing implementation and callers with source/navigation tools.
2. Set an iteration bound, deadline and any spending ceiling before starting. Reuse an existing test or reproducer as the acceptance signal.
3. Make the smallest change addressing the current confirmed failure. Run the targeted check and inspect its actual result.
4. When it fails, diagnose the new evidence before another edit. When it passes, run the affected regression/build checks and seek `review` where judgment is needed.
5. Stop when the acceptance conditions are measured, the declared bounds are reached, or progress requires a missing user decision. Report the remaining work plainly.

Do not silently launch paid agents, expand scope, merge or deploy. A loop completing is not proof that its output met the acceptance conditions.
