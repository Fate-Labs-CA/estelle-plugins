# Replace a legacy installation

Install the host-specific package linked in the README using native approval. The hosted account,
saved memory, unrelated security hooks and other MCP servers stay in place. Installation does not
run a hidden post-install migration or approve hook trust.

## Deterministic setup

After installing the replacement, an installer agent should invoke the **shipped** entry once,
using the actual installed Estelle package directory, not a guessed version-cache path:

```sh
node "<installed Estelle package>/runtime/cli.mjs" setup codex --apply
```

For a nonmutating preview, omit `--apply`. The preview returns a public `plan_sha256`; optionally
pass `--expect <that SHA256>` with `--apply` to refuse a changed plan. Do not paste configuration,
credentials or command output from native MCP JSON listings into chat.

If the native MCP login is connected but no canonical hook key is inherited, run `/estelle:login` for the
[one sign-in](../capture-auth.md). The migration below still requires its own MCP check.

Claude Code has [its own path](#claude-code). For Codex, the automated migration supports **POSIX only**. It:

1. Requires the canonical `ESTELLE_API_KEY` in the setup process environment. It does not read
   credential files or accept a separate MCP OAuth login as hook authentication. Missing or
   unavailable authentication returns `pending_auth` and changes nothing.
2. Checks the installed/enabled native package version and this package's canonical MCP descriptor,
   then makes one bounded authenticated MCP `initialize` request to `https://api.fatelabs.ca/mcp`.
   This is a protocol/authentication check, not a model or cloud launch.
3. Inspects only the user `hooks.json` under `CODEX_HOME` (otherwise `~/.codex`). It removes exact
   known legacy `estelle hook` commands for their matching events, including the supported
   `@fatelabs/estelle` runners. Unknown commands, foreign hooks, matchers, options and order remain.
   Missing files are not created. Malformed, oversized, duplicate-key or symlink files refuse.
4. Uses the native **non-JSON** MCP descriptor to recognize only the separate lowercase `estelle`
   registration with the exact same endpoint and canonical environment descriptor, without extra
   headers or policy overrides. Only that proven duplicate may be removed with `codex mcp remove
   estelle`. The plugin-owned `Estelle` server and unfamiliar registrations remain.

A configuration change during setup refuses. Do not run another configuration editor concurrently:
checks plus atomic file replacement do not provide a kernel-level compare-and-swap against foreign
writers, and the native MCP remove command has its own read/write window. Setup uses an exclusive
lock for its own writers. A leftover lock requires inspection, never automatic deletion.

An ambiguous native remove or file-commit acknowledgment returns `unknown` or `partial` and stops;
it does not retry or roll back another writer. Inspect the current native state before deciding
what to do next. No configuration backup containing authentication material is created. Foreign
values remain in their configuration file, never in the setup report.

Cursor, Kimi and Grok have no automated cleanup, so do not run setup for them: it only reports
`pending_unsupported_host`. On Windows, Codex and Claude Code apply return `pending_unsupported_platform`. Their native
installation still works. Keep those migration steps pending rather than replacing them with ad hoc
configuration surgery. Project hooks and unfamiliar MCP registrations also remain pending
native-manager review.

## Claude Code

`setup claude` needs no key and finds one of two paths. `fresh`: nothing to do. `migrate`: an old
install was found. It requires the replacement `estelle@estelle-plugins` to be installed first, so a
failed step never leaves you with neither.

`setup claude --apply` makes two changes:

1. It removes exact known legacy `estelle hook` commands from your user `settings.json` (under
   `CLAUDE_CONFIG_DIR`, otherwise `~/.claude`). Other hooks, matchers, keys and order stay, and a
   malformed or symlinked file refuses.
2. It runs `claude plugin uninstall estelle@fatelabs --keep-data --scope user`, then reads the plugin
   list back. An install in project or local scope stays and is reported, because that scope belongs to
   a repository.

Claude Code's sessions, Estelle's saved memory, the old plugin's saved data, other plugins and the
registered `fatelabs` marketplace are not touched. An old `estelle` MCP server you added by hand also
stays. Setup prints file names and counts, never a key or the contents of a shell file.

## Trust, reload and evidence

Use the host's normal hook approval and reload flow, then start a fresh session. In Codex `/hooks`,
`t` grants trust while space only toggles enablement, and [every update needs this again](../install/codex.md#approve-the-hooks-after-installing-and-after-every-update).
Setup reads whether Codex's hooks need review and says so. It never changes trust, global permissions,
active sessions, plugin caches, `AGENTS.md` or `CLAUDE.md`.

Versions 0.0.7 and 0.0.8 used version-root hook commands. A native upgrade can remove the old cache
while a running session still holds its old command. Setup does not repair that active command or
promise that a persistent cache bypasses native trust. Use a normal reload/fresh session; do not
manually delete or replace active cache directories.

Report three short results, with the actual evidence and remaining step:

- **Package:** installed version and enabled state; hook trust is separately observed, not inferred.
- **MCP:** authenticated initialization, or its specific pending state; this does not certify every tool.
- **Hooks:** event and local status actually observed, or “not observed” until a fresh session runs it.

Hook execution does not prove an acknowledged upload. Deferred saves are pending, and partial capture
is not complete history. Test Rooms only if requested with this session's actual identity. Do not
start paid model or cloud work to test installation or manufacture a session proof.

Existing CLI users may separately run `node scripts/launch.mjs <claude|codex|kimi|grok>` from a clone.
That existing launcher reads one private `~/.estelle/auth.json` credential and passes it to the child
without printing it. It is not the installed setup entry and does not certify the child was restarted.
For Cursor, its actual application process must inherit the canonical environment key.
