import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, cp, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { VERSION } from '../runtime/version.mjs';
import { mutatingTool } from '../runtime/write-warning.mjs';

const root = resolve(import.meta.dirname, '..');
const json = async file => JSON.parse(await readFile(join(root, file), 'utf8'));

test('native packages use bundled local runners and respect host teardown contracts', async () => {
  for (const [file, variable, host] of [
    ['plugins/claude/hooks/hooks.json', 'CLAUDE_PLUGIN_ROOT', 'claude-code'],
    ['plugins/codex/hooks/hooks.json', 'PLUGIN_ROOT', 'codex'],
    ['plugins/grok/hooks/hooks.json', 'GROK_PLUGIN_ROOT', 'grok'],
  ]) {
    const config = await json(file);
    assert(Object.keys(config.hooks).length >= 8);
    for (const [event, groups] of Object.entries(config.hooks)) for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        assert.equal(hook.command, `node "\${${variable}}/runtime/cli.mjs" hook ${host}`);
        assert(!/npx|cargo|@fatelabs\/estelle|estelle hook/.test(hook.command));
        if (['SessionEnd', 'Interrupt'].includes(event)) {
          assert.equal(hook.timeout, 3);
          assert.notEqual(hook.async, true);
        }
      }
    }
  }
  const kimi = await json('plugins/kimi/kimi.plugin.json');
  assert.equal(kimi.sessionStart.skill, 'estelle');
  assert.equal(kimi.mcpServers.Estelle.bearerTokenEnvVar, 'ESTELLE_API_KEY');
  for (const hook of kimi.hooks) {
    assert.deepEqual(Object.keys(hook).sort(), ['command', 'event', 'timeout']);
    assert.equal(hook.command, 'node "${KIMI_PLUGIN_ROOT}/runtime/cli.mjs" hook kimi');
  }
});

test('every host keeps its own manifest paths inside the installed package', async () => {
  for (const [packageRoot, manifestFile] of [
    ['plugins/claude', '.claude-plugin/plugin.json'],
    ['plugins/codex', '.codex-plugin/plugin.json'],
    ['plugins/grok', 'plugin.json'],
    ['plugins/cursor', '.cursor-plugin/plugin.json'],
  ]) {
    const base = join(root, packageRoot);
    const manifest = JSON.parse(await readFile(join(base, manifestFile), 'utf8'));
    assert.equal(manifest.version, VERSION);
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
    for (const field of ['hooks', 'mcpServers', 'skills']) {
      if (typeof manifest[field] !== 'string') continue;
      const target = resolve(base, manifest[field]);
      const rel = relative(base, target);
      assert(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
      await access(target);
    }
    await access(join(base, 'runtime', 'cli.mjs'));
    await access(join(base, 'runtime', 'kimi-history.mjs'));
  }
  const codex = await json('plugins/codex/.mcp.json');
  const claude = await json('plugins/claude/.mcp.json');
  const grok = await json('plugins/grok/.mcp.json');
  assert.equal(codex.mcpServers.Estelle.bearer_token_env_var, 'ESTELLE_API_KEY');
  assert.equal(grok.mcpServers.Estelle.bearer_token_env_var, 'ESTELLE_API_KEY');
  assert.deepEqual(claude.mcpServers.Estelle, { type: 'http', url: 'https://api.fatelabs.ca/mcp',
    headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs" mcp-headers' });
});

test('every host folder has separate native discovery and exclude development notes or cross-host manifests', async () => {
  const hosts = ['claude', 'codex', 'cursor', 'dsh', 'grok', 'kimi'];
  assert.deepEqual((await readdir(join(root, 'plugins'))).sort(), hosts);
  for (const [file, host] of [['.claude-plugin/marketplace.json', 'claude'],
    ['.agents/plugins/marketplace.json', 'codex'], ['.cursor-plugin/marketplace.json', 'cursor']]) {
    assert.equal((await json(file)).plugins[0].source, `./plugins/${host}`);
  }
  const manifestPaths = { claude: '.claude-plugin', codex: '.codex-plugin', cursor: '.cursor-plugin',
    dsh: 'cordis.patch.yml', grok: 'plugin.json', kimi: 'kimi.plugin.json' };
  for (const host of hosts) {
    const files = await readdir(join(root, 'plugins', host));
    for (const forbidden of ['docs', 'test', 'CONTEXT.md', 'DECISIONS.md', ...Object.entries(manifestPaths)
      .filter(([other]) => other !== host).map(([, path]) => path)]) assert(!files.includes(forbidden), `${host}: ${forbidden}`);
    await access(join(root, 'docs', 'install', `${host}.md`));
  }
  for (const forbidden of ['CONTEXT.md', 'DECISIONS.md', 'docs/VERIFICATION.md', 'docs/research']) {
    await assert.rejects(access(join(root, forbidden)), { code: 'ENOENT' });
  }
});

test('Cursor manifests use its strict native fields, flat hooks and per-user environment reference', async () => {
  const manifest = await json('plugins/cursor/.cursor-plugin/plugin.json');
  assert.deepEqual(Object.keys(manifest).sort(), ['author', 'commands', 'description', 'hooks', 'license',
    'mcpServers', 'name', 'rules', 'skills', 'version']);
  const hooks = await json('plugins/cursor/hooks/hooks.json');
  assert.equal(hooks.version, 1);
  assert(!Object.hasOwn(hooks.hooks, 'afterAgentThought'));
  assert(!Object.hasOwn(hooks.hooks, 'PreToolUse'));
  for (const [event, rows] of Object.entries(hooks.hooks)) for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['command', 'timeout']);
    assert.equal(row.command, 'node "${CURSOR_PLUGIN_ROOT}/runtime/cli.mjs" hook cursor');
    assert.equal(row.timeout, event === 'sessionEnd' ? 3 : 20);
  }
  assert.equal((await json('plugins/cursor/mcp.json')).mcpServers.Estelle.headers.Authorization,
    'Bearer ${env:ESTELLE_API_KEY}');
});

test('generated artifact check detects a changed runner rather than trusting a source-only pass', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'estelle-package-check-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(root, temporary, { recursive: true, filter: source => !relative(root, source).split('/').includes('.git') });
  const run = () => spawnSync(process.execPath, ['scripts/build.mjs', '--check'], {
    cwd: temporary, encoding: 'utf8', timeout: 10_000, maxBuffer: 100_000,
  });
  assert.equal(run().status, 0);
  const runner = join(temporary, 'plugins', 'codex', 'runtime', 'cli.mjs');
  await writeFile(runner, '// deliberately broken generated runner\n');
  const broken = run();
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Bundle differs: codex\/runtime/);
});


