---
name: estelle-production-operations
description: Use when the user asks Estelle about production health, a reported incident, monitored errors, alerts, uptime, or the account's credit usage.
---

# Production operations

Start a production health question with monitor_overview. Use monitor_issues, monitor_issue, monitor_logs, monitor_alerts and monitor_uptime only as the investigation needs them, and read each current schema. Carry through observation windows, disabled checks, coverage limits and unavailable signals. An empty incident list is not proof that monitoring is installed or that every service is healthy.

Connect an observed issue to repository evidence before proposing a fix. A fix comes back as a proposal from work for a person to review and merge; report only the steps you actually observed. Do not merge, deploy, roll back or contact anyone.

Use estelle_usage for the account's spending and remaining credits. It reports usage and changes nothing.

This plugin cannot save automations or change model configuration. If the person asks for either, say so, and use estelle_request with action "ask" only if they want Estelle's answer on record.
