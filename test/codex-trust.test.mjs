import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { REVIEW_STEP, UNREADABLE, codexHookTrust, summarizeHooks } from '../runtime/codex-trust.mjs';
import { runSetup } from '../runtime/setup.mjs';
import { VERSION } from '../runtime/version.mjs';

const PLUGIN = 'estelle@estelle-plugins';
const CREDENTIAL_NAME = ['ESTELLE', 'API', 'KEY'].join('_');
const row = (trustStatus, extra = {}) => ({ pluginId: PLUGIN, trustStatus, enabled: true, ...extra });

test('hooks Codex will not run are reported as needing review, with the one thing to do', () => {
  for (const status of ['modified', 'untrusted']) {
    const result = summarizeHooks([row('trusted'), row(status)]);
    assert.equal(result.status, 'review_required');
    assert.equal(result.needs_review, 1);
    assert.equal(result.next_step, REVIEW_STEP);
  }
  assert.match(REVIEW_STEP, /Run \/hooks in Codex and press t/);
  assert.match(REVIEW_STEP, /Trust all and continue/);
  assert.match(REVIEW_STEP, /captures nothing/);
  assert.match(REVIEW_STEP, /does not check file writes/);
});

test('trusted hooks carry no instruction, and other plugins and disabled hooks do not count', () => {
  assert.deepEqual(summarizeHooks([row('trusted'), row('managed')]), { status: 'trusted', hooks: 2, needs_review: 0 });
  assert.equal(summarizeHooks([row('trusted'), row('modified', { pluginId: 'other@elsewhere' })]).status, 'trusted');
  assert.equal(summarizeHooks([row('trusted'), row('modified', { enabled: false })]).status, 'trusted');
});

test('an unreadable inventory is never reported as trusted', () => {
  assert.deepEqual(summarizeHooks([]), { status: 'not_installed' });
  assert.deepEqual(summarizeHooks([row('modified', { pluginId: 'other@elsewhere' })]), { status: 'not_installed' });
  for (const value of [undefined, null, {}, 'hooks', Array.from({ length: 65 }, () => row('trusted'))]) {
    assert.deepEqual(summarizeHooks(value), UNREADABLE);
  }
  assert.match(UNREADABLE.next_step, /Run \/hooks in Codex/, 'a failed read must still say what to do');
});

function fakeCodex(answer) {
  const child = new EventEmitter();
  const sent = [];
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line);
      sent.push(message);
      const reply = answer(message);
      if (reply) child.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  return { child, sent };
}

test('the check speaks only initialize and hooks/list, then closes the process it started', async () => {
  const { child, sent } = fakeCodex(message => {
    if (message.id === 1) return { id: 1, result: {} };
    if (message.id === 2) return { id: 2, result: { data: [{ cwd: '/x', hooks: [row('modified')] }] } };
    return null;
  });
  const result = await codexHookTrust('/x', { spawnImpl: () => child });
  assert.equal(result.status, 'review_required');
  assert.deepEqual(sent.map(message => message.method), ['initialize', 'initialized', 'hooks/list']);
  assert.equal(child.killed, true);
});

test('a silent, missing or malformed Codex reads as unavailable within the deadline', async () => {
  const silent = fakeCodex(() => null);
  assert.deepEqual(await codexHookTrust('/x', { spawnImpl: () => silent.child, deadlineMs: 20 }), UNREADABLE);
  assert.equal(silent.child.killed, true);
  const garbage = fakeCodex(() => null);
  const pending = codexHookTrust('/x', { spawnImpl: () => garbage.child });
  garbage.child.stdout.write('not json\n');
  assert.deepEqual(await pending, UNREADABLE);
  assert.deepEqual(await codexHookTrust('/x', { spawnImpl: () => { throw new Error('ENOENT'); } }), UNREADABLE);
});

const readyPorts = hookTrust => ({
  hookTrust,
  authenticate: async () => true,
  native: async operation => (operation === 'plugin'
    ? { ok: true, text: JSON.stringify({ installed: [{ pluginId: PLUGIN, name: 'estelle', marketplaceName: 'estelle-plugins',
      version: VERSION, installed: true, enabled: true }] }) }
    : { missing: true }),
});

test('setup reports the measured review state and the next step, and never writes trust', async () => {
  const env = { [CREDENTIAL_NAME]: 'fixture', CODEX_HOME: '/nonexistent/estelle-setup-test' };
  const bundleRoot = fileURLToPath(new URL('../plugins/codex', import.meta.url));
  const needed = await runSetup({ host: 'codex', env, bundleRoot, home: '/nonexistent' },
    readyPorts(async () => summarizeHooks([row('modified')])));
  assert.equal(needed.hook_review, 'review_required');
  assert.equal(needed.next_step, REVIEW_STEP);
  assert.equal(needed.trust, 'not_changed');
  const fine = await runSetup({ host: 'codex', env, bundleRoot, home: '/nonexistent' },
    readyPorts(async () => summarizeHooks([row('trusted')])));
  assert.equal(fine.hook_review, 'trusted');
  assert.equal(Object.hasOwn(fine, 'next_step'), false);
  const broken = await runSetup({ host: 'codex', env, bundleRoot, home: '/nonexistent' },
    readyPorts(async () => { throw new Error('codex gone'); }));
  assert.equal(broken.hook_review, 'unavailable');
  assert.equal(broken.next_step, UNREADABLE.next_step);
});
