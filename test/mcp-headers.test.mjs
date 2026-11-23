import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cwdOfProcess, hostRepository, mcpRepoHeaders } from '../runtime/mcp-headers.mjs';

const CLI = join(import.meta.dirname, '..', 'runtime', 'cli.mjs');
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

async function checkout(t, remote) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'estelle-mcp-headers-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  if (remote) git(directory, 'remote', 'add', 'origin', remote);
  return directory;
}

test('a known checkout becomes the one repository header; an unknown one adds none', () => {
  const found = { name: 'Fate-Labs-CA/estelle' };
  assert.deepEqual(mcpRepoHeaders({ env: {}, pid: 100, cwdOf: () => '/work/estelle', repo: () => found, run: () => '0' }),
    { 'X-Estelle-Repo': 'Fate-Labs-CA/estelle' });
  assert.deepEqual(mcpRepoHeaders({ env: {}, pid: 100, cwdOf: () => '', repo: () => null, run: () => '0' }), {});
});

test('ESTELLE_REPO wins, and a malformed one is ignored rather than forwarded', () => {
  assert.deepEqual(mcpRepoHeaders({ env: { ESTELLE_REPO: 'acme/api' }, cwdOf: () => '', repo: () => null }),
    { 'X-Estelle-Repo': 'acme/api' });
  assert.deepEqual(mcpRepoHeaders({ env: { ESTELLE_REPO: 'not a repo\r\nX-Evil: 1' }, pid: 100, cwdOf: () => '',
    repo: () => null, run: () => '0' }), {});
});

test("the plugin's own directory is never mistaken for the project", () => {
  const seen = [];
  const found = hostRepository({ env: { CLAUDE_PLUGIN_ROOT: '/cache/estelle' }, pid: 10,
    cwdOf: pid => (pid === 10 ? '/cache/estelle' : '/work/app'), repo: cwd => { seen.push(cwd); return { name: 'acme/app' }; },
    run: () => '2' });
  assert.equal(found.name, 'acme/app');
  assert.deepEqual(seen, ['/work/app'], 'the repo reader was never pointed at the plugin directory');
});

test('the walk up the process tree is bounded', () => {
  let calls = 0;
  assert.equal(hostRepository({ env: {}, pid: 50, cwdOf: () => { calls += 1; return ''; }, repo: () => null, run: () => '50' }), null);
  assert.ok(calls <= 3, `read ${calls} processes`);
});

test('through a real parent process: the parent’s checkout is found though the helper runs elsewhere', async t => {
  const project = await checkout(t, 'git@github.com:Fate-Labs-CA/estelle.git');
  const elsewhere = await checkout(t, 'https://github.com/acme/not-this-one.git');
  // A stand-in for Claude Code: a process whose cwd is the project and which starts `sh -c <helper>` in another directory.
  const parent = spawn(process.execPath, ['-e', `
    const { spawnSync } = require('node:child_process');
    const run = spawnSync('sh', ['-c', ${JSON.stringify(`node ${CLI} mcp-headers`)}], { cwd: ${JSON.stringify(elsewhere)}, encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: ${JSON.stringify(elsewhere)}, ESTELLE_REPO: '' } });
    process.stdout.write(run.stdout);
  `], { cwd: project, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  for await (const chunk of parent.stdout) out += chunk;
  assert.deepEqual(JSON.parse(out), { 'X-Estelle-Repo': 'Fate-Labs-CA/estelle' });
});

test('the cli prints {} and exits 0 when no checkout is known', async t => {
  const none = await realpath(await mkdtemp(join(tmpdir(), 'estelle-mcp-headers-none-')));
  t.after(() => rm(none, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [CLI, 'mcp-headers'], { cwd: none, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: none, CLAUDE_PLUGIN_ROOT: none } });
  assert.equal(run.status, 0);
  // This test's own parent chain may sit in a checkout, so what is pinned is the shape: JSON, only the one header.
  const headers = JSON.parse(run.stdout);
  assert.ok(Object.keys(headers).every(name => name === 'X-Estelle-Repo'), run.stdout);
});

test('cwdOfProcess reads this very process', () => {
  const cwd = cwdOfProcess(process.pid);
  if (!['linux', 'darwin'].includes(process.platform)) return;
  assert.equal(cwd, process.cwd(), 'the platform lookup returned the right directory');
});
