# mini-swe-agent: what the host offers and how Estelle uses it

Read on 2026-11-20 from `mini-swe-agent` 2.4.6 on PyPI (installed and run) and the repository at tag
[v2.4.6](https://github.com/SWE-agent/mini-swe-agent/tree/v2.4.6) (commit `a83fcae8`).

| Mechanism | mini-swe-agent 2.4.6 | Source |
|---|---|---|
| Tools | Bash only, by design. Every model class sends `tools=[BASH_TOOL]`; there is no MCP client. | `src/minisweagent/models/litellm_model.py` |
| Config | YAML (`agent.system_template`, `agent.instance_template`, `environment`, `model`). Repeated `-c` files are merged recursively; `-c` alone replaces the default, so keep `-c mini.yaml` first. | `src/minisweagent/run/mini.py`, `src/minisweagent/config/mini.yaml` |
| Environment | Commands run with the process environment plus `environment.env`. | `src/minisweagent/environments/local.py` |
| Hooks, skills, instructions files, MCP | None. Rechecked 2026-11-25 against mini-swe-agent.com: "does not have any tools other than bash"; no hooks, skills or MCP page. | Source search, docs |
| Trajectory | JSON rewritten after every step (`last_mini_run.traj.json` or `-o`). | `src/minisweagent/agents/default.py` |

## How Estelle maps onto it

| Estelle needs | mini-swe-agent mechanism used |
|---|---|
| Estelle's tools | `node runtime/cli.mjs mcp tools` and `mcp call <tool> '<json>'`, which speak streamable HTTP to the Estelle MCP server with `ESTELLE_API_KEY`. |
| Guidance | `estelle.yaml` replaces only `agent.system_template`, whose default is one line, with that line plus an Estelle section. |

## Gaps, said plainly

- No session capture, recall injection or write warning: there are no hooks.
- No browser sign-in: the bridge needs `ESTELLE_API_KEY`.
- Redaction: every string in a tool call's arguments goes through `runtime/redact.mjs` `scrub` before it is sent (`<private>` spans become `[private]`, key shapes are redacted), because this bridge is the one place the model's words leave the machine. Tool answers are not altered. Past 20,000 values or 24 levels of nesting the call is refused rather than sent unscanned.
