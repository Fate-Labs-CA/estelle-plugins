# OpenClaw

Package: `plugins/openclaw`, an Agent Plugins 1.0.0 bundle (a root `plugin.json` and `skills/`). Requires OpenClaw
2026.11 or later. Read against OpenClaw v2026.11.6; not run end to end, because OpenClaw's MCP commands need Node.js
24.16 or later.

The bundle adds Estelle's skills. The Estelle MCP server is OpenClaw's own MCP configuration, added with one command.
Session capture, recall and the write warning are in the separate native plugin,
[openclaw-native](openclaw-native.md); install one of the two, not both.

## Install

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
openclaw plugins install ./estelle-plugins/plugins/openclaw
openclaw mcp add Estelle --url https://api.fatelabs.ca/mcp --transport streamable-http --auth oauth
openclaw mcp login Estelle
```

`openclaw mcp login` signs in to Estelle in your browser. OpenClaw changes MCP settings only while its Gateway is
stopped. Without `--transport streamable-http`, OpenClaw would try SSE.

## Check it

- `openclaw plugins inspect estelle` shows `Format: bundle` and `Bundle format: agent (Agent Plugins)`.
- `openclaw mcp probe Estelle` lists Estelle's tools.

What OpenClaw can and cannot do for Estelle, with sources: [docs/hosts/openclaw.md](../hosts/openclaw.md).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for OpenClaw from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/openclaw.md: install plugins/openclaw with `openclaw plugins install`, then `openclaw mcp add Estelle --url https://api.fatelabs.ca/mcp --transport streamable-http --auth oauth`, then tell me to run `openclaw mcp login Estelle`. Never request or display credentials. Report bundle loading and `openclaw mcp probe Estelle` separately, and say that session capture is not available on OpenClaw. No paid installation tests.
```
