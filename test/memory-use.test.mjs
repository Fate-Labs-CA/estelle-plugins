// What leaves the machine as memory, and what the agent is told about it. Each test drives the real hook entry point
// (handleHook) or the real git, with a recording request, and asserts the innermost layer: the request body.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleHook } from '../runtime/hooks.mjs';
import { repository, repoNameFromRemote } from '../runtime/io.mjs';
import { redact, scrub, stripPrivate } from '../runtime/redact.mjs';

const AT = '2026-11-23T12:00:00.000Z';
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
const git = (root, args) => assert.equal(spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args],
  { env: gitEnv, encoding: 'utf8' }).status, 0);

async function fixture(t, remote = 'https://github.com/fixture/memory-use.git', remoteName = 'origin') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'estelle-memory-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['remote', 'add', remoteName, remote]);
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior === undefined) delete process.env.ESTELLE_REPO; else process.env.ESTELLE_REPO = prior; });
  return { directory, root, stateDir: join(directory, 'state') };
}

function spy() {
  const calls = [];
  return { calls, request: async (route, body) => {
    calls.push({ route, body });
    return route === '/search' ? { recall: 'You decided: pgvector, not Pinecone.' } : {};
  } };
}

const prompt = (f, text) => ({ session_id: 'mem-session', cwd: f.root, hook_event_name: 'UserPromptSubmit', transcript_path: null, prompt: text });

test('the prompt hook asks for memories by name, so a server whose chunk push is off still returns them (#2151)', async t => {
  const f = await fixture(t);
  const { calls, request } = spy();
  await handleHook({ host: 'claude-code', payload: prompt(f, 'why did we pick pgvector for recall'), stateDir: f.stateDir, request });
  const body = calls.find(call => call.route === '/search').body;
  assert.deepEqual(body.kinds, ['memory']);
  assert.equal(body.code, false, 'still the quiet hook shape: no code search');
});

test('a <private> span in a prompt never reaches recall, and the rest of the prompt still does', async t => {
  const f = await fixture(t);
  const { calls, request } = spy();
  const out = await handleHook({ host: 'claude-code', payload: prompt(f, 'why pgvector? <private>my salary is 90k</private> thanks'), stateDir: f.stateDir, request });
  const body = calls.find(call => call.route === '/search').body;
  assert.equal(body.query, 'why pgvector? [private] thanks');
  assert.ok(!JSON.stringify(calls).includes('salary'));
  assert.equal(out.hookSpecificOutput.additionalContext, 'You decided: pgvector, not Pinecone.');
});

test('a prompt that is only private text, or has an unclosed tag, sends nothing readable', async t => {
  const f = await fixture(t);
  const only = spy();
  await handleHook({ host: 'claude-code', payload: prompt(f, '<private>the whole thing</private>'), stateDir: f.stateDir, request: only.request });
  assert.equal(only.calls.filter(call => call.route === '/search').length, 0);
  const open = spy();
  await handleHook({ host: 'claude-code', payload: prompt(f, 'keep this <PRIVATE>and forget to close it'), stateDir: f.stateDir, request: open.request });
  assert.equal(open.calls.find(call => call.route === '/search').body.query, 'keep this [private]');
});

test('the checkpoint at Stop drops private spans from both sides and drops a message that was only private', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'session.jsonl');
  const line = (type, uuid, text) => JSON.stringify({ type, uuid, timestamp: AT, message: { role: type, content: [{ type: 'text', text }] } });
  await writeFile(path, [
    line('user', 'u1', 'use the staging db <private>password is hunter2hunter2</private> for the test'),
    line('assistant', 'a1', 'Done. Staging uses db-7. <private>hunter2hunter2</private>'),
    line('user', 'u2', '<private>just between us</private>'),
    line('assistant', 'a2', 'Noted. The unclosed case: <private>never closed'),
  ].join('\n') + '\n');
  const { calls, request } = spy();
  await handleHook({ host: 'claude-code', payload: { session_id: 'mem-session', cwd: f.root, hook_event_name: 'Stop', transcript_path: path }, stateDir: f.stateDir, request });
  const sent = calls.filter(call => call.route === '/checkpoint').flatMap(call => call.body.messages);
  assert.deepEqual(sent.map(message => message.content), [
    'use the staging db [private] for the test', 'Done. Staging uses db-7. [private]', 'Noted. The unclosed case: [private]']);
  assert.ok(!JSON.stringify(calls).includes('hunter2'));
  assert.ok(!JSON.stringify(calls).includes('between us'));
});

