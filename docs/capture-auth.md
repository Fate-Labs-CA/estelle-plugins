# Sign in for local session capture

Connecting native MCP and authorizing local session capture are separate steps. MCP login does not
expose its token to the hook process, and Estelle does not read the host's OAuth store to obtain it.
This source adds an explicit browser-consent setup command; publication and a real host sign-in
must be verified separately before reporting an installed workflow working.

An installer agent can invoke the shipped entry from the actual installed package:

```sh
node "<installed Estelle package>/runtime/cli.mjs" setup codex --capture-login
```

Use `claude`, `cursor`, `kimi`, `grok` or `dsh` for the other POSIX hosts. The shared credential/capture
adapter is implemented for these hosts; that is not a claim that five native installations have
been exercised. Windows reports `pending_unsupported_platform`, changes nothing and requires a
separate safe ACL/native implementation. No command grants hook trust or restarts an active session.

The command opens Estelle's existing sign-in and consent page. Approving it authorizes uploading
recorded session events, including conversation text, tool results and captured file changes.
It does not authorize reading account history, recall, checkpoints, indexing, settings, models,
repairs or financial work. The grant is bound to the first-party capture client and exactly
`https://api.fatelabs.ca/session/events`. No native MCP token is exported and no API key needs to
be printed, copied or placed in an environment file.

The hook stores one capture credential privately under `~/.estelle-plugins/capture-auth`, with
owner-only POSIX permissions. Its transcript upload state uses a separate random local partition;
a later sign-in cannot replay a previous account's queued batches. This partition is not a native
session or Rooms identity. A canonical inherited API key continues to use its original behavior
and bypasses this store entirely.

`capture_configured` proves that this command received and privately saved a capture grant.
It does not prove a hook ran or a transcript upload was acknowledged. Use a normal fresh host
session and inspect the plugin's content-free local status. `doctor` distinguishes a configured
capture grant from full-key authentication and does not probe MCP or silently refresh credentials.
Capture-only ingestion does not run automatic PR verification, model retitling or work metrics;
those panels are not repaired by this sign-in flow.

Refresh records a pending state before one request. If the connection never finished its TLS
handshake, nothing reached the server, so the sign-in stays good and the next hook tries again. A
lost or malformed acknowledgement stops capture instead of resending a refresh token the server may
have consumed, which would revoke the sign-in. A hook killed mid-refresh stops capture the same way.

Stopped capture says so: the next session start prints the reason and the command to run. Running
`--capture-login` again replaces a stopped sign-in after new consent, on a new partition. It does not
revoke the old grant, which expires on its own, because the server's revoke is per account and would
also revoke the new one. A lock older than the longest login (11 minutes) belongs to a dead process
and is cleared by whichever caller finds it; a live lock is never taken. Two callers clearing the
same dead lock at once are caught when they save, not prevented. Atomic file replacement and
directory flushes are tested locally; power-loss and every POSIX filesystem are not thereby certified.

To stop this grant explicitly:

```sh
node "<installed Estelle package>/runtime/cli.mjs" setup codex --capture-logout
```

Logout blocks local capture before the remote revoke request. Only a definite answer from the server
produces `capture_signed_out`, including "this token is no longer valid"; an uncertain response
remains `pending_capture_auth`, and running logout again is the retry. It neither deletes previously
captured history nor signs out unrelated MCP clients. An explicit new consent can issue a new grant
later. No automatic retry or native OAuth-store cleanup occurs.

The existing server tables have no per-device family identifier. Scoped logout and refresh-replay
revocation cover this account's fixed capture client/resource, so another capture installation for
the same account can also need to sign in again. This is not per-device-only logout.

Legacy migration remains a separate command. A capture-only credential cannot prove replacement
MCP authentication, so it cannot authorize removal of a legacy MCP registration. Existing setup
continues to require its independently authenticated MCP initialization before that mutation.
Versions 0.0.7/0.0.8 active cache paths still require the documented normal reload; this command does
not repair an already loaded old command or bypass native trust.
