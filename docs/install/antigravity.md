# Google Antigravity (IDE and `agy` CLI)

Package: `plugins/antigravity`, one Antigravity plugin. The IDE and the `agy` CLI read the same plugin format, so the one
directory serves both. Requires Node.js 22 on the `PATH` of the Antigravity process and `ESTELLE_API_KEY` in that process's
environment for hooks. It was written from Antigravity's published plugin documentation and has not been run inside a real
Antigravity install (see [what it supports](../hosts/antigravity.md)).

One plugin adds the Estelle MCP server, every Estelle skill, the seven Estelle commands as skills (`/estelle-cloud`,
`/estelle-code`, `/estelle-handoff`, `/estelle-monitor`, `/estelle-resume`, `/estelle-review`, `/estelle-rooms`), the four
Estelle agents, Estelle's instructions as an always-on rule, and the session hooks.

## Your Google subscription

Your Google AI Pro or Ultra subscription powers the model inside the official Antigravity app and CLI. Estelle only adds MCP,
hooks, skills, agents and a rule. It never reads, stores, copies or uses your Google sign-in or any Google credential, and
nothing in this plugin runs Antigravity for you or on another machine. Antigravity's Additional Terms (section 6) say that using
third party software to access the Service, for example using OpenClaw with Antigravity OAuth, is a breach. Estelle does not
do that: it is a plugin that Antigravity loads itself, and it talks only to Estelle.

## Install

From a clone of this repository, or straight from GitHub:

```sh
agy plugin install https://github.com/Fate-Labs-CA/estelle-plugins
agy plugin install ./estelle-plugins/plugins/antigravity
agy plugin validate ./estelle-plugins/plugins/antigravity
```

Use whichever of the first two fits. If you install from the repository URL, Antigravity needs to find the plugin at
`plugins/antigravity`; if it does not, install from a local clone. In the TUI, `/plugin install <path>` does the same.

## Sign in

MCP signs in with Antigravity's own OAuth. The plugin declares the server by URL only, so Antigravity discovers Estelle's
OAuth metadata and registers itself. It then asks you to finish in the browser. In the app, go to Customizations, Installed,
and choose Authenticate under MCP Servers, then paste the code into Enter authorization code. No key is needed for MCP.

Hooks cannot use that sign-in. They need `ESTELLE_API_KEY` in the environment Antigravity starts from. Without it MCP works
and the hooks capture nothing. GUI apps may not inherit your terminal environment, so quit and reopen the IDE after setting a
key.

## Check it

- `agy plugin list` shows `estelle`. `agy plugin validate --strict ./estelle-plugins/plugins/antigravity` reports no errors.
- `/hooks` in the TUI lists Estelle's five hooks.
- Type `/estelle-` and the seven commands are offered.
- After a turn with `ESTELLE_API_KEY` set, the session appears on your Estelle Sessions page.

## Update

Antigravity does not update this plugin for you. Run the install command again, then start a fresh session. Estelle checks
once a day, at the start of a session, whether a newer release exists and tells the model to mention it once when yours is
behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Google Antigravity from https://github.com/Fate-Labs-CA/estelle-plugins using plugins/antigravity. Follow docs/install/antigravity.md: clone the repository, run `agy plugin validate <clone>/plugins/antigravity`, then `agy plugin install <clone>/plugins/antigravity`. Do not edit Antigravity settings by hand. Keep hooks on the ESTELLE_API_KEY environment key; never request or display credentials, and never touch my Google sign-in. Then tell me to restart Antigravity and authenticate Estelle under MCP Servers. Report plugin validation, MCP sign-in and observed hooks separately. No paid installation tests.
```
