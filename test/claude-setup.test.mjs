import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSetup } from '../runtime/setup.mjs';
import { duplicateKeyExports, NEW_PLUGIN, OLD_PLUGIN, runClaudeSetup } from '../runtime/claude-setup.mjs';

const root = resolve(import.meta.dirname, '..');
const row = (id, scope = 'user') => ({ id, version: '1', scope, enabled: true });
const legacy = (mode, event) => ({ type: 'command', command: `estelle hook ${mode} --event ${event}` });
const foreign = { type: 'command', command: '/usr/local/bin/my-security-check' };
const settings = () => ({ permissions: { allow: ['Bash(ls)'] }, env: { MY_VAR: 'kept' }, statusLine: { type: 'command', command: 'x' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [legacy('ground', 'PreToolUse'), foreign] }], Stop: [{ hooks: [foreign] }] } });

function nativeFor(initial) {
  let items = initial;
  const calls = [];
  const native = async op => {
    calls.push(op);
    if (op === 'list') return { ok: true, text: JSON.stringify(items) };
    items = items.filter(item => !(item.id === OLD_PLUGIN && item.scope === 'user'));
    return { ok: true, text: JSON.stringify({ outcome: 'ok' }) };
  };
  return { native, calls };
}

async function home(t, value = settings()) {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-claude-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.claude', 'projects', 'p'), { recursive: true });
  await writeFile(join(dir, '.claude', 'projects', 'p', 's.jsonl'), '{"a real session":true}\n');
  if (value) await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(value));
  return dir;
}

const noKey = dir => ({ env: {}, home: dir });

const windows = process.platform === 'win32';

/** Apply refuses on Windows by design: the commit needs POSIX no-follow opens and a directory fsync. So on Windows a test
 * that reaches apply proves that refusal against the real process.platform, and its name says so. Pinning a `linux` port
 * here would turn the job green by certifying a path no Windows customer can reach. */
async function refusedApply(t) {
  const dir = await home(t);
  const file = join(dir, '.claude', 'settings.json');
  const before = await readFile(file);
  let effects = 0;
  const env = new Proxy({}, { get() { effects++; throw new Error('Windows apply must not read the environment'); } });
  const native = async () => { effects++; throw new Error('Windows apply must not invoke native commands'); };
  const result = await runClaudeSetup({ apply: true, env, home: dir }, { native });
  assert.equal(result.status, 'pending_unsupported_platform');
  assert.equal(effects, 0);
  assert.deepEqual(await readFile(file), before);
}

const applyTest = (name, body) => (windows ? test(`${name} [Windows: apply refuses]`, refusedApply) : test(name, body));

test('no old install is the fresh path and changes nothing, with or without --apply', async t => {
  const dir = await home(t, { permissions: { allow: [] } });
  const before = await readFile(join(dir, '.claude', 'settings.json'));
  for (const apply of windows ? [false] : [false, true]) {
    const { native, calls } = nativeFor([row(NEW_PLUGIN)]);
    const result = await runClaudeSetup({ ...noKey(dir), apply }, { native });
    assert.equal(result.path, 'fresh');
    assert.equal(result.status, apply ? 'unchanged' : 'planned');
    assert(!calls.includes('uninstall'));
    assert.match(result.message, /nothing to migrate/);
  }
  assert.deepEqual(await readFile(join(dir, '.claude', 'settings.json')), before);
});

test('a plan names an old plugin and legacy hooks and changes nothing', async t => {
  const dir = await home(t);
  const before = await readFile(join(dir, '.claude', 'settings.json'));
  const { native, calls } = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN)]);
  const result = await runClaudeSetup(noKey(dir), { native });
  assert.equal(result.status, 'planned');
  assert.equal(result.path, 'migrate');
  assert.deepEqual(result.old_plugin_scopes, ['user']);
  assert.equal(result.hook_removals, 1);
  assert.match(result.plan_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls, ['list']);
  assert.deepEqual(await readFile(join(dir, '.claude', 'settings.json')), before);
});

applyTest('a migration removes the old install and keeps sessions and every unrelated setting', async t => {
  const dir = await home(t);
  const { native, calls } = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN), row('other@market')]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'applied');
  assert.equal(result.old_plugin, 'removed');
  assert.equal(result.hook_removals, 1);
  assert.equal(calls.filter(op => op === 'uninstall').length, 1);
  const after = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
  const expected = settings();
  assert.deepEqual(after.permissions, expected.permissions);
  assert.deepEqual(after.env, expected.env);
  assert.deepEqual(after.statusLine, expected.statusLine);
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [foreign] }]);
  assert.deepEqual(after.hooks.Stop, expected.hooks.Stop);
  assert.equal(await readFile(join(dir, '.claude', 'projects', 'p', 's.jsonl'), 'utf8'), '{"a real session":true}\n');
  const again = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(again.path, 'fresh', 'a second run finds nothing left to migrate');
});

