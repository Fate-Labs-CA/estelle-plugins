# Codex

Package: `plugins/codex`. Requires Node.js 22 and `ESTELLE_API_KEY` in the host environment.

```sh
codex plugin marketplace add uqeu/estelle-plugins --ref main
codex plugin add estelle@estelle-plugins
codex plugin list
```

For an existing marketplace, run `codex plugin marketplace upgrade estelle-plugins` before reinstalling. Review `/hooks`; `t` grants trust and space only toggles enablement.

Run the [shipped setup command](../migration/from-cli.md#deterministic-setup) after native installation. Codex POSIX cleanup is supported; Windows apply remains pending. The hosted backend controls permissions and tools.

## Copy/paste setup prompt

```text
Install or update Estelle for Codex from https://github.com/uqeu/estelle-plugins using plugins/codex. Follow docs/install/codex.md and docs/migration/from-cli.md. Use native approval and a fresh session; preserve unrelated settings and active sessions. After native installation, invoke the installed package runtime/cli.mjs setup codex --apply once as documented; do not manually edit configuration. Report unsupported or unavailable migration as pending. Keep hooks and MCP on the same environment key; never request or display credentials. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. No paid installation tests.
```