test('Codex hook commands identify Estelle and the native event with supported statusMessage', async () => {
  const codex = await json('plugins/codex/hooks/hooks.json');
  let count = 0;
  for (const [event, groups] of Object.entries(codex.hooks)) for (const group of groups) {
    for (const hook of group.hooks) {
      assert.equal(hook.statusMessage, `Estelle: ${event}`);
      assert.deepEqual(Object.keys(hook).sort(), ['command', 'statusMessage', 'timeout', 'type']);
      assert.equal(hook.command, 'node "${PLUGIN_ROOT}/runtime/cli.mjs" hook codex');
      assert.equal(hook.timeout, ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 20);
      count++;
    }
  }
  assert.equal(count, 10);
  // Each model request and each tool call adds lines to Codex's history when hooks need re-approval.
  // These two ran a process per model request and recorded a file nothing read.
  assert.equal(Object.hasOwn(codex.hooks, 'PreModelRequest'), false);
  assert.equal(Object.hasOwn(codex.hooks, 'PostModelRequest'), false);
  const matcher = new RegExp(codex.hooks.PreToolUse[0].matcher);
  for (const name of ['apply_patch', 'functions.apply_patch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert(matcher.test(name), name);
  for (const name of ['Bash', 'exec_command', 'Read', 'mcp__Estelle__verify', 'list_files', 'apply_patch_status']) assert(!matcher.test(name), name);
  for (const name of ['apply_patch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'replace']) {
    assert.equal(mutatingTool(name), true, `${name} is a write tool the guard refuses on, so the matcher must reach it`);
    assert(matcher.test(name), name);
  }
  assert.equal(codex.hooks.PostToolUse[0].matcher, undefined, 'capture still needs every tool result');
  for (const host of ['claude', 'grok']) {
    const other = await json(`plugins/${host}/hooks/hooks.json`);
    for (const groups of Object.values(other.hooks)) for (const group of groups) {
      for (const hook of group.hooks) assert.equal(Object.hasOwn(hook, 'statusMessage'), false);
    }
  }
});
