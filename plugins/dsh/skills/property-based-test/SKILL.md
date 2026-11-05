---
name: property-based-test
description: "State what must always be true, then hunt for a counterexample. Use when the task involves: property based, invariant, hypothesis, quickcheck, generative test, shrinking."
user-invocable: false
metadata:
  short-description: "State what must always be true, then hunt for a counterexample."
---

# property-based-test

Test a precise invariant across generated inputs.

1. State the property in observable terms: round-trip, idempotence, ordering, conservation, monotonicity or a postcondition.
2. Read the real function and callers through `find_definition` and `find_usages`. Include the boundary's invalid-input contract in the property.
3. Use the repository's existing property-testing tool or standard test facilities. Read the pinned library's API before adding a new dependency.
4. Bound generated sizes and runtime. Include empty, Unicode, extreme and malformed values that matter to the contract.
5. Run the property and keep a minimized counterexample as a regression fixture when it finds a real defect. Fix the behavior at its shared owner.

Return the invariant, input domain, reproducible seed/example and test result. Generated testing covers the domain exercised; it is not proof over all possible inputs.
