---
description: Continue this session in a cloud Silo and get a link to watch it.
---
Only act on this when the person typed the command themselves: it starts a billed machine.
The person asked to move this session to the cloud. Their words, which may be empty: $ARGUMENTS

Do it now. Say nothing first, check nothing first, and ask nothing: this folder names the repository. Do not call `estelle_resume`, `estelle_silo`, `session_message` or any other tool, and do not run git.

Empty words mean finish what this session is coding. Run this once with your shell tool and pass their words on stdin
exactly as written. In Claude Code the file is
`${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is `runtime/cli.mjs` in the installed Estelle package, named at
session start.

```sh
node "<Estelle cli.mjs>" move handoff <<'ESTELLE_MOVE'
$ARGUMENTS
ESTELLE_MOVE
```

If it prints `ESTELLE_MCP_CALL` and a JSON line, this host signed in to Estelle with OAuth: call the MCP tool `estelle_move` once
with exactly that JSON as its arguments. Your whole reply is then any line starting `Starts from`, and one line more: the tool's
`last_message`, or otherwise the last line the command printed, as it is. It holds the link. If it says the move could not run, that is the answer: do not retry
and do not start a machine another way. Never say a session resumed unless that line says so.
