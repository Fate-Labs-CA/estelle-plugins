# fx

"fx" here is the coding agent CLI from Vercel Labs ([vercel-labs/fx](https://github.com/vercel-labs/fx), [fx.sh](https://fx.sh)),
not the JSON viewer of the same name. Package: `plugins/fx`: Estelle's skills and one MCP entry. Read against fx
v0.0.17; not run on a machine here.

fx has MCP and skills but no plugin format and no hooks, so there is nothing to install as a package and sessions are
not captured.

## Install

Add the server in fx and sign in to Estelle in your browser when fx asks:

```text
/mcp add Estelle https://api.fatelabs.ca/mcp
```

Or, to use your key instead of the browser, merge `plugins/fx/mcp.json` into `~/.fx/mcp.json`:

```json
{ "mcpServers": { "Estelle": { "type": "http", "url": "https://api.fatelabs.ca/mcp", "bearer_token_env": "ESTELLE_API_KEY" } } }
```

and start fx from a terminal where `ESTELLE_API_KEY` is set.

Skills: copy them where fx reads skills.

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
mkdir -p ~/.fx/skills && cp -R estelle-plugins/plugins/fx/skills/* ~/.fx/skills/
```

## Check it

- `fx mcp list --json` lists `Estelle`.
- `/mcp show Estelle` lists its tools.

What fx can and cannot do for Estelle, with sources: [docs/hosts/fx.md](../hosts/fx.md).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Set up Estelle for fx (vercel-labs/fx) from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/fx.md: copy plugins/fx/skills into ~/.fx/skills, then tell me to run `/mcp add Estelle https://api.fatelabs.ca/mcp` in fx and sign in. Never request or display credentials. Report skills and MCP status separately, and say that session capture is not available on fx. No paid installation tests.
```