test('redact stays a credential test: private tags alone do not make a file look like it holds a secret', () => {
  assert.equal(redact('<private>x</private>'), '<private>x</private>');
  assert.equal(stripPrivate('a <private>b</private> c <private>d'), 'a [private] c [private]');
  assert.equal(scrub('<Private>sk_live_abcdefgh1234</Private>'), '[private]');
});

test('credential shapes beyond the first dozen vendors are redacted from what is sent', () => {
  const body = 'Zq8xW2vN7pL4kR9tY3mB6cD1';
  const secrets = {
    npm: `npm_${body}${body.slice(0, 12)}`, gitlab: `glpat-${body}`, huggingface: `hf_${body}${body.slice(0, 10)}`,
    stripeWebhook: `whsec_${body}`, digitalocean: `dop_v1_${'a1b2c3d4'.repeat(8)}`, shopify: `shpat_${'a1b2'.repeat(8)}`,
    linear: `lin_api_${body}${body.slice(0, 16)}`, supabase: `sbp_${'a1b2c3d4'.repeat(5)}`, twilio: `SK${'0123456789abcdef'.repeat(2)}`,
    mailgun: `key-${'a1b2c3d4'.repeat(4)}`, slackWebhook: `https://hooks.slack.com/services/T01234567/B01234567/${body}`,
    discordWebhook: `https://discord.com/api/webhooks/123456789012345678/${body}${body}`,
    sentry: `https://${'a'.repeat(32)}@o123.ingest.sentry.io/456`,
    mysql: `mysql://admin:${body}@db.internal:3306/app`, redis: `redis://:${body}@cache:6379`,
    mongo: `mongodb+srv://u:${body}@c0.mongodb.net/db`, httpsBasic: `https://deploy:${body}@git.example.com/o/r.git`,
    authBasic: `Authorization: Basic ${Buffer.from(`user:${body}`).toString('base64')}`, authToken: `Authorization: token ${body}`,
    header: `curl -H "X-Auth-Token: ${body}" https://x`, passwd: `DB_PASSWD=${body}`,
    azure: `AccountKey=${Buffer.from(body.repeat(3)).toString('base64')};`, sshpass: `sshpass -p '${body}' ssh host`,
  };
  for (const [name, secret] of Object.entries(secrets)) {
    const clean = redact(`before ${secret} after`);
    const secretPart = secret.split(/[ :=@"'/]/).filter(part => part.length >= 16).pop();
    assert.ok(!clean.includes(secretPart), `${name}: ${clean}`);
    assert.match(clean, /^before .*after$/);
  }
  assert.equal(redact('see https://github.com/o/r and user@host:path and key-value'), 'see https://github.com/o/r and user@host:path and key-value');
});

test('two clones of one repository get one name, however the remote is spelled', () => {
  for (const remote of ['git@github.com:Fate-Labs-CA/estelle.git', 'https://github.com/Fate-Labs-CA/estelle', 'https://github.com/Fate-Labs-CA/estelle/',
    'https://token:x@github.com/Fate-Labs-CA/estelle.git/', 'ssh://git@github.com:22/Fate-Labs-CA/estelle.git', ' https://github.com/Fate-Labs-CA/estelle.git\n']) {
    assert.equal(repoNameFromRemote(remote), 'Fate-Labs-CA/estelle', remote);
  }
  assert.equal(repoNameFromRemote(''), '');
  assert.equal(repoNameFromRemote('not-a-remote'), '');
});

test('a trailing-slash remote and a remote that is not called origin still find the repository', async t => {
  const slash = await fixture(t, 'https://github.com/fixture/slash/');
  assert.equal(repository(slash.root).name, 'fixture/slash');
  const fork = await fixture(t, 'git@github.com:fixture/forked.git', 'upstream');
  assert.equal(repository(fork.root).name, 'fixture/forked');
});

test('the memory guidance reaches every host as one authored section', async () => {
  const root = join(import.meta.dirname, '..');
  const map = await readFile(join(root, 'intent-map.md'), 'utf8');
  assert.match(map, /## Memory/);
  for (const word of ['<private>', '`memory_chat`', '`list_sessions`', 'repeat an investigation', 'What you write in the\n  reply is what gets remembered'.replace('\n  ', ' ')]) {
    assert.ok(map.replace(/\s+/g, ' ').includes(word.replace(/\s+/g, ' ')), word);
  }
  for (const host of ['claude', 'codex', 'cursor', 'grok', 'kimi', 'qwen', 'gemini', 'opencode', 'pi', 'hermes', 'dsh']) {
    assert.ok((await readFile(join(root, 'plugins', host, 'instructions.md'), 'utf8')).includes('## Memory'), host);
  }
});
