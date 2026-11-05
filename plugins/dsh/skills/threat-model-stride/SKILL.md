---
name: threat-model-stride
description: "Walk the data flow and ask how each step gets abused. Use when the task involves: threat model, stride, attack surface, trust boundary, spoofing tampering, mitigation."
user-invocable: false
metadata:
  short-description: "Walk the data flow and ask how each step gets abused."
---

# threat-model-stride

Review real data flows and their trust boundaries.

1. Locate entry points, processes, stores and external services with `locate`, `find_definition` and dependency tools. Read the relevant implementation before drawing a flow.
2. At each boundary ask about spoofing, tampering, repudiation, information disclosure, denial of service and elevation of privilege.
3. For each plausible threat, name the attacker capability, affected operation and concrete control: identity/authorization, validation, integrity, redaction, audit, quotas, deadlines or least privilege.
4. Check that the proposed implementation enforces the control on every reachable path. Do not replace security validation with a model's judgment.
5. Run a positive control for authorized behavior and a negative control for the abuse case. Use `scan` for applicable diff-level patterns and `review` for logic.

Return a prioritized threat/control list with source evidence and test results. Label hypotheses and untested controls; a threat model alone is not a security certification.
