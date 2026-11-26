# Google Antigravity (IDE and `agy` CLI)

Package: `plugins/antigravity`, one Antigravity plugin. The IDE and the `agy` CLI read the same plugin format, so the one
directory serves both. Requires Node.js 22 on the `PATH` of the Antigravity process and, for hooks, either `/estelle-login` once or
`ESTELLE_API_KEY` in that process's environment. It was written from Antigravity's published plugin documentation and has not been run inside a real
Antigravity install (see [what it supports](../hosts/antigravity.md)).

One plugin adds the Estelle MCP server, every Estelle skill, the nine Estelle commands as skills (`/estelle-cloud`,
`/estelle-code`, `/estelle-handoff`, `/estelle-login`, `/estelle-logout`, `/estelle-monitor`, `/estelle-resume`, `/estelle-review`, `/estelle-rooms`), the four
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

Hooks have their own sign-in: run `/estelle-login` once and approve the browser page. It runs
`node runtime/cli.mjs setup antigravity --login`, waits up to 10 minutes, and prints `capture_configured`,
`capture_already_configured`, `pending_unsupported_platform` (Windows) or `pending_capture_auth`. Without a sign-in, the first
turn says Estelle is not recording and names `/estelle-login`. `/estelle-logout` ends it.

`ESTELLE_API_KEY` is the override, not a requirement: when set in the environment Antigravity starts from, hooks use it and the
plugin sign-in is not opened. Credential order for hooks: `ESTELLE_API_KEY`, then the plugin sign-in, then the key the Estelle
CLI stored. GUI apps may not inherit your terminal environment, so quit and reopen the IDE after setting a key.

Not proven: neither sign-in (`/estelle-login` for hooks, Authenticate for MCP) has been run signed in against a live Antigravity.
`/estelle-login` is not available on Windows yet, and on a machine with no browser it cannot finish: use a key.

## Check it

- `agy plugin list` shows `estelle`. `agy plugin validate --strict ./estelle-plugins/plugins/antigravity` reports no errors.
- `/hooks` in the TUI lists Estelle's five hooks.
- Type `/estelle-` and the nine commands are offered, including `/estelle-login`.
- After `/estelle-login` (or with `ESTELLE_API_KEY` set) and one turn, the session appears on your Estelle Sessions page.

## Update

Antigravity does not update this plugin for you. Run the install command again, then start a fresh session. Estelle checks
once a day, at the start of a session, whether a newer release exists and tells the model to mention it once when yours is
behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Google Antigravity from https://github.com/Fate-Labs-CA/estelle-plugins using plugins/antigravity. Follow docs/install/antigravity.md: clone the repository, run `agy plugin validate <clone>/plugins/antigravity`, then `agy plugin install <clone>/plugins/antigravity`. Do not edit Antigravity settings by hand. Do not set or ask for an ESTELLE_API_KEY unless I already use one; never request or display credentials, and never touch my Google sign-in. Then tell me to restart Antigravity, run /estelle-login for the hooks, and authenticate Estelle under MCP Servers for the tools. Report plugin validation, MCP sign-in, hook sign-in and observed hooks separately; the sign-ins are unproven live. No paid installation tests.
```
