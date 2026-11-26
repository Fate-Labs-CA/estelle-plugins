# Gemini CLI

Package: `plugins/gemini`, a Gemini CLI extension. Requires Gemini CLI 0.71 or later (`@google/gemini-cli`), Node.js 22 on
the `PATH` of the Gemini CLI process, and `ESTELLE_API_KEY` in that process's environment for hooks. Written against
Gemini CLI 0.71.1.

One extension adds the Estelle MCP server, the `/estelle:*` commands, the skills, the four Estelle subagents, Estelle's
instructions (as the extension's context file) and the session hooks.

## Who pays for the model

Estelle never touches your Google credentials. The model inside Gemini CLI is powered by whatever you signed Gemini CLI in
with: a Gemini Code Assist Standard or Enterprise license, or a Gemini API or Vertex AI key. Estelle neither reads, stores
nor sends that sign-in. Its own key (`ESTELLE_API_KEY`) is separate and only ever goes to `api.fatelabs.ca`.

Since 2026-06-18, Google has moved free individual access and Google AI Pro and Ultra (Google One) sign-in from Gemini CLI
to Antigravity CLI; Gemini CLI now serves Code Assist Standard and Enterprise and API keys (the `@google/gemini-cli`
README states this). Estelle for Antigravity is a separate package. This one is for `gemini`.

## Install

From a clone of this repository:

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
gemini extensions install ./estelle-plugins/plugins/gemini --consent
```

Gemini CLI copies the extension, so run the command again to update it. Restart Gemini CLI. `gemini extensions list`
shows `estelle` with its context file, MCP server and skills; `/commands list` shows the seven `/estelle:*` commands.

## Sign in

MCP signs in with Gemini CLI's own OAuth: in a session, run `/mcp auth Estelle` and sign in in your browser. No key is
needed for this. Hooks cannot use that sign-in; they need `ESTELLE_API_KEY` in the environment Gemini CLI starts from.
Without it, MCP works and the hooks capture nothing.

Gemini CLI starts hooks with your environment, but it can strip variables whose names look like secrets when
`security.environmentVariableRedaction.enabled` is on in `settings.json` (it is off by default). If you turned it on, add
`ESTELLE_API_KEY` to `security.environmentVariableRedaction.allowed`.

On a machine with no browser, add the server with your key instead of signing in:

```sh
gemini mcp add --transport http -H "Authorization: Bearer $ESTELLE_API_KEY" Estelle https://api.fatelabs.ca/mcp
```

## Check it

- `gemini mcp list` shows `Estelle`. In an untrusted folder Gemini CLI disables MCP servers: trust the folder first.
- Type `/estelle:` and the seven commands are offered.
- After a turn with `ESTELLE_API_KEY` set, the session appears on your Estelle Sessions page.
- `node ~/.gemini/extensions/estelle/runtime/cli.mjs doctor` checks the key against the server and lists what each hook did.

Hooks are on by default (`hooksConfig.enabled`); `/hooks panel` lists them. What Gemini CLI can and cannot do for Estelle,
with sources: [docs/hosts/gemini.md](../hosts/gemini.md).

## Update

Gemini CLI copies an extension when it installs it, so pull your estelle-plugins clone and run the install command again, then restart Gemini CLI. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Gemini CLI from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/gemini.md: clone the repository and run `gemini extensions install <clone>/plugins/gemini --consent`. Do not edit Gemini CLI settings by hand. Keep hooks on the ESTELLE_API_KEY environment key; never request or display credentials, and never touch my Google sign-in. Then tell me to restart Gemini CLI and sign in to Estelle with /mcp auth Estelle. Report extension loading, MCP status, and observed hooks separately. No paid installation tests.
```
