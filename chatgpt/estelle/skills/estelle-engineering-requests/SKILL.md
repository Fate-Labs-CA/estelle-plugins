---
name: estelle-engineering-requests
description: Use when the user wants Estelle to take on an engineering task, from a tracked request or plan through a reviewed change proposal, a cloud agent, or a follow-up on returned work.
---

# Engineering requests with Estelle

Estelle works on the person's own Estelle account. It answers from indexed repository evidence, records what it did, and returns change proposals that a person reviews and merges. It does not merge or deploy.

For the public Northfold sample used in review, see the [sample scenario](references/northfold-demo.md) and its structured fixture. Keep sample data separate from real work.

Use only the tools the connected Estelle server actually lists, and read each tool's current schema before calling it. The account's plan and permissions decide which actions are available. Never invent a tool, an endpoint, an entitlement or a result.

## Take in a request
For a request addressed to Estelle, call estelle_request with action "ask" and the person's words in text. Report the request ID, status and answer it returns. Use action "list" or "get" to read tracked requests and their timelines. Do not file unrelated conversation as a request. A request made over MCP cannot ask a teammate. Asking spends one metered turn from the account's credits.

## Carry the work forward
Establish the repository, the outcome the person wants, the relevant context and the allowed scope. Use estelle_resume for earlier work, kb_ask for system context and memory_chat for recorded decisions.

For an authorized change to a known file, call work with task, path, repo and a request_id. It returns a proposal with its review outcome, or a job_id to poll. Reuse the request_id when retrying the same attempt, and poll an existing job_id rather than starting a duplicate. A proposal is not a merged change.

Start a cloud agent with estelle_launch_agent only when the person has explicitly asked for one. It provisions a paid machine. Keep its launch_key on retries. Report separately whether a machine started, whether the agent is ready, and whether the task was delivered or is still queued. A running machine is not a finished task. Use estelle_return_agent to bring the work back.

Show any preview, cost ceiling or confirmation the tool requires before a step that spends credits or has side effects. Follow the person's existing authorization and do not ask again for a step they already approved. Credentials stay in the OAuth connection, never in a prompt.

## Close the loop
Use review and estelle_qa on returned changes, and the monitor tools for production follow-up. Read the actual result before reporting completion. Say what was proposed, what was tested, and what is still waiting. A queued job, a proposal or a failed request is not a shipped fix.

Merging, deploying, rolling back and contacting people are outside this plugin. Do not infer any of them from a review or a proposal. If a service is unavailable, name the missing connection or setup and continue with independent work.
