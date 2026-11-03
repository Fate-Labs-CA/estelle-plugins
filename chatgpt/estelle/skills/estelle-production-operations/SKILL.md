---
name: estelle-production-operations
description: Use when the user asks Estelle about production health, incidents, self-healing workflows, inference usage or engineering automations.
---

# Production operations

Start production health questions with monitor_overview. Use monitor_issues, monitor_issue, monitor_logs, monitor_alerts and monitor_uptime only as needed for the user's investigation. Read each current schema. Carry through observation windows, disabled checks, coverage limits and unavailable signals. No returned incidents is not proof that monitoring is installed or that every service is healthy.

Connect an observed issue to repository context before proposing a fix. A self-healing workflow may investigate and prepare a reviewed change; report only the stages actually observed. Do not merge, deploy, roll back or contact anyone without authorization.

Use estelle_usage for reported account spending and remaining credits. It reports usage; it does not change model configuration. For inference configuration or automation requests, inspect the connected tool inventory for a dedicated action. When none is exposed, use estelle_request action ask and explain the returned capabilities, pending steps or refusal. The presence of the request channel does not prove that it can configure every backend service.

Before saving an automation, establish its trigger or cadence, scope and intended action. For monitoring, stay quiet while the state is unchanged unless the person requested routine updates. Do not claim an automation is saved or active without an actual saved ID and read-back from a supported tool.
