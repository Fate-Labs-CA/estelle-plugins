---
name: estelle-qa-and-review
description: Use when the user wants Estelle QA, code review or a security investigation for an engineering change or running application.
---

# QA, review and security

For a running web app, use estelle_qa action preview first. Define the exact target, allowed origins, environment, journeys, assertions and bounded limits. Mark inferred expectations as hypothesis. A preview spends nothing; plan can spend on discovery, and start requires confirm true after the person has seen the preview and authorized the cost.

Use action get with the returned campaign_id to read verdicts and evidence. Queued means queued; only a returned completed result can establish that tests ran. Never turn blocked, inconclusive or partial coverage into a pass. Evidence should support both a successful behavior and a relevant failure boundary.

For a supplied diff, use review with the exact diff and explicit repository, plus the known head SHA when available. Separate findings, evidence gaps and scope from the verdict. A clean review does not prove deployment or end-to-end behavior.

For security tasks, use a dedicated security tool if the connected server actually exposes one. Otherwise use estelle_request action ask to bring the request to Estelle and report its actual answer. Do not describe an answer as a completed scan, certification, fix or automation unless the result proves that action. Keep vulnerability work within the person's authorized systems and scope. Never collect or enumerate credential sets.

If the host blocks a tool because approval is unavailable, report the blocked action and leave it unrun. Do not retry through a different identity or channel to bypass approval.