applyTest('legacy hooks alone are enough to migrate, with no plugin to remove', async t => {
  const dir = await home(t);
  const { native, calls } = nativeFor([row(NEW_PLUGIN)]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'applied');
  assert.equal(result.old_plugin, 'absent');
  assert(!calls.includes('uninstall'));
});

applyTest('nothing is removed until the replacement is installed, so a customer is never left with neither', async t => {
  const dir = await home(t);
  const before = await readFile(join(dir, '.claude', 'settings.json'));
  const { native, calls } = nativeFor([row(OLD_PLUGIN)]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'pending_package');
  assert(!calls.includes('uninstall'));
  assert.deepEqual(await readFile(join(dir, '.claude', 'settings.json')), before);
});

applyTest('a project-scoped old install stays and is reported, because that scope belongs to a repository', async t => {
  const dir = await home(t, {});
  const { native, calls } = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN, 'project')]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.old_plugin_left_in_scopes, ['project']);
  assert(!calls.includes('uninstall'));
});

applyTest('an uninstall the read-back contradicts is never reported as applied', async t => {
  const dir = await home(t, {});
  const calls = [];
  const native = async op => {
    calls.push(op);
    if (op === 'uninstall') return { ok: true, text: JSON.stringify({ outcome: 'ok' }) };
    return { ok: true, text: JSON.stringify([row(NEW_PLUGIN), row(OLD_PLUGIN)]) };
  };
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'partial');
  assert.equal(result.old_plugin, 'not_removed');
});

applyTest('a plan that changed between preview and apply refuses', async t => {
  const dir = await home(t);
  const first = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN)]);
  const { plan_sha256: hash } = await runClaudeSetup(noKey(dir), { native: first.native });
  const changed = settings();
  changed.hooks.Stop[0].hooks.push(legacy('checkpoint', 'Stop'));
  await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(changed));
  const second = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN)]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true, expect: hash }, { native: second.native });
  assert.equal(result.status, 'pending_conflict');
  assert(!second.calls.includes('uninstall'));
});

applyTest('a settings file that cannot be read safely refuses without touching the plugin', async t => {
  const dir = await home(t, null);
  await writeFile(join(dir, '.claude', 'settings.json'), '{"a":1,"a":2}');
  const { native, calls } = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN)]);
  const result = await runClaudeSetup({ ...noKey(dir), apply: true }, { native });
  assert.equal(result.status, 'pending_configuration');
  assert(!calls.includes('uninstall'));
});

test('a plugin list of the wrong shape is a pending state, not an empty install', async t => {
  const dir = await home(t);
  for (const text of ['[{"name":"no id"}]', '{"installed":[]}', 'not json']) {
    const result = await runClaudeSetup(noKey(dir), { native: async () => ({ ok: true, text }) });
    assert.equal(result.status, 'pending_host_cli', text);
  }
  assert.equal((await runClaudeSetup(noKey(dir), { native: async () => ({ ok: false, text: '' }) })).status, 'pending_host_cli');
});

test('Windows apply refuses before anything runs', async () => {
  const native = async () => { throw new Error('must not run'); };
  assert.equal((await runClaudeSetup({ apply: true, env: {}, home: '/not-read' }, { native, platform: 'win32' })).status, 'pending_unsupported_platform');
});

test('CLAUDE_CONFIG_DIR is the settings location when it is set', async t => {
  const dir = await home(t, {});
  const custom = join(dir, 'custom');
  await mkdir(custom);
  await writeFile(join(custom, 'settings.json'), JSON.stringify(settings()));
  const { native } = nativeFor([row(NEW_PLUGIN)]);
  const result = await runClaudeSetup({ env: { CLAUDE_CONFIG_DIR: custom }, home: dir }, { native });
  assert.equal(result.hook_removals, 1);
});

test('the setup entry routes claude here and still reports other non-Codex hosts as unsupported', async t => {
  const dir = await home(t, {});
  const { native } = nativeFor([row(NEW_PLUGIN)]);
  assert.equal((await runSetup({ host: 'claude', env: {}, home: dir }, { native })).path, 'fresh');
  for (const host of ['cursor', 'kimi', 'grok']) {
    assert.equal((await runSetup({ host, env: {}, home: dir })).status, 'pending_unsupported_host');
  }
});

