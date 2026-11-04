---
description: Start a new Estelle cloud session from a prompt and get a link to watch it.
argument-hint: "[harness] <prompt>"
disable-model-invocation: true
---
The person asked to start a new cloud session. Their words: $ARGUMENTS

Run this once with your shell tool and pass their words on stdin exactly as written. Do not commit, stash or clean
anything first. In Claude Code the file is `${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs`; elsewhere it is `runtime/cli.mjs` in
the installed Estelle package, named at session start.

```sh
node "<Estelle cli.mjs>" move cloud <<'ESTELLE_MOVE'
$ARGUMENTS
ESTELLE_MOVE
```

Show every line it prints, exactly and in order, and add nothing after the last one. If it says the session could not
start, that is the answer: do not retry and do not start a machine another way. If it says this command needs
ESTELLE_API_KEY, and the Estelle MCP tools are connected, call `estelle_move` once with `mode: "cloud"`, `confirm: true`,
their prompt, the repo as owner/name, a new `move_key`, and the commit and branch `git` reports. Show its `last_message`
as it is.

After it starts, this session is a remote control: if the person keeps typing instructions for that work, send them with
`estelle_move` and `action: "steer"`, naming the session id it printed in the link.
