# DeepSeek Harness

Package: `plugins/dsh`. DeepSeek Harness is a developer preview that states it will make breaking changes. This package
is tested against `@deepseek-ai/dsh@0.2.1-rc.5`. It needs Node.js 24.9 or newer (dsh's own requirement), `pnpm` on your
`PATH` for `dsh plugin`, and `ESTELLE_API_KEY` in the host environment.

```sh
git clone --depth 1 https://github.com/uqeu/estelle-plugins
dsh plugin --profile web add "file:$PWD/estelle-plugins/plugins/dsh"
dsh --profile web --dump-config | grep -n estelle
```

Use `--profile headless` for `dsh --profile headless "<task>"`. A plugin belongs to one profile, so add it to each profile
you run, and restart a running profile afterwards.

## What you get

| Estelle | In dsh |
|---|---|
| Repository tools and memory | MCP tools named `mcp__Estelle__<tool>`. Absent when `ESTELLE_API_KEY` is unset |
| Session capture and recall | Our listeners on dsh's agent, tool and session events. Root agent only; subagents are not captured |
| Credential check on file writes | `write`, `edit`, `str_replace_editor` and `apply_patch`. A shell command is not checked |
| Commands | `/estelle-resume`, `/estelle-code`, `/estelle-review`, `/estelle-monitor`, `/estelle-rooms`, `/estelle-cloud`, `/estelle-handoff`. dsh runs commands in its Web UI and SDK profiles; headless takes no slash commands |
| Skills | The shared Estelle skills, ranked below your own |

MCP prompt templates are not supported by dsh, so Estelle offers none here. `/estelle-handoff` and `/estelle-cloud` send the
same instructions as other hosts, but moving a dsh session to Estelle Cloud has not been tested.

## What this package changes in dsh

dsh uploads its session log with each request on its DeepSeek route, including tool results and working paths. Tool results
here include Estelle answers about your repository, so this package turns that upload off (`session-log-deepseek`,
`enabled: false`). To turn it back on, override the row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Feedback telemetry
is a separate dsh setting that this package leaves alone: set `DSH_TELEMETRY_DISABLED=1` to stop it.

## Run dsh on Estelle's models

Estelle's model door works as a custom provider. Add this to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      estelle:
        apiKeyEnv: ESTELLE_API_KEY
        api: openai-responses
        baseURL: https://api.fatelabs.ca/v1
        models:
          - id: axiom
- id: agent-default-model
  config:
    provider: estelle
    model: axiom
```

## Copy/paste setup prompt

```text
Install Estelle for DeepSeek Harness from https://github.com/uqeu/estelle-plugins using plugins/dsh. Follow docs/install/dsh.md. Use the native dsh plugin command, keep any existing profile patch rows, and confirm with `dsh --profile <profile> --dump-config` that the estelle rows are present. Never print ESTELLE_API_KEY.
```
