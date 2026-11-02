# Estelle plugins

Estelle for Claude Code, Codex, Kimi Code, Grok Build and Cursor. Each host has its own package
under `plugins/`. They connect to `https://api.fatelabs.ca/mcp`.

Install your coding host first. External Node.js 22+ and a valid `ESTELLE_API_KEY` from your Estelle
account must be available to the actual host process; hooks and MCP use the same key. GUI apps on
macOS and Windows may not inherit your terminal environment. The plugin does not install the host or
Node, or create an account. No backend clone or Estelle CLI is needed.

Version: `0.0.8`.

[Release notes](docs/releases/v0.0.8.md)

| Host | Install instructions and copy/paste setup prompt |
|---|---|
| Claude Code | [Claude](docs/install/claude.md) |
| Codex | [Codex](docs/install/codex.md) |
| Kimi Code | [Kimi](docs/install/kimi.md) |
| Grok Build | [Grok](docs/install/grok.md) |
| Cursor | [Cursor](docs/install/cursor.md) |

## Copy a setup prompt

Paste the matching prompt into your coding agent.

<details>
<summary>Claude Code</summary>

```text
Install or update Estelle for Claude Code from https://github.com/uqeu/estelle-plugins using plugins/claude. Follow docs/install/claude.md and docs/migration/from-cli.md. Preserve unrelated settings and active sessions; remove only verified legacy Estelle hook/MCP registrations. Never request or display credentials. Use native approval and a fresh session. Verify authentication with one advertised read-only MCP tool, then report package, MCP and hooks separately, with any pending step.
```

</details>

<details>
<summary>Codex</summary>

```text
Install or update Estelle for Codex from https://github.com/uqeu/estelle-plugins using plugins/codex. Follow docs/install/codex.md and docs/migration/from-cli.md. Preserve unrelated settings and active sessions; remove only verified legacy Estelle hook/MCP registrations. Never request or display credentials. Use native approval and a fresh session. Verify authentication with one advertised read-only MCP tool, then report package, MCP and hooks separately, with any pending step.
```

</details>

<details>
<summary>Kimi Code</summary>

```text
Check that Kimi Code is installed and that its actual process can find external Node.js 22+ and ESTELLE_API_KEY from my Estelle account; report any missing prerequisite without printing the key. Install Estelle with the native interactive command /plugins install https://github.com/uqeu/estelle-plugins. Follow docs/install/kimi.md and docs/migration/from-cli.md. For a fresh Estelle registration, use /plugins remove estelle and /reload first; preserve chats, unrelated settings, other hosts and shared memories. Use native approval and /reload after installation. Keep hooks and MCP on the same environment key; never request or display credentials. Verify authentication with one advertised read-only MCP tool, then report package, MCP and hooks separately, with any pending step. Do not run kimi -p '/plugins …' or launch a model turn as an installation test. If you cannot operate the interactive TUI, give me the exact GitHub install command and report installation pending.
```

</details>

<details>
<summary>Grok Build</summary>

```text
Install or update Estelle for Grok Build from https://github.com/uqeu/estelle-plugins using plugins/grok. Follow docs/install/grok.md and docs/migration/from-cli.md. Preserve unrelated settings and active sessions; remove only verified legacy Estelle hook/MCP registrations. Never request or display credentials. Use native approval and a fresh session. Verify authentication with one advertised read-only MCP tool, then report package, MCP and hooks separately, with any pending step.
```

</details>

<details>
<summary>Cursor</summary>

```text
Install or update Estelle for Cursor from https://github.com/uqeu/estelle-plugins using plugins/cursor. Follow docs/install/cursor.md and docs/migration/from-cli.md. Preserve unrelated settings and active sessions; remove only verified legacy Estelle hook/MCP registrations. Never request or display credentials. Use native approval and a fresh session. Verify authentication with one advertised read-only MCP tool, then report package, MCP and hooks separately, with any pending step.
```

</details>

Includes MCP connections, coding skills, recall hooks and local credential-pattern protection.
Successful empty recall adds no context. Hook execution alone does not establish MCP authentication.
All five hosts support bounded conversation capture. The Grok and Cursor transcript dialects are
inferred from the hook payload contract, not yet verified against a live host session, so their
captures disclose `format_verified: false` and must not be described as a complete handoff.

The hosted service determines which actions your account can use. Installing a command does not
add a missing backend action. Rooms requires server support and this session's verified identity.

[Host support](docs/SUPPORT.md) · [Migrate from CLI hooks](docs/migration/from-cli.md)

For development: `npm test`, `npm run build`, `npm run check`. Generated packages contain their
own runner and keep writable state outside installed files in `~/.estelle-plugins`.
