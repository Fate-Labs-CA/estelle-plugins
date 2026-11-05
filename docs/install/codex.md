# Codex

Package: `plugins/codex`. Requires Node.js 22 and `ESTELLE_API_KEY` in the host environment.

```sh
codex plugin marketplace add uqeu/estelle-plugins --ref main
codex plugin add estelle@estelle-plugins
codex plugin list
```

For an existing marketplace, run `codex plugin marketplace upgrade estelle-plugins` before reinstalling.

## Approve the hooks, after installing and after every update

Codex runs a plugin's hooks only after you approve them, and it asks again whenever any file in the plugin
changes. So every Estelle update needs one approval:

- **When Codex starts:** choose **Trust all and continue**.
- **In a running session:** run `/hooks` and press `t`. Space only turns a hook on or off.
- **In the desktop app:** select **Review hooks** in the composer, or open **Settings > Hooks**.

Until you do, Codex shows `Hook failed: plugin contents changed; hook approval required` for each hook it
skips. Those hooks do not run at all, so Estelle captures nothing and does not check file writes for
credentials. The write itself still goes through. Approving in a running session restores both straight away,
and capture picks up that session from its start. A session that ended before you approved is not captured.

To check, run `node "<installed Estelle package>/runtime/cli.mjs" doctor` and read `codex_hooks`. Estelle never
approves its own hooks: that decision is yours, and Codex's review is what lets you make it.

Run the [shipped setup command](../migration/from-cli.md#deterministic-setup) after native installation. Codex POSIX cleanup is supported; Windows apply remains pending. The hosted backend controls permissions and tools.

## Commands

Codex has no plugin commands, so there is no `/estelle:handoff` here. Estelle's commands come as skills: `estelle:handoff`,
`estelle:cloud`, `estelle:code`, `estelle:monitor`, `estelle:resume`, `estelle:review` and `estelle:rooms`. Type `$` in Codex and pick one.

## Copy/paste setup prompt

```text
Install or update Estelle for Codex from https://github.com/uqeu/estelle-plugins using plugins/codex. Follow docs/install/codex.md and docs/migration/from-cli.md. Use native approval and a fresh session; preserve unrelated settings and active sessions. After native installation, invoke the installed package runtime/cli.mjs setup codex --apply once as documented; do not manually edit configuration. Report unsupported or unavailable migration as pending. Keep hooks and MCP on the same environment key; never request or display credentials. If setup reports hook_review as review_required, tell me its next_step word for word and do not approve hooks for me. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. No paid installation tests.
```
