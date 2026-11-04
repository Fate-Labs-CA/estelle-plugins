---
name: estelle-monitor-install
description: "Wire Estelle Monitor into this repo — traces, subjects and outcomes. Use when the task involves: production monitoring, monitor my app, monitor my agent, watch production, is it working in production, went wrong in production."
user-invocable: false
---

# estelle-monitor-install

Wire monitoring at the application's real execution and identity boundaries.

1. Inspect the existing telemetry setup, entry points, outbound calls, worker jobs and outcome handlers with `locate`, `find_definition` and `find_usages`.
2. Identify what the user needs to observe and the durable subject identifier. Do not substitute a new run id for the customer or resource whose history matters.
3. Reuse existing telemetry where possible. Before adding an SDK or exporter, read its actual supported configuration and pinned API through `research_ask` or the package's source. Do not invent environment variables, package names or ingestion routes.
4. Capture success and failure at the relevant boundaries. Apply redaction before export; do not enable argument or sensitive-content capture without the account owner's authorization.
5. Run a controlled execution and read the resulting evidence back through the available monitor tools. Start with `monitor_overview`; use `monitor_issues`, `monitor_issue`, `monitor_logs` and `monitor_uptime` as applicable.
6. Include a negative control for an event or field that must not be captured. If the live tools cannot expose the required observation, report that verification gap.

Return what is instrumented, where it is visible, the probe results and what was not measured. An SDK import or local test alone does not prove delivery.
