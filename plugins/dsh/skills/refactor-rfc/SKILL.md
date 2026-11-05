---
name: refactor-rfc
description: "Name the smell, the target shape, and the order to get there. Use when the task involves: refactor, rfc, debt, cleanup, restructure, smell."
user-invocable: false
metadata:
  short-description: "Name the smell, the target shape, and the order to get there."
---

# refactor-rfc

Plan a refactor around a concrete maintenance problem.

1. Name the current pain and show the source locations that cause it. Use `find_usages`, `find_references`, `blast_radius` and dependency tools to map the actual boundary.
2. Describe the target ownership and public interface. Reuse existing modules and native features where they already fit.
3. Identify behavior and compatibility that must remain unchanged. Add characterization tests where an unmeasured contract would make moving code risky.
4. Order small, reversible steps so each keeps the affected build and tests working. Separate mechanical moves from behavior changes and migrations.
5. Record the risky step, verification command, rollback approach and remaining decisions. Publish to an external tracker only if authorized.

Return the proposed structure and ordered changes with checks. A diagram or plan is not an implemented refactor.
