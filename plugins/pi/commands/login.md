---
description: Sign in to Estelle once, for its tools and for recording your sessions.
---
Only act on this when the person typed the command themselves.

Run this once with your shell tool. In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`. Elsewhere it is
`runtime/cli.mjs` at the root of the installed Estelle plugin: on Codex and Antigravity, `../../runtime/cli.mjs` from this skill's own folder.
It waits while the person signs in, up to 10 minutes, so give it that long.

```sh
node "<Estelle cli.mjs>" setup <host> --login
```

Replace <host> with the name of the host you are running in: claude, codex, cursor, grok, kimi, qwen-code, gemini-cli, antigravity, openclaw, opencode, pi, hermes or dsh.

It opens the browser and prints the same address on stderr. Show the person that address in case no browser opened.

Then read the status field it prints and say one line:

- `capture_configured`: signed in, and session recording works from the next session. On Claude Code the tools use this sign-in too: if they are not connected yet, tell them to run `/mcp` and reconnect Estelle, or restart. On every other host the tools sign in through the host's own browser sign-in for MCP (Codex: codex mcp login, with the Estelle server name; Grok: the /mcps screen; Cursor: Connect on the Estelle server in Customize; OpenCode: opencode mcp auth Estelle; Pi: /mcp login Estelle; Qwen Code: /mcp; Antigravity: type /mcp, select the Estelle server (shown as estelle_tools), choose Authenticate, approve in the browser, then paste the code back; Kimi: keep using ESTELLE_API_KEY for tools). Tell them which one applies to this host.
- `capture_already_configured`: already signed in, nothing changed.
- `pending_unsupported_platform`: this sign-in is not available on Windows yet. Sign in to the tools through the host, and set `ESTELLE_API_KEY` to record sessions.
- `pending_capture_auth`: not signed in. Say the reason field it printed, and that they can run this command again.

Do not read, print or copy anything from `~/.estelle-plugins`.
