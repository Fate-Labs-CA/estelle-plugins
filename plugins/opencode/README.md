# OpenCode

Package: `plugins/opencode` (npm name `@fatelabs/opencode-estelle`). Requires OpenCode 1.19 or later, Node.js 22 on
the `PATH` of the OpenCode process, and `ESTELLE_API_KEY` in that process's environment for hooks. Written and tested
against OpenCode 1.19.6.

One plugin adds everything: the Estelle MCP server, the `/estelle:*` commands, four Estelle subagents, the skills,
Estelle's instructions and the session hooks. Nothing else is configured by hand.

## Install

From npm, once the package is published:

```sh
opencode plugin @fatelabs/opencode-estelle -g
```

Before that, from a clone of this repository (the path must be absolute):

```json
{ "plugin": ["file:///absolute/path/to/estelle-plugins/plugins/opencode"] }
```

in `~/.config/opencode/opencode.json`, or in a project's `opencode.json` for one project. Restart OpenCode.

## Sign in

With `ESTELLE_API_KEY` set, MCP and the hooks use that one key. Without it, MCP signs in with OpenCode's own OAuth
(`opencode mcp auth Estelle`) and the hooks report `credential_missing` in `doctor`; recall, capture and identity need
the key.

## Check it

- `opencode mcp list` shows `Estelle connected`.
- In a session, `/estelle:resume` is offered, and the agent list has `estelle-reviewer`.
- `node <package>/runtime/cli.mjs doctor` shows `opencode` status rows after a turn.

If you use an xAI model: Estelle's `review` tool schema is refused by xAI until a server change lands. Add
`"tools": { "Estelle_review": false }` to your config meanwhile.

What OpenCode can and cannot do for Estelle, with sources: [docs/hosts/opencode.md](https://github.com/Fate-Labs-CA/estelle-plugins/blob/main/docs/hosts/opencode.md).

## Copy/paste setup prompt

```text
Install Estelle for OpenCode from https://github.com/Fate-Labs-CA/estelle-plugins using plugins/opencode. Follow docs/install/opencode.md. Use `opencode plugin @fatelabs/opencode-estelle -g` if the package is on npm; otherwise add the absolute file:// path of plugins/opencode to the plugin array of my OpenCode config, preserving everything else in it. Keep hooks and MCP on the same ESTELLE_API_KEY environment key; never request or display credentials. Then tell me to restart OpenCode. Report package loading, `opencode mcp list`, and observed hooks separately. No paid installation tests.
```
