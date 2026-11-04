---
name: incident-rca
description: "Triage a firing incident without guessing what to look at. Use when the task involves: incident, alert, pager, triage, sev, anomaly."
user-invocable: false
---

# incident-rca

Investigate a live production incident from the signal to a confirmed cause.

1. Read `monitor_overview`, then the relevant `monitor_issues`, `monitor_issue`, `monitor_alerts`, `monitor_logs` and `monitor_uptime` results. Record the observed signal, time window, affected service and known impact.
2. Read any team-defined severity and escalation policy. Severity labels such as Sev2 are policy labels, not a universal measure of impact.
3. Recall related incidents with `memory_chat` and inspect actual recent changes. Timing suggests a hypothesis; it does not establish causation.
4. Trace suspected code with `find_definition`, `find_usages` and `blast_radius`. Run a controlled probe that distinguishes the likely causes without worsening production.
5. Prepare the smallest authorized mitigation and a reproducer. Review and test the change; follow the repository's deployment rules and read the running result back before reporting recovery.
6. Preserve the evidence, timeline, remaining risks and next actions in a handoff or session record. Confirm resolution from a later observation of the signal.

Monitor tools listed here are read-only. If this host does not expose an incident-management or notification-setting action, state that limit instead of claiming to acknowledge an incident, change recipients or send a page.
