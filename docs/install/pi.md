# Pi

Package: `plugins/pi` (npm name `@fatelabs/pi-estelle`). Requires Pi 1.5 or later (`@earendil-works/pi-coding-agent`),
Node.js 22 on the `PATH` of the Pi process, and `ESTELLE_API_KEY` in that process's environment for hooks. Written and
tested against Pi 1.5.2.

One package adds everything Pi can take: the Estelle MCP server (through Pi's built-in MCP support), the
`/estelle:*` commands, the skills, Estelle's instructions and the session hooks. Pi has no sub-agents, so the Estelle
agents are not part of it.

## Install

From npm (published as `@fatelabs/pi-estelle`; npm packages with the `pi-package` keyword are eligible for the
[pi.dev package gallery](https://pi.dev/packages)):

```sh
pi install npm:@fatelabs/pi-estelle
```

From GitHub:

```sh
pi install git:github.com/Fate-Labs-CA/estelle-plugins
```

Add `-l` to install for one project (`.pi/settings.json`, used after you trust the project). To try it for one run
without installing: `pi -e git:github.com/Fate-Labs-CA/estelle-plugins`.

## Sign in

With `ESTELLE_API_KEY` set, MCP and the hooks use that one key. Without it, MCP signs in with Pi's own OAuth
(`/mcp login Estelle`) and the hooks report `credential_missing` in `doctor`; recall, capture and identity need the key.

## Check it

- `/mcp` shows `Estelle` connected.
- Type `/estelle:` and the seven commands are offered; `/skill:estelle` is listed.
- For scripts, use `pi --mode json`. `pi -p` did not exit in testing whenever a remote MCP server was configured.

What Pi can and cannot do for Estelle, with sources: [docs/hosts/pi.md](../hosts/pi.md).

## Update

These hosts do not update Estelle for you. Run `pi install npm:@fatelabs/pi-estelle`, then restart Pi or run /reload. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main (or install the published npm package where one exists), never a cached or older local copy of the repository. Install Estelle for Pi from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/pi.md: run `pi install npm:@fatelabs/pi-estelle`. Do not edit Pi settings by hand. Keep hooks and MCP on the same ESTELLE_API_KEY environment key; never request or display credentials. Then tell me to restart Pi or run /reload. Report package loading, /mcp status, and observed hooks separately. No paid installation tests.
```
