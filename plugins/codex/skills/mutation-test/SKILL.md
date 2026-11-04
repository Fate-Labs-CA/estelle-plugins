---
name: mutation-test
description: "Break the code on purpose and see if your tests notice. Use when the task involves: mutation testing, kill mutants, test effectiveness, mutmut, pitest, unasserted."
user-invocable: false
metadata:
  short-description: "Break the code on purpose and see if your tests notice."
---

# mutation-test

Test whether an assertion detects the fault it is meant to catch.

1. Choose a specific high-value behavior and its named test. Confirm the unchanged implementation passes.
2. In an isolated copy or reversible local change, introduce one realistic defect: remove a check, swap a boundary, invert an operator, or advance state before an acknowledgment.
3. Run the named test and verify it fails because of the intended behavioral difference, not a syntax error or broken fixture.
4. Restore the implementation, rerun the test and keep any improved assertion. Do not mutate a serving deployment or someone else's shared work.
5. If a mutant survives, decide whether it is equivalent behavior or a missing test. Add an assertion only for a meaningful contract.

Report the mutation, test, failure reason and restored pass. Coverage measures execution; this experiment measures the assertion you exercised.
