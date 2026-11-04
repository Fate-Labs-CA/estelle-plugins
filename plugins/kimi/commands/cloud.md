---
description: Start a new cloud session from a prompt and get a link to watch it.
---
Only act on this when the person typed the command themselves: it starts a billed machine.
The person asked to start a new cloud session. Their words: $ARGUMENTS

Run this once with your shell tool and pass their words on stdin exactly as written. Do not commit, stash or clean
anything first. In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is `runtime/cli.mjs` in
the installed Estelle package, named at session start.

```sh
node "<Estelle cli.mjs>" move cloud <<'ESTELLE_MOVE'
$ARGUMENTS
ESTELLE_MOVE
```

Show every line it prints, exactly and in order, and add nothing after the last one. If it prints `ESTELLE_MCP_CALL` and a
JSON line, this host signed in to Estelle with OAuth, so the command cannot reach the server itself: call the MCP tool
`estelle_move` once with exactly that JSON as its arguments, then show the tool's `last_message` as it is. If it says the
move could not run, that is the answer: do not retry and do not start a machine another way. Never say a session resumed
unless those lines say so.

After it starts, this session is a remote control: if the person keeps typing instructions for that work, send them with
`estelle_move` and `action: "steer"`, naming the session id it printed in the link.
