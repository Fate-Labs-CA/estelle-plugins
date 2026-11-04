---
name: handoff
description: "Continue this session in a cloud Silo and get a link to watch it."
---

Only act on this when the person typed the command themselves: it starts a billed machine.
The person asked to move this session to the cloud. Their words, which may be empty: what the person asked for

Empty words mean finish what this session is coding. Run this once with your shell tool and pass their words on stdin
exactly as written. Do not commit, stash or clean anything first. In Claude Code the file is
`${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is `runtime/cli.mjs` in the installed Estelle package, named at
session start.

```sh
node "<Estelle cli.mjs>" move handoff <<'ESTELLE_MOVE'
what the person asked for
ESTELLE_MOVE
```

Show every line it prints, exactly and in order, and add nothing after the last one. If it prints `ESTELLE_MCP_CALL` and a
JSON line, this host signed in to Estelle with OAuth, so the command cannot reach the server itself: call the MCP tool
`estelle_move` once with exactly that JSON as its arguments, then show the tool's `last_message` as it is. If it says the
move could not run, that is the answer: do not retry and do not start a machine another way. Never say a session resumed
unless those lines say so.
