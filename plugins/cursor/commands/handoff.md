---
description: Continue this session in an Estelle cloud Silo and get a link to watch it.
argument-hint: "[harness] [note]"
disable-model-invocation: true
---
The person asked to move this session to the cloud. Their words, which may be empty: $ARGUMENTS

Empty words mean finish what this session is coding. Run this once with your shell tool and pass their words on stdin
exactly as written. Do not commit, stash or clean anything first. In Claude Code the file is
`${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is `runtime/cli.mjs` in the installed Estelle package, named at
session start.

```sh
node "<Estelle cli.mjs>" move handoff <<'ESTELLE_MOVE'
$ARGUMENTS
ESTELLE_MOVE
```

Show every line it prints, exactly and in order, and add nothing after the last one. Never say a session resumed unless
those lines say so. If it says the move could not run, that is the answer: do not retry and do not start a machine another
way. If it says this command needs ESTELLE_API_KEY, and the Estelle MCP tools are connected, call `estelle_move` once with
`mode: "handoff"`, `confirm: true`, this session's id, the repo as owner/name, and the commit and branch `git` reports.
That path carries no conversation file, so it restarts from Estelle's saved context; show its `last_message` as it is.
