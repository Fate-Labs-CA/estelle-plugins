# Kimi Code

Install directly from GitHub after these three prerequisites:

1. Kimi Code is installed and supports native plugins.
2. External Node.js 22 or later is available as `node` to the actual Kimi process. A bundled host
   runtime does not establish that external hook commands can find Node.
3. You have a valid `ESTELLE_API_KEY` from your Estelle account, with access to the hosted service,
   and the key is available in Kimi's environment.

The plugin does not install Kimi or Node, or create an account. No backend clone or Estelle CLI is needed.
From the environment that launches Kimi, check Node and key presence without printing the key:

```sh
node --version
node -e "console.log(process.env.ESTELLE_API_KEY ? 'ESTELLE_API_KEY present' : 'ESTELLE_API_KEY missing')"
```

Presence is not authentication. On macOS and Windows, a GUI app launched from the Dock or Start menu
may not inherit your terminal's PATH or environment. These terminal checks cover only that environment;
Kimi's actual process must have the same Node/key access. Validate authentication separately below.

Inside the **interactive Kimi TUI**:

```text
/plugins install https://github.com/uqeu/estelle-plugins
/plugins info estelle
/reload
```

The GitHub URL selects the latest published GitHub release. That release must contain the repository-root
`kimi.plugin.json`; updating `main` alone does not update what this URL installs. Check the installed
version and diagnostics with `/plugins info estelle`. `/reload` or `/new` applies the plugin to a session.
Verify MCP authentication and actual hook execution separately; an installed package proves neither.

## Fresh Estelle registration

If Estelle is already registered and you want to install it again from GitHub, use these native commands:

```text
/plugins remove estelle
/reload
/plugins install https://github.com/uqeu/estelle-plugins
/plugins info estelle
/reload
```

Native removal removes the plugin registration. It leaves the managed plugin copy and original source
files on disk. A successful native reinstall stages the new package, replaces the managed copy and
removes its previous copy; no manual cache deletion is needed. This is a fresh
Estelle registration, not a wipe of your Kimi history or Estelle account. Keep your chats, Kimi home,
other plugin registrations and shared memories. Do not delete global `~/.estelle-plugins` state, which
other coding hosts also use. [Automated legacy cleanup](../migration/from-cli.md) is pending for Kimi; native reinstall does not remove legacy CLI hooks.

**Do not run `kimi -p '/plugins …'`.** `-p` sends a model prompt; it does not operate the interactive
plugin command handler. If an installer agent cannot use the TUI, it should give you the exact GitHub
install command and report native installation pending. Do not start nested model installation tests.

For contributors testing an unpublished checkout only, the native installer also accepts the absolute
path to that checkout's `plugins/kimi` directory. A local development install does not verify the public
GitHub install path.

[Native plugin commands and reload behavior](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
· [`kimi -p` contract](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html).

## Copy/paste setup prompt

```text
Check that Kimi Code is installed and that its actual process can find external Node.js 22+ and ESTELLE_API_KEY from my Estelle account; report any missing prerequisite without printing the key. Install Estelle with the native interactive command /plugins install https://github.com/uqeu/estelle-plugins. Follow docs/install/kimi.md and docs/migration/from-cli.md. For a fresh Estelle registration, use /plugins remove estelle and /reload first; preserve chats, unrelated settings, other hosts and shared memories. After native installation, invoke the installed package runtime/cli.mjs setup kimi --apply once as documented; do not manually edit configuration. Automated Kimi migration is currently pending_unsupported_host. Use native approval and /reload after installation. Keep hooks and MCP on the same environment key; never request or display credentials. Report package, authenticated MCP and observed hooks separately, including trust/reload and any pending step. The setup check does not prove hook execution. Do not run kimi -p '/plugins …' or launch a model turn as an installation test. If you cannot operate the interactive TUI, give me the exact GitHub install command and report installation pending.
```
