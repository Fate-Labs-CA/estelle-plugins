# mini-swe-agent

Package: `plugins/mini-swe-agent`: one config file and the shared runtime. Requires mini-swe-agent 2.4 or later,
Node.js 22 on the `PATH`, and `ESTELLE_API_KEY` in the environment. Written and tested against mini-swe-agent 2.4.6.

mini-swe-agent's only tool is bash, by design: it has no MCP client, no hooks and no skills. So Estelle reaches it
through one shell command the model runs, `node runtime/cli.mjs mcp`, which calls the same Estelle MCP server with
your key. The config file adds a short Estelle section to mini-swe-agent's system prompt telling the model when to use
it. Sessions are not captured: there is nothing to hook.

## Install

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
export ESTELLE_PLUGIN_ROOT="$PWD/estelle-plugins/plugins/mini-swe-agent"
export ESTELLE_API_KEY=...   # your Estelle key
mini -c mini.yaml -c "$ESTELLE_PLUGIN_ROOT/estelle.yaml" -t "your task"
```

`-c mini.yaml` keeps mini-swe-agent's own default config; the second `-c` is merged on top of it and changes only the
system prompt. Put the two `export` lines in your shell profile to keep them.

## Check it

```sh
node "$ESTELLE_PLUGIN_ROOT/runtime/cli.mjs" mcp tools
```

prints one line per Estelle tool. `Estelle MCP call failed: credential_missing` means `ESTELLE_API_KEY` is not set, and
`credential_rejected` means the key was refused.

What mini-swe-agent can and cannot do for Estelle, with sources: [docs/hosts/mini-swe-agent.md](../hosts/mini-swe-agent.md).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Set up Estelle for mini-swe-agent from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/mini-swe-agent.md: clone the repository, set ESTELLE_PLUGIN_ROOT to its plugins/mini-swe-agent folder, and run mini with `-c mini.yaml -c "$ESTELLE_PLUGIN_ROOT/estelle.yaml"`. Never request or display credentials. Report the output of `node "$ESTELLE_PLUGIN_ROOT/runtime/cli.mjs" mcp tools`. No paid installation tests.
```
