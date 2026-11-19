# Host support

| Feature | Claude Code | Codex | Kimi Code | Grok Build | Cursor | OpenCode | Pi |
|---|---|---|---|---|---|---|---|
| Native package and MCP configuration | Included | Included | Included | Included | Included | Plugin `config` hook | `registerMcpServer` |
| Skills | Yes | Yes | Yes | Yes | Yes | Yes (`skills.paths`) | Yes (`pi.skills`) |
| Commands | Native | Plugin skills | Native | Native | Native | Native (`command` config) | Input transform |
| Startup instructions | Hook context | Hook context | Startup skill | Skills/MCP | Rule and hook context | `instructions` + system prompt | System prompt section |
| Automatic recall | Prompt hook | Prompt hook | Prompt hook | Next matching pre-tool hook | Next matching post-tool hook | Prompt hook (synthetic part) | Prompt hook (session message) |
| Transcript capture | Bounded JSONL | Bounded rollout | Bounded main-agent journal | Bounded JSONL (inferred dialect) | Bounded JSONL (inferred dialect) | Plugin-written mirror | Pi session file |
| Subagent capture | Each its own timeline under the parent (`<session>/subagents/`, bounded per run) | Not captured (child threads are separate rollouts) | Not captured (main-agent journal) | Not captured | Not captured | Own sessions, not linked to the parent | No subagents |
| Checkpoints | Bounded conversation | Bounded conversation | Active main-agent branch | Bounded conversation (inferred dialect) | Bounded conversation (inferred dialect) | Bounded conversation | Bounded conversation (all branches) |
| Exit save | Reference; retry later | Reference; retry later | Reference; retry later | Reference; retry later | Reference; retry later | Reference; retry later | Reference; retry later |
| Hook approval after an update | Not required | Required; see [Codex](install/codex.md) | Host prompt | Host prompt | Host prompt | Not required | Project trust for project installs |

This table describes packaged paths, not a claim that a particular installation has run. Check
package loading, MCP authentication and actual hook execution separately. Successful empty recall
adds no context; failures retain a separate local status and supported context-bearing errors.

## Operating systems and verification

Compatibility depends on both the coding host and the operating system. Use the host's supported
installation and make Node.js 22+ and `ESTELLE_API_KEY` available to that actual process. A terminal
environment check does not establish that a GUI app inherited the same settings.

GitHub Actions runs the shared Node build and tests on Ubuntu, macOS and Windows. Estelle CI uses
the explicit Linux job in `.estelle/ci.yml` because its workflow parser does not support GitHub's
matrix strategy. That Linux job does not replace the three GitHub Actions jobs or certify Windows
or macOS. A passing shared Node suite also does not certify native installation, authentication
and hooks across all fifteen host/OS combinations. Windows skips for POSIX-only filesystem cases
do not establish equivalent Windows ACL protection.

Hooks require a usable `ESTELLE_API_KEY`; a separate MCP OAuth login does not establish hook
identity. Captures omit media bytes and private/encrypted reasoning. Bounds, missing transcripts,
queued uploads and unsupported formats are not complete history.

Grok and Cursor prompt hooks cannot inject context. Recall is queued for a matching supported
tool boundary; a reply with no tool call may receive none. Cursor stop hooks never auto-continue
the agent. Grok and Cursor transcript readers are inferred from the hook payload contract and
third-party observations of the on-disk JSONL, not yet verified against a live host session: their
checkpoints are marked partial, their event times are capture time (the transcript lines carry no
verified timestamps), unrecognized lines are skipped, and Cursor does not record tool outputs.

OpenCode and Pi run Estelle inside the host process and hand each event to the same runner; what each host
can and cannot do is in [hosts/opencode.md](hosts/opencode.md) and [hosts/pi.md](hosts/pi.md).

Rooms needs server-side host support, an authenticated owner and a session proof. Native hook
identity and Cursor's `user_email` are not substitutes for that proof or permission to share.
Plugins do not take over another terminal or bypass member/admin permissions.

The server exposes the tools available to your account. Read its live schemas before calling an
action. Public packages do not deploy or contain the hosted backend.

Use `node runtime/cli.mjs doctor` from a clone for credential-presence and local status diagnostics.
Use `node scripts/probe.mjs` with the key in your environment for read-only MCP setup checks;
it makes no model call. Neither diagnostic alone proves a successful transcript upload.
