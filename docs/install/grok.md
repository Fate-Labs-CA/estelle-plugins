# Grok Build

Package: `plugins/grok`. Requires Node.js 22 and `ESTELLE_API_KEY` in the host environment.

```sh
grok plugin install uqeu/estelle-plugins@v0.0.21#plugins/grok
grok plugin enable estelle
```

Review the host’s normal installation and hook trust prompts, then start a fresh session.

[Deterministic setup and migration limits](../migration/from-cli.md): automated cleanup for this host is pending; do not perform guessed config edits. The hosted backend controls permissions and tools.

## Copy/paste setup prompt

```text
Use the current source: read https://github.com/Fate-Labs-CA/estelle-plugins at its latest main (or install the published npm package where one exists), never a cached or older local copy of the repository. Install or update Estelle for Grok Build from https://github.com/Fate-Labs-CA/estelle-plugins using plugins/grok. Follow docs/install/grok.md and docs/migration/from-cli.md. Use native approval and a fresh session; preserve unrelated settings and active sessions. Do not manually edit configuration; automated cleanup of an old install is not available for this host, so report it as pending. Keep hooks and MCP on the same environment key; never request or display credentials. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. No paid installation tests.
```
