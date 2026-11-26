# Grok Build

Package: `plugins/grok`. Requires Node.js 22. MCP uses the `ESTELLE_API_KEY` header as shipped, so the key must be in the host environment for the tools. Hooks (recall, checkpoints, mail, capture) sign in with `/estelle:login` once, or with the key, which wins.

```sh
grok plugin install Fate-Labs-CA/estelle-plugins@v0.0.27#plugins/grok
grok plugin enable estelle
```

Review the host’s normal installation and hook trust prompts, then start a fresh session.

[Deterministic setup and migration limits](../migration/from-cli.md): automated cleanup for this host is pending; do not perform guessed config edits. The hosted backend controls permissions and tools.

## Update

These hosts do not update Estelle for you. Run `grok plugin install Fate-Labs-CA/estelle-plugins@v<latest>#plugins/grok`, then start a fresh session. Estelle checks once a day, at the start of a session, whether a newer release exists and shows one line when yours is behind (`ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the check off).

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main (or install the published npm package where one exists), never a cached or older local copy of the repository. Install or update Estelle for Grok Build from https://github.com/Fate-Labs-CA/estelle-plugins using plugins/grok. Follow docs/install/grok.md and docs/migration/from-cli.md. Use native approval and a fresh session; preserve unrelated settings and active sessions. Do not manually edit configuration; automated cleanup of an old install is not available for this host, so report it as pending. Keep MCP on the environment key and tell me to run /estelle:login for hooks; never request or display credentials. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. No paid installation tests.
```

## Optional: sign in to MCP with the host's OAuth (opt-in)

The package ships the `ESTELLE_API_KEY` header, so tools keep working for key users. To try browser sign-in for the tools instead, add the Estelle server yourself with only the URL `https://api.fatelabs.ca/mcp` and no header, and sign in through the host. This is not proven against Estelle's authorization server on this host. Session recording signs in separately with `/estelle:login`; see [capture-auth](../capture-auth.md). That sign-in has not been run signed in against a live Grok.
