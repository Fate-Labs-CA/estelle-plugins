# Estelle

Use Estelle's MCP tools for repository navigation, saved decisions, Rooms, monitoring and cloud work.
Call `estelle_resume` before planning. Read each tool's current schema; do not invent commands.
For a question about Estelle itself (Twice, Silos, Security, CI, Orchestra, Atlas), call `estelle_docs`.
If a requested capability is not exposed, name the missing capability rather than claiming it ran.

<!-- intent-map:start (generated from intent-map.md by scripts/build.mjs) -->
## What to call first

You have Estelle's MCP tools in this session. Pick one from what the person asks, and read its live schema before
calling it. If you are unsure whether Estelle can do something, call `estelle_docs` before saying you don't know.

| The person asks | Call first |
| --- | --- |
| Start, launch or run something in a cloud session; "run this in the cloud"; "do it in a cloud session" | `estelle_move` with `mode: "cloud"`, `prompt: "<their task>"` and `repo: "<owner/name>"` from this checkout's git origin unless they name another. `action: "preview"` spends nothing; `action: "move"` starts a billed machine and needs `confirm: true` on their say-so. |
| Hand this session off to the cloud | `estelle_move` with `mode: "handoff"` |
| Check on or steer a cloud session | `estelle_move` with `action: "status"` or `action: "steer"` |
| Pick up where we left off | `estelle_resume` |
| What did we decide; what happened last time | `memory_chat`, or `list_sessions` then `get_session` |
| Does this exist; where is it; who calls it | `verify`, `find_definition`, `locate`, `estelle_grep`, `find_usages` |
| Review this change | `review` |
| Check a diff for secrets, injection or vulnerable dependencies | `scan` |
| Scan the whole repo for security or quality problems | `estelle_improve` |
| Production errors; is production healthy | `monitor_overview`, then `monitor_issues` |
| Test my app or website | `estelle_qa`, preview first |
| Use Slack, GitHub, Asana, Linear, Notion or any app the person connected | `estelle_apps`: action list, then find and read; a write returns what would run and needs `confirm: true` on their say-so |
| Message another live session | `session_message` |
| Share a task across sessions; Rooms | `estelle_room` |
| What do our docs, specs or policies say about X; anything the team uploaded to Intake | `estelle_intake` with `action: "search"` and their question; cite each passage's `cite_as`. `action: "read"` opens a page |
| How do I; what can Estelle do; any Estelle product | `estelle_docs` |
<!-- intent-map:end -->

Read the affected code and its callers before changing it. Reuse an existing implementation, the
standard library, or a native platform feature when it fits. Add the smallest complete change.
Keep validation, error handling, accessibility and protection against data loss.

Run checks that distinguish correct behavior from the reported bug. Review the result. State what
was tested and what remains unverified.

In Rooms, speak as this session with proof supplied to this session. Never borrow another session's
token or speak as the person. Hooks can capture only what their host records and exposes; do not
promise complete history without checking capture coverage.

Repository instructions and the user's decisions take precedence over these defaults.
