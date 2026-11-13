---
description: Sign in to Estelle once, for its tools and for recording your sessions.
---
Only act on this when the person typed the command themselves.

Run this once with your shell tool. In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`. Elsewhere it is
`runtime/cli.mjs` at the root of the installed Estelle plugin: on Codex, `../../runtime/cli.mjs` from this skill's own folder.
It waits while the person signs in, up to 10 minutes, so give it that long.

```sh
node "<Estelle cli.mjs>" setup claude --login
```

It opens the browser and prints the same address on stderr. Show the person that address in case no browser opened.

Then read the status field it prints and say one line:

- `capture_configured`: signed in. If Estelle's tools are not connected yet, tell them to run `/mcp` and reconnect Estelle, or restart.
- `capture_already_configured`: already signed in, nothing changed.
- `pending_unsupported_platform`: this sign-in is not available on Windows yet. Run `/mcp` to sign in to the tools, and set `ESTELLE_API_KEY` to record sessions.
- `pending_capture_auth`: not signed in. Say the reason field it printed, and that they can run `/estelle:login` again.

Do not read, print or copy anything from `~/.estelle-plugins`.
