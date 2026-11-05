---
name: api-call-ground
description: "Check a function really exists before your code calls it. Use when the task involves: tool call grounding, API call grounding, hallucinated tool call, function calling, argument arity check, resolve callee signature."
user-invocable: false
metadata:
  short-description: "Check a function really exists before your code calls it."
---

# api-call-ground

Check the actual callable contract before using it.

1. For an MCP tool, read this session's tool schema, including required arguments and whether a JSON string wraps the arguments. Tool names alone do not establish a signature.
2. For a repository function, use `find_definition` and read its current definition. Use `find_usages` to see the calling convention.
3. For a dependency, use `research_ask` with the import line and the version the repository pins, or read the installed package's source.
4. Build the call from that contract. Validate optional, null, empty and absent values separately where they mean different things.
5. Use `verify` on applicable generated code; run the project's type checker or a small contract test for behavior that static lookup cannot check.

Report an unsupported call instead of inventing a similar method. A lookup is evidence about the API it examined, not proof that the whole change works.
