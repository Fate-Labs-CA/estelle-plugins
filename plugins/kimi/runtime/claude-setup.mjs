/** Claude Code setup has one path: an old install migrates, and no old install is a fresh one. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkKey, KEY_MESSAGES } from './key-check.mjs';
import { commitHooks, inspectHooks, planHooks } from './migration.mjs';
import { VERSION } from './version.mjs';

export const OLD_PLUGIN = 'estelle@fatelabs', NEW_PLUGIN = 'estelle@estelle-plugins';
const LIST_BYTES = 262144, CALL_MS = 15000, RC_BYTES = 262144, MAX_LISTED_PLUGINS = 1024;
const COMMANDS = Object.freeze({ list: ['plugin', 'list', '--json'],
  // --keep-data: the old plugin's saved data stays on disk, and `user` is the only scope setup may change.
  uninstall: ['plugin', 'uninstall', OLD_PLUGIN, '--keep-data', '--json', '--scope', 'user'] });
const RC_FILES = Object.freeze(['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.bashrc', '.profile']);
const EXPORT_LINE = /^[ \t]*(?:export[ \t]+)?ESTELLE_API_KEY=/gm;

function nativeClaude(operation) {
  return new Promise(done => {
    execFile('claude', COMMANDS[operation], { timeout: CALL_MS, maxBuffer: LIST_BYTES, windowsHide: true },
      (error, stdout) => done(error ? { ok: false, text: stdout || '' } : { ok: true, text: stdout }));
  });
}

/** The plugins Claude Code reports. Throws on any row without an id: non-empty is not correctly parsed. */
function parseList(text) {
  const items = JSON.parse(text);
  if (!Array.isArray(items) || items.length > MAX_LISTED_PLUGINS) throw new Error('plugin_list_shape');
  if (!items.every(item => typeof item?.id === 'string' && typeof item?.scope === 'string')) throw new Error('plugin_list_shape');
  return items;
}

const scopesOf = (items, id) => items.filter(item => item.id === id).map(item => item.scope);

/** How many times shell startup files set the key. A count and file names only; the contents never leave this function.
 * A warning, not a proof: a file past RC_BYTES is read in part, so null means none were found, not that none exist. */
export async function duplicateKeyExports(home) {
  const found = [];
  let count = 0;
  for (const name of RC_FILES) {
    const file = await open(join(home, name), 'r').catch(() => null);
    if (!file) continue;
    try {
      const bytes = Buffer.alloc(RC_BYTES), { bytesRead } = await file.read(bytes, 0, RC_BYTES, 0);
      const hits = (bytes.subarray(0, bytesRead).toString('utf8').match(EXPORT_LINE) || []).length;
      if (hits) { count += hits; found.push(name); }
    } catch { /* an unreadable file is not a duplicate */ } finally { await file.close(); }
  }
  if (count < 2) return null;
  return { exports: count, files: found,
    message: `ESTELLE_API_KEY is set ${count} times in ${found.join(', ')}. Your shell keeps the last one it reads, so hooks may use a different key or account than you expect. Keep one.` };
}

async function accountFields(env, home, check) {
  const duplicate = await duplicateKeyExports(home);
  const key = env.ESTELLE_API_KEY;
  const keyCheck = key ? await check(key) : null;
  return { capture_auth: key ? 'environment_key' : 'off_no_key',
    ...(keyCheck ? { key_check: keyCheck, key_message: KEY_MESSAGES[keyCheck] } : {}),
    ...(duplicate ? { duplicate_key: duplicate } : {}) };
}

const report = (status, fields = {}) => ({ status, host: 'claude', version: VERSION, ...fields,
  mcp_auth: 'oauth_in_claude_not_probed', accounts_match: 'not_proved', hook_execution: 'not_observed',
  trust: 'not_changed_not_measured', reload: 'fresh_session_required' });

const next = capture => ['Restart Claude Code. In a session, run /mcp, choose Estelle, and sign in with your browser.',
  ...(capture === 'off_no_key' ? ['MCP works without a key. Session capture stays off until ESTELLE_API_KEY is set to a key from the same Estelle account.'] : [])];

