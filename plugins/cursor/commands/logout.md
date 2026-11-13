---
description: Sign this machine out of Estelle.
---
Only act on this when the person typed the command themselves.

Run this once with your shell tool. In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`. Elsewhere it is
`runtime/cli.mjs` at the root of the installed Estelle plugin: on Codex, `../../runtime/cli.mjs` from this skill's own folder.

```sh
node "<Estelle cli.mjs>" setup claude --logout
```

Then read the status field it prints and say one line:

- `capture_signed_out`: signed out. Sessions already recorded stay in their account.
- `capture_not_configured`: this machine was not signed in.
- `pending_capture_auth`: not confirmed. Say the reason field it printed, and that running `/estelle:logout` again retries it.

Do not read, print or copy anything from `~/.estelle-plugins`.
