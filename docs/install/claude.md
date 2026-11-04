# Claude Code

Package: `plugins/claude`. Requires Node.js 22.

## Install

```text
/plugin marketplace add uqeu/estelle-plugins
/plugin install estelle@estelle-plugins
```

Review the normal installation and hook trust prompts, then restart Claude Code. In a session, run `/mcp`, choose **Estelle**, and sign in with your browser. No key is needed for this.

Only Claude Code has been exercised with OAuth. Codex, Kimi Code, Grok Build and Cursor still use `ESTELLE_API_KEY`.

## Replace an old install

If you installed `estelle@fatelabs` or the older `estelle` CLI hooks, run this once after installing:

```sh
node "<installed Estelle package>/runtime/cli.mjs" setup claude
```

It changes nothing and reports one of two paths. `fresh` means there is nothing to migrate. `migrate` lists what it found. To migrate, run the same command with `--apply`. On Windows, `--apply` reports `pending_unsupported_platform` and changes nothing, so the old install stays. [What it changes and what it keeps](../migration/from-cli.md#claude-code).

## Session capture needs a key for now

Hooks cannot use the sign-in from `/mcp`, because Claude Code does not expose that token to them. Without `ESTELLE_API_KEY`, MCP works and hooks capture nothing. To turn capture on:

1. Create a key in the same Estelle account you signed in to. Setup cannot check that the two match.
2. Set `ESTELLE_API_KEY` once in your shell startup file. Setup warns if it finds the key set more than once.
3. Quit and reopen the app. **Claude Desktop reads your login shell's exports only when it starts**, so a new session in the running app does not see a new key. In a terminal, open a new shell before starting `claude`.
4. Run `node "<installed Estelle package>/runtime/cli.mjs" doctor`. It sends the key to the server and tells you if it is accepted. `key_check: rejected` means the server answered 401: replace the key.

If you use a machine with no browser, add your own MCP entry with an `Authorization` header instead of `/mcp` sign-in.

## Copy/paste setup prompt

```text
Install or update Estelle for Claude Code from https://github.com/uqeu/estelle-plugins using plugins/claude. Follow docs/install/claude.md. Use native approval; preserve sessions and unrelated settings. After native installation, run the installed package runtime/cli.mjs setup claude once. If it reports path fresh, there is nothing to migrate. If it reports path migrate, show me what it found and, once I agree, run setup claude --apply once. Do not manually edit configuration. Then tell me to restart Claude Code and sign in with /mcp. Never request or display credentials. Report package, MCP sign-in and observed hooks separately, and report any pending step. The setup check does not prove hook execution. No paid installation tests.
```