async function uninstallOld(native) {
  const removed = await native('uninstall');
  let outcome = null;
  try { outcome = JSON.parse(removed.text).outcome; } catch { /* unparsed is not removed; the read-back decides */ }
  const after = await native('list');
  if (after.ok !== true) return 'unknown';
  const gone = !scopesOf(parseList(after.text), OLD_PLUGIN).includes('user');
  return gone && outcome === 'ok' ? 'removed' : gone ? 'unknown' : 'not_removed';
}

async function applyMigration(file, snapshot, oldScopes, native, fields) {
  let hooks = { status: 'unchanged', removed: 0 };
  try {
    if (snapshot) hooks = await commitHooks(file, snapshot);
  } catch {
    return report('pending_conflict', { ...fields, path: 'migrate', hooks: 'not_applied', old_plugin: 'not_removed' });
  }
  if (hooks.status === 'unknown') return report('unknown', { ...fields, path: 'migrate', hooks: 'unknown', old_plugin: 'not_removed' });
  const plugin = oldScopes.includes('user') ? await uninstallOld(native) : 'absent';
  const left = oldScopes.filter(scope => scope !== 'user');
  const complete = plugin !== 'not_removed' && plugin !== 'unknown' && left.length === 0;
  return report(complete ? 'applied' : plugin === 'unknown' ? 'unknown' : 'partial', { ...fields, path: 'migrate', hooks: hooks.status,
    hook_removals: hooks.removed, old_plugin: plugin, old_plugin_left_in_scopes: left,
    next: complete ? next(fields.capture_auth) : [`Run /plugin in Claude Code and remove ${OLD_PLUGIN} from the listed scope. Nothing else was changed.`] });
}

export async function runClaudeSetup({ apply = false, expect, env = process.env, home = homedir(), base } = {}, ports = {}) {
  if (apply && (ports.platform || process.platform) === 'win32') return report('pending_unsupported_platform');
  const native = ports.native || nativeClaude;
  const check = ports.checkKey || (key => checkKey(key, { base, version: VERSION }));
  const listing = await native('list');
  let items;
  try {
    if (listing.ok !== true) throw new Error('plugin_list');
    items = parseList(listing.text);
  } catch { return report('pending_host_cli', { message: 'The claude command could not list plugins, so nothing was changed.' }); }
  if (!scopesOf(items, NEW_PLUGIN).length) {
    return report('pending_package', { message: `Install ${NEW_PLUGIN} first. Nothing was changed, so any old install keeps working.` });
  }
  const file = join(env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude'), 'settings.json');
  let snapshot, removals;
  try {
    snapshot = await inspectHooks(file);
    removals = snapshot ? planHooks(snapshot.bytes).removed : 0;
  } catch { return report('pending_configuration', { message: 'settings.json could not be read safely, so nothing was changed.' }); }
  const oldScopes = scopesOf(items, OLD_PLUGIN);
  const path = oldScopes.length || removals ? 'migrate' : 'fresh';
  const fields = await accountFields(env, home, check);
  const planHash = createHash('sha256').update(JSON.stringify({ before: snapshot?.hash || null, removals, oldScopes, version: VERSION })).digest('hex');
  if (expect !== undefined && expect !== planHash) return report('pending_conflict', { ...fields, path });
  if (path === 'fresh') {
    return report(apply ? 'unchanged' : 'planned', { ...fields, path, next: next(fields.capture_auth),
      message: 'No old Estelle install was found, so there is nothing to migrate.' });
  }
  if (!apply) {
    return report('planned', { ...fields, path, old_plugin_scopes: oldScopes, hook_removals: removals, plan_sha256: planHash,
      message: `Found an old Estelle install: ${[oldScopes.length ? OLD_PLUGIN : '', removals ? `${removals} old hook command(s)` : ''].filter(Boolean).join(' and ')}. Run setup claude --apply to remove it. Sessions, saved memory and every other setting stay.` });
  }
  return applyMigration(file, snapshot, oldScopes, native, fields);
}
