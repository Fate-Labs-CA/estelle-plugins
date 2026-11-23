# Hermes Agent

Package: `plugins/hermes`, a Hermes directory plugin (`plugin.yaml` and `__init__.py`). Requires Hermes Agent with MCP
support (`hermes-agent[mcp]`, or the official installer), Node.js 22 on the `PATH` of the Hermes process, and
`ESTELLE_API_KEY` in that process's environment for hooks. Tested against hermes-agent 0.19.0 from PyPI; the plugin API
it uses was read against Hermes v0.23.3 on GitHub and is unchanged there.

The plugin adds the session hooks, the skills (as `estelle:<skill>`), the `/estelle-*` commands and Estelle's
instructions. A Hermes plugin cannot register an MCP server, so the server is one more command.

## Install

```sh
hermes plugins install Fate-Labs-CA/estelle-plugins/plugins/hermes --enable
hermes mcp add Estelle --url https://api.fatelabs.ca/mcp --auth oauth
```

The first line installs and enables the plugin (Hermes plugins are off until enabled). The second adds the MCP server
and signs in to Estelle in your browser; no key is needed for MCP.

To use your key for MCP instead of the browser, put this in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  Estelle:
    url: https://api.fatelabs.ca/mcp
    headers:
      Authorization: Bearer ${ESTELLE_API_KEY}
```

## Sign in

Hooks need `ESTELLE_API_KEY` in the environment Hermes starts from. Without it, MCP works and the hooks capture nothing.

## Check it

- `hermes plugins list` shows `estelle` as `enabled`.
- `hermes mcp test Estelle` connects and lists Estelle's tools.
- After a turn with `ESTELLE_API_KEY` set, the session appears on your Estelle Sessions page.

What Hermes can and cannot do for Estelle, with sources: [docs/hosts/hermes.md](../hosts/hermes.md).

## Update

These hosts do not update Estelle for you. Run `hermes plugins install Fate-Labs-CA/estelle-plugins/plugins/hermes --enable`, then restart Hermes. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Hermes Agent from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/hermes.md: run `hermes plugins install Fate-Labs-CA/estelle-plugins/plugins/hermes --enable`, then `hermes mcp add Estelle --url https://api.fatelabs.ca/mcp --auth oauth`. Keep hooks on the ESTELLE_API_KEY environment key; never request or display credentials. Then tell me to restart Hermes. Report plugin loading, `hermes mcp test Estelle`, and observed hooks separately. No paid installation tests.
```
