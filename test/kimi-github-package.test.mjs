import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const json = async file => JSON.parse(await readFile(join(root, file), 'utf8'));

test('the GitHub archive root exposes the same Kimi package, naming its agents explicitly', async () => {
  const manifest = await json('kimi.plugin.json');
  const nested = await json('plugins/kimi/kimi.plugin.json');
  assert.deepEqual(manifest.agents, ['./agents']);
  assert.deepEqual(manifest, nested);
  await access(join(root, 'agents'));
  assert.equal(manifest.version, (await json('package.json')).version);
  assert.deepEqual(manifest.skills, ['./skills']);
  assert.deepEqual(manifest.commands, ['./commands']);
  for (const path of ['runtime/cli.mjs', 'adapters/kimi.mjs', 'skills/estelle/SKILL.md', 'commands']) {
    await access(join(root, path));
  }
  for (const hook of manifest.hooks) {
    assert.equal(hook.command, 'node "${KIMI_PLUGIN_ROOT}/runtime/cli.mjs" hook kimi');
  }
});

test('release metadata in README and Grok instructions follows package.json and detects drift', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'estelle-release-docs-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(root, temporary, { recursive: true, filter: path => !relative(root, path).split('/').includes('.git') });
  const run = (...args) => spawnSync(process.execPath, ['scripts/build.mjs', ...args], {
    cwd: temporary, encoding: 'utf8', timeout: 10_000, maxBuffer: 100_000,
  });
  const pkg = await json('package.json');
  pkg.version = '9.8.7';
  await writeFile(join(temporary, 'package.json'), JSON.stringify(pkg));
  assert.equal(run().status, 0);
  const readme = await readFile(join(temporary, 'README.md'), 'utf8');
  const grok = await readFile(join(temporary, 'docs/install/grok.md'), 'utf8');
  assert.match(readme, /Version: `9\.8\.7`/);
  assert.match(grok, /grok plugin install Fate-Labs-CA\/estelle-plugins@v9\.8\.7#plugins\/grok/);
  assert.equal(run('--check').status, 0);
  await writeFile(join(temporary, 'docs/install/grok.md'), grok.replace('@v9.8.7#', '@v0.0.0#'));
  const broken = run('--check');
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Generated file differs: docs\/install\/grok\.md/);
});