test('no key leaves capture off and says so, and asks the server nothing', async t => {
  const dir = await home(t, {});
  const { native } = nativeFor([row(NEW_PLUGIN)]);
  let asked = 0;
  const result = await runClaudeSetup(noKey(dir), { native, checkKey: async () => { asked++; return 'accepted'; } });
  assert.equal(asked, 0);
  assert.equal(result.capture_auth, 'off_no_key');
  assert.equal(result.mcp_auth, 'oauth_in_claude_not_probed');
  assert.equal(result.accounts_match, 'not_proved');
  assert(result.next.some(step => /same Estelle account/.test(step)));
});

applyTest('a rejected key is named in setup output and does not block the migration', async t => {
  const dir = await home(t);
  const { native } = nativeFor([row(NEW_PLUGIN), row(OLD_PLUGIN)]);
  const result = await runClaudeSetup({ env: { ESTELLE_API_KEY: 'fixture-key' }, home: dir, apply: true },
    { native, checkKey: async () => 'rejected' });
  assert.equal(result.status, 'applied');
  assert.equal(result.key_check, 'rejected');
  assert.match(result.key_message, /401/);
  assert(!JSON.stringify(result).includes('fixture-key'));
});

const SENTINEL = 'SENTINEL-VALUE-NOT-A-KEY';

test('duplicate exports are counted across files with no value and no file contents in the output', async t => {
  const dir = await home(t, {});
  await writeFile(join(dir, '.zshrc'), `# my private note ${SENTINEL}\nexport ESTELLE_API_KEY=${SENTINEL}\nexport OTHER_SECRET=${SENTINEL}\n`);
  await writeFile(join(dir, '.zprofile'), `  export ESTELLE_API_KEY="${SENTINEL}"\n`);
  const { native } = nativeFor([row(NEW_PLUGIN)]);
  const result = await runClaudeSetup({ env: { ESTELLE_API_KEY: SENTINEL }, home: dir }, { native, checkKey: async () => 'accepted' });
  assert.equal(result.duplicate_key.exports, 2);
  assert.deepEqual(result.duplicate_key.files.sort(), ['.zprofile', '.zshrc']);
  const output = JSON.stringify(result);
  assert(!output.includes(SENTINEL) && !output.includes('private note') && !output.includes('OTHER_SECRET'));
});

test('one export, a commented one, or a different variable is not a duplicate', async t => {
  const dir = await home(t, {});
  await writeFile(join(dir, '.zshrc'), `export ESTELLE_API_KEY=x\n# export ESTELLE_API_KEY=y\nexport MY_ESTELLE_API_KEY=z\nESTELLE_API_KEY_OLD=w\n`);
  assert.equal(await duplicateKeyExports(dir), null);
});

test('non-Codex prompts no longer send an agent to a setup step that only reports pending', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  for (const host of ['cursor', 'grok', 'kimi']) {
    const guide = await readFile(join(root, 'docs/install', `${host}.md`), 'utf8');
    for (const text of [guide, readme]) assert(!text.includes(`setup ${host} --apply`), host);
  }
  for (const text of [readme, await readFile(join(root, 'docs/install/codex.md'), 'utf8')]) assert(text.includes('setup codex --apply'));
  const claude = await readFile(join(root, 'docs/install/claude.md'), 'utf8');
  assert(claude.includes('setup claude'));
  assert(!/Keep hooks and MCP on the same environment key/.test(claude));
  assert.match(claude, /Quit and reopen/);
  assert(!/fresh session/i.test(claude));
});

test('the plugin names each product beside its tool and points at the docs tool', async () => {
  for (const file of ['skills/estelle/SKILL.md', 'plugins/claude/skills/estelle/SKILL.md']) {
    const skill = await readFile(join(root, file), 'utf8');
    for (const [product, tool] of [['Twice', 'estelle_qa'], ['Silos', 'estelle_silo'], ['Security', 'scan'], ['CI', 'estelle_ci'],
      ['Orchestra', 'orchestra'], ['Atlas', 'kb_ask']]) {
      assert(skill.split('\n').some(line => line.startsWith(`| ${product} |`) && line.includes('`' + tool + '`')), `${file}: ${product}`);
    }
    assert(skill.includes('`estelle_docs`'));
  }
  assert((await readFile(join(root, 'plugins/claude/instructions.md'), 'utf8')).includes('`estelle_docs`'));
});
