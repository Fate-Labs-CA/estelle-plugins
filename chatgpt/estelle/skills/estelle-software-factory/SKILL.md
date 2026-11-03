---
name: estelle-software-factory
description: Use when the user wants Estelle to take an engineering task through its autonomous software factory, from intake to building, testing, review and production follow-up.
---

# Estelle software factory

Estelle is an autonomous AI software factory for self-healing software. Help the person work with the full factory: inference, intake, cloud Silos, QA, security, automations, code review, Atlas, monitoring and contextual team memory.

For the public Northfold demo, use the [sample scenario](references/northfold-demo.md) and its structured fixture. Keep synthetic examples distinct from real customer work.

Use the tools actually exposed by the connected Estelle server. Inspect their current schemas before calling them. An account's services and permissions determine which actions are available. Never invent a missing tool, endpoint, entitlement or successful action.

## Take in a task
For a request addressed to Estelle, use estelle_request with action ask and the person's request in text. Its response carries a request ID, status and answer; report those actual results. Use action list or get to inspect tracked requests and timelines. Do not file unrelated conversation as an engineering request. MCP requests cannot ask a teammate because they have no messaging workspace identity.

## Carry engineering work forward
Establish the repository, requested outcome, relevant context and allowed scope. Use estelle_resume for previous work, Atlas for system context and team memory for decisions. For an authorized change to a known file, work accepts task, path, repo and request_id. Reuse a request_id for the same attempt; poll an existing job_id rather than launching a duplicate.

When a cloud Silo is explicitly authorized, estelle_launch_agent can carry the task, repository and chosen harness into it. It spends money. Preserve its launch_key on retries. Distinguish machine launched, agent_ready, task delivered and queued delivery. A running box is not evidence of a completed task.

Show plans, cost previews and approval steps required by the tool before starting spending or side effects. Follow the person's existing authorization; do not seek repeated permission for an already authorized step. Keep credentials in the supported OAuth flow, never in a prompt or package.

## Complete the loop
Use QA and code review for returned changes and monitoring for production follow-up. Read remote outcomes before reporting completion. Say what was built, tested, proposed and still waiting; a queued job, proposed change or failed request is not a shipped fix.

Merge, deployment, rollbacks and external messages need their own authorization and supported execution path. Never infer them from a build or review result. If a service is unavailable, state the specific missing connection or setup and continue independent work.
