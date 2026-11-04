---
name: test-first
description: "One test, one thin slice, then the next. Use when the task involves: tdd, test, test-first, red green, coverage, unit test."
user-invocable: false
---

# test-first

Build one observable behavior at a time when a regression test will protect a real contract.

1. Choose a thin slice through the public interface and define its acceptance condition. Inspect the existing implementation and test conventions.
2. Write the smallest meaningful test. Run it and confirm it fails for the missing or broken behavior rather than for an unrelated setup error.
3. Implement the minimum change using real repository or dependency APIs. Reuse existing behavior before adding another abstraction.
4. Run the test, then the relevant regression/type/build checks. Refactor with the behavior test still passing.
5. Repeat only for the remaining acceptance conditions. Avoid tests that merely restate implementation details or add ceremony to a trivial reversible edit.

Return the behavior, its before/after result and applicable checks. A passing test command is evidence about the tests it actually ran; it does not establish a coverage percentage.
