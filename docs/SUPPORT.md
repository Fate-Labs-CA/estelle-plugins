# Host support

| Feature | Claude Code | Codex | Kimi Code | Grok Build | Cursor | OpenCode | Pi |
|---|---|---|---|---|---|---|---|
| Native package and MCP configuration | Included | Included | Included | Included | Included | Plugin `config` hook | `registerMcpServer` |
| Skills | Yes | Yes | Yes | Yes | Yes | Yes (`skills.paths`) | Yes (`pi.skills`) |
| Commands | Native | Plugin skills | Native | Native | Native | Native (`command` config) | Input transform |
| Startup instructions | Hook context | Hook context | Startup skill | Skills/MCP | Rule and hook context | `instructions` + system prompt | System prompt section |
| Automatic recall | Prompt hook | Prompt hook | Prompt hook | Next matching pre-tool hook | Next matching post-tool hook | Prompt hook (synthetic part) | Prompt hook (session message) |
| Transcript capture | Bounded JSONL | Bounded rollout | Bounded main-agent journal | Bounded JSONL (inferred dialect) | Bounded JSONL (inferred dialect) | Plugin-written mirror | Pi session file |
| Subagent capture | Each its own timeline under the parent: the child's transcript is mirrored (`<session>/subagents/`), running from its SubagentStart, ended by its SubagentStop | Each its own timeline under the root: the child's rollout is mirrored; its end is its own turn end | Start and end posted from the SubagentStart/SubagentStop hooks (agent name and result; the child's tool calls are not captured; payload shape not yet seen on a live host) | Start and end posted from the hooks (agent id and result; the child's tool calls are not captured; payload shape not yet seen on a live host) | Start and end posted from the hooks, linked by the spawning tool call id (the child's tool calls are not captured) | Own sessions, not linked to the parent | No subagents |
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

Grok Build's SessionStart hook cannot inject the start text or the Room identity: docs.x.ai/build/features/hooks (read 2026-11-25) says
stdout is ignored for passive events and documents no `additionalContext` for any hook, so this is a platform limit, not a gap in the
plugin. The Estelle skill is the only start-of-session channel Grok has, and the adapter's `PreToolUse` and `PostToolUse` context stays
unverified against a live session.

Grok and Cursor prompt hooks cannot inject context. Recall is queued for a matching supported
tool boundary; a reply with no tool call may receive none. Cursor stop hooks never auto-continue
the agent. Grok and Cursor transcript readers are inferred from the hook payload contract and
third-party observations of the on-disk JSONL, not yet verified against a live host session: their
checkpoints are marked partial, their event times are capture time (the transcript lines carry no
verified timestamps), unrecognized lines are skipped, and Cursor does not record tool outputs.

OpenCode and Pi run Estelle inside the host process and hand each event to the same runner; what each host
can and cannot do is in [hosts/opencode.md](hosts/opencode.md) and [hosts/pi.md](hosts/pi.md).

| Feature | Qwen Code | Hermes Agent | mini-swe-agent | OpenClaw | fx |
|---|---|---|---|---|---|
| Package | Extension (`qwen-extension.json`) | Directory plugin (`plugin.yaml`) | One config file | Agent Plugins bundle | Skills and an `mcp.json` entry |
| MCP | Extension, OAuth from `/mcp` | `hermes mcp add`, OAuth or key | `runtime/cli.mjs mcp` through bash, key only | `openclaw mcp add`, OAuth | `/mcp add`, OAuth or key |
| Skills | Yes | Yes (`estelle:<skill>`) | No | Yes | Yes (copied to `~/.fx/skills`) |
| Commands | Native (`/estelle:*`) | Plugin commands (`/estelle-*`) | No | No | No |
| Automatic recall | Prompt hook | `pre_llm_call` context | No | No | No |
| Transcript capture | Qwen Code's chat recording | Plugin-written mirror (capture-time stamps) | No | No | No |
| Checkpoints and exit save | Yes | Yes | No | No | No |

Qwen Code, Hermes and mini-swe-agent were run end to end in testing against local stand-ins for the model, the MCP
server and the hook API; OpenClaw and fx were not run. Details: [hosts/qwen.md](hosts/qwen.md),
[hosts/hermes.md](hosts/hermes.md), [hosts/mini-swe-agent.md](hosts/mini-swe-agent.md), [hosts/openclaw.md](hosts/openclaw.md),
[hosts/fx.md](hosts/fx.md).

| Feature | Gemini CLI |
|---|---|
| Package | Extension (`gemini-extension.json`, hooks in `hooks/hooks.json`) |
| MCP | Extension, OAuth from `/mcp auth Estelle` |
| Skills, subagent definitions | Yes, yes (the subagents are not captured: Gemini CLI has no subagent hooks) |
| Commands | Native TOML (`/estelle:*`) |
| Automatic recall | `BeforeAgent` hook context |
| Write warning | `BeforeTool`, shown to the person (cannot reach the model) |
| Transcript capture | Gemini CLI's chat recording |
| Checkpoints and exit save | Yes |

Gemini CLI was checked by installing the released CLI, loading the extension, its commands and its agents with the CLI's
own loaders, and running the hooks against recordings in the CLI's format. It was not run signed in. Details:
[hosts/gemini.md](hosts/gemini.md).

Google Antigravity (IDE and CLI) has its own table in [hosts/antigravity.md](hosts/antigravity.md): MCP with its own OAuth, skills, command skills,
agents, a rule, and hooks for recall (`PreInvocation`), capture and checkpoints (`Stop`) and the write warning. It has no compaction,
session-end or subagent event, so those parts are not possible there. It was not run in Antigravity.

Rooms needs server-side host support, an authenticated owner and a session proof. Native hook
identity and Cursor's `user_email` are not substitutes for that proof or permission to share.
Plugins do not take over another terminal or bypass member/admin permissions.

The server exposes the tools available to your account. Read its live schemas before calling an
action. Public packages do not deploy or contain the hosted backend.

Use `node runtime/cli.mjs doctor` from a clone for credential-presence and local status diagnostics.
Use `node scripts/probe.mjs` with the key in your environment for read-only MCP setup checks;
it makes no model call. Neither diagnostic alone proves a successful transcript upload.
