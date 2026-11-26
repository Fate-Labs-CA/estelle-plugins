# Qwen Code

Package: `plugins/qwen`, a Qwen Code extension. Requires Qwen Code 0.28 or later (`@qwen-code/qwen-code`), Node.js 22 on
the `PATH` of the Qwen Code process, and, for hooks, either `/estelle:login` once or `ESTELLE_API_KEY` in that process's environment. Written and tested
against Qwen Code 0.28.0.

One extension adds the Estelle MCP server, the `/estelle:*` commands, the skills, Estelle's instructions (as the
extension's context file) and the session hooks.

## Install

From a clone of this repository:

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
qwen extensions install ./estelle-plugins/plugins/qwen
```

Restart Qwen Code. `qwen extensions list` shows `estelle` with its commands, skills and context file.

## Sign in

MCP signs in with Qwen Code's own OAuth: run `/mcp` in a session and sign in to **Estelle** in your browser. No key is
needed for this. Hooks have their own sign-in: run `/estelle:login` once and approve the browser page (it runs
`node runtime/cli.mjs setup qwen-code --login`). `ESTELLE_API_KEY` in the environment Qwen Code starts from overrides it.
Credential order for hooks: `ESTELLE_API_KEY`, then the plugin sign-in, then the key the Estelle CLI stored. Without either, MCP works and the first turn says Estelle is not recording.

On a machine with no browser, add the server with your key instead of signing in:

```sh
qwen mcp add --transport http -H "Authorization: Bearer $ESTELLE_API_KEY" Estelle https://api.fatelabs.ca/mcp
```

## Check it

- `qwen mcp list` shows `Estelle` as `Connected` once you have signed in.
- In a session, type `/estelle:` and the seven commands are offered.
- After `/estelle:login` (or with `ESTELLE_API_KEY` set) and one turn, the session appears on your Estelle Sessions page.

Project hooks need Qwen Code's one-time approval, and a headless `qwen -p` run never asks for it. This extension's
hooks are user-level, so that does not apply to them.

What Qwen Code can and cannot do for Estelle, with sources: [docs/hosts/qwen.md](../hosts/qwen.md).

## Update

These hosts do not update Estelle for you. Pull your estelle-plugins clone, run `qwen extensions install ./estelle-plugins/plugins/qwen`, then restart Qwen Code. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Qwen Code from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/qwen.md: clone the repository and run `qwen extensions install <clone>/plugins/qwen`. Do not edit Qwen Code settings by hand. Keep hooks on the ESTELLE_API_KEY environment key; never request or display credentials. Then tell me to restart Qwen Code and sign in to Estelle from /mcp. Report extension loading, /mcp status, and observed hooks separately. No paid installation tests.
```
