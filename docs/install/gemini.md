# Gemini CLI

Package: the repository root (`gemini-extension.json`) and, for clone-based installs, `plugins/gemini`; both are the same Gemini CLI extension. Requires Gemini CLI 0.71 or later (`@google/gemini-cli`), Node.js 22 on
the `PATH` of the Gemini CLI process, and, for hooks, either `/estelle:login` once or `ESTELLE_API_KEY` in that process's environment. Written against
Gemini CLI 0.71.1.

One extension adds the Estelle MCP server, the `/estelle:*` commands, the skills, the four Estelle subagents, Estelle's instructions (as the extension's
context file) and the session hooks.

## Who pays for the model

Estelle never touches your Google credentials. The model inside Gemini CLI is powered by whatever you signed Gemini CLI in
with: a Gemini Code Assist Standard or Enterprise license, or a Gemini API or Vertex AI key. Estelle neither reads, stores
nor sends that sign-in. Its own key (`ESTELLE_API_KEY`) is separate and only ever goes to `api.fatelabs.ca`.

Since 2026-06-18, Google has moved free individual access and Google AI Pro and Ultra (Google One) sign-in from Gemini CLI
to Antigravity CLI; Gemini CLI now serves Code Assist Standard and Enterprise and API keys (the `@google/gemini-cli`
README states this). Estelle for Antigravity is a separate package. This one is for `gemini`.

## Install

One command:

```sh
gemini extensions install https://github.com/Fate-Labs-CA/estelle-plugins
```

Gemini CLI has no subdirectory option, so it reads the repository root, where `gemini-extension.json`, `hooks/hooks.json` and
`commands/estelle/*.toml` sit beside the shared sources (`commands/*.md`, `skills/`, `runtime/`, `instructions.md`), which
Gemini CLI ignores or reads as they are. Root `agents/` holds the four Estelle subagents in Gemini's format (generated; the shared
sources are in `agent-sources/`), so this one command loads all of them. You can instead install from a clone:

```sh
git clone https://github.com/Fate-Labs-CA/estelle-plugins
gemini extensions install ./estelle-plugins/plugins/gemini --consent
```

Gemini CLI copies the extension, so run the command again to update it. Restart Gemini CLI. `gemini extensions list`
shows `estelle` with its context file, MCP server and skills; `/commands list` shows the nine `/estelle:*` commands (`/estelle:login` and `/estelle:logout` among them).

## Sign in

There are two sign-ins here, and `/estelle:login` is the one for hooks.

1. **Hooks (recall, checkpoints, mail, session capture):** run `/estelle:login` in a session and approve the browser page. It
   runs `node runtime/cli.mjs setup gemini-cli --login`, waits up to 10 minutes, and prints a status:
   `capture_configured`, `capture_already_configured`, `pending_unsupported_platform` (Windows) or `pending_capture_auth`.
   Without a sign-in the first turn says Estelle is not recording and names `/estelle:login`.
2. **MCP (the tools):** Gemini CLI's own OAuth. In a session, run `/mcp auth Estelle` and sign in in your browser. No key is
   needed for this.

`ESTELLE_API_KEY` is the override, not a requirement: when it is set in the environment Gemini CLI starts from, hooks use it
and the plugin sign-in is not opened. Credential order for hooks: `ESTELLE_API_KEY`, then the plugin sign-in, then the key
the Estelle CLI stored. If you use a key, note that Gemini CLI can strip variables whose names look like secrets when
`security.environmentVariableRedaction.enabled` is on in `settings.json` (it is off by default); add `ESTELLE_API_KEY` to
`security.environmentVariableRedaction.allowed`. `/estelle:logout` ends the plugin sign-in.

Not proven: the Gemini CLI `/estelle:login` and `/mcp auth Estelle` sign-ins have not been run signed in against a live Gemini
CLI. `/estelle:login` is not available on Windows yet, and on a machine with no browser it cannot finish: use a key.

On a machine with no browser, add the server with your key instead of signing in:

```sh
gemini mcp add --transport http -H "Authorization: Bearer $ESTELLE_API_KEY" Estelle https://api.fatelabs.ca/mcp
```

## Check it

- `gemini mcp list` shows `Estelle`. In an untrusted folder Gemini CLI disables MCP servers: trust the folder first.
- Type `/estelle:` and the nine commands are offered, including `/estelle:login`.
- After `/estelle:login` (or with `ESTELLE_API_KEY` set) and one turn, the session appears on your Estelle Sessions page.
- `node ~/.gemini/extensions/estelle/runtime/cli.mjs doctor` checks the credential against the server and lists what each hook did.

Hooks are on by default (`hooksConfig.enabled`); `/hooks panel` lists them. What Gemini CLI can and cannot do for Estelle,
with sources: [docs/hosts/gemini.md](../hosts/gemini.md).

## Update

Gemini CLI copies an extension when it installs it: run `gemini extensions update estelle` (or install again; for a clone, pull it first), then restart Gemini CLI. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main, never a cached or older local copy of the repository. Install Estelle for Gemini CLI from https://github.com/Fate-Labs-CA/estelle-plugins. Follow docs/install/gemini.md: run `gemini extensions install https://github.com/Fate-Labs-CA/estelle-plugins`. Do not edit Gemini CLI settings by hand. Do not set or ask for an ESTELLE_API_KEY unless I already use one; never request or display credentials, and never touch my Google sign-in. Then tell me to restart Gemini CLI, run /estelle:login for the hooks, and run /mcp auth Estelle for the tools. Report extension loading, MCP status, hook sign-in and observed hooks separately; the sign-ins are unproven live. No paid installation tests.
```
