# Claude Code

Package: `plugins/claude`. Requires Node.js 22 and `ESTELLE_API_KEY` in the host environment.

```text
/plugin marketplace add uqeu/estelle-plugins
/plugin install estelle@estelle-plugins
```

Review the host’s normal installation and hook trust prompts, then start a fresh session.

[Deterministic setup and migration limits](../migration/from-cli.md): automated cleanup for this host is pending; do not perform guessed config edits. The hosted backend controls permissions and tools.

## Copy/paste setup prompt

```text
Install or update Estelle for Claude Code from https://github.com/uqeu/estelle-plugins using plugins/claude. Follow docs/install/claude.md and docs/migration/from-cli.md. Use native approval and a fresh session; preserve unrelated settings and active sessions. After native installation, invoke the installed package runtime/cli.mjs setup claude --apply once as documented; do not manually edit configuration. Report unsupported or unavailable migration as pending. Keep hooks and MCP on the same environment key; never request or display credentials. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. No paid installation tests.
```
