---
name: estelle-qa-and-review
description: Use when the user wants Estelle to review a diff or pull request, scan a change, or test a running web app with Estelle QA.
---

# Review and QA

## Review a change
For a supplied diff, call review with the exact diff, the repository, and the head commit when known. For a pull request, call review with repo and number instead; Estelle reads it through the account's connected GitHub installation. Review consumes the account's review allowance, and repeated calls can spend again.

Keep findings, evidence gaps and coverage separate from the outcome. A clean review is not proof that the change works end to end or that it was deployed. Use scan for the deterministic checks on a diff.

## Test a running web app
Call estelle_qa with action "preview" first. Give the exact target, allowed origins, environment, journeys, assertions and limits, and label inferred expectations as hypotheses. A preview spends nothing. Action "plan" spends a cloud machine on discovery, and "start" queues a campaign; both need confirm true after the person has seen the preview and accepted its cost.

Read results with action "get" and the returned campaign_id. Queued means queued: only a returned result shows that tests ran. Never report blocked, inconclusive or partial coverage as a pass.

## Security questions
This plugin has no dedicated security scanner. For a security question, use review on the relevant change, or estelle_request with action "ask", and report the actual answer. Do not describe an answer as a completed scan, certification or fix. Keep the work inside systems the person is authorized to test, and never collect or list credentials.

If the host blocks a tool because approval is unavailable, report what was blocked and leave it unrun. Do not retry through another identity or channel.
