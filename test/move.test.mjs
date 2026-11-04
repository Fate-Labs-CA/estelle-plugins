import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOVING, noteCurrentSession, parseWords, runMove } from '../runtime/move.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

// A real repository with a real bare origin. Only the server is a double, so `request` replaces the API client.
async function world(t, { host = 'claude-code', transcript = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'estelle-move-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = join(base, 'acme', 'app.git');
  await mkdir(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', origin]);
  const cwd = join(base, 'work');
  await mkdir(cwd);
  run(cwd, 'init', '-q', '-b', 'main');
  run(cwd, 'remote', 'add', 'origin', origin);
  await writeFile(join(cwd, 'a.txt'), 'one\n');
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'first');
  run(cwd, 'push', '-q', '-u', 'origin', 'main');
  const home = join(base, 'home');
  const stateDir = join(base, 'state');
  const transcriptPath = host === 'codex' ? join(home, '.codex/sessions/2026/11/04', `rollout-x-${SID}.jsonl`)
    : join(home, '.claude/projects/work', `${SID}.jsonl`);
  if (transcript) {
    await mkdir(join(transcriptPath, '..'), { recursive: true });
    const row = host === 'codex'
      ? { type: 'session_meta', payload: { id: SID, timestamp: '2026-11-04T00:00:00Z', cwd } }
      : { type: 'user', sessionId: SID, message: { role: 'user', content: 'conversation-marker' } };
    await writeFile(transcriptPath, `${JSON.stringify(row)}\n`);
  }
  const env = { ...process.env, ESTELLE_REPO: 'acme/app' };
  await noteCurrentSession(stateDir, { host, sessionId: SID, transcriptPath, cwd });
  const calls = [];
  const replies = { move: { moved: true, final: true, session_id: `${host}-${SID}`, message: 'm', last_message: 'SERVER LAST LINE' } };
  const request = async (path, body) => {
    calls.push({ path, body });
    if (path === '/checkpoint') return {};
    return body.action === 'status' ? replies.status : replies.move;
  };
  const move = (mode, words = '', over = {}) => runMove({ mode, words, env, cwd, stateDir, home, request, sleep: async () => {}, ...over });
  return { cwd, origin, calls, replies, move, home, transcriptPath, posted: () => calls.find(c => c.path === '/sessions/move' && !c.body.action)?.body };
}

test('a bare handoff needs no harness and no words', () => {
  assert.deepEqual(parseWords('handoff', ''), { harness: '', note: '' });
});

test('the first word names a harness only when it is one', () => {
  assert.deepEqual(parseWords('cloud', 'codex fix the build'), { harness: 'codex', prompt: 'fix the build' });
  assert.deepEqual(parseWords('cloud', 'fix codex'), { harness: '', prompt: 'fix codex' });
  assert.deepEqual(parseWords('handoff', 'claude finish the tests'), { harness: 'claude-code', note: 'finish the tests' });
  assert.throws(() => parseWords('cloud', 'codex'), /move_refused/);
});

test('a clean pushed handoff calls the door once with the commit and the conversation, and prints the server words', async t => {
  const w = await world(t);
  const said = [];
  const result = await w.move('handoff', '', { say: line => said.push(line) });
  const body = w.posted();
  assert.equal(said[0], MOVING);
  assert.equal(result.final, 'SERVER LAST LINE');
  assert.equal(body.mode, 'handoff');
  assert.equal(body.session_id, `claude-code-${SID}`);
  assert.equal(body.confirm, true);
  assert.equal(body.git.commit, run(w.cwd, 'rev-parse', 'HEAD'));
  assert.equal(body.git.dirty, false);
  assert.equal(body.native.session_id, SID);
  assert.match(body.native.transcript, /conversation-marker/);
  assert.equal(w.calls.filter(c => c.path === '/sessions/move').length, 1);
  assert.ok(w.calls.some(c => c.path === '/checkpoint'), 'the checkpoint is saved before the move');
  assert.ok(w.calls.findIndex(c => c.path === '/checkpoint') < w.calls.findIndex(c => c.path === '/sessions/move'));
});

test('a dirty tree goes to a read-back snapshot branch and the person\'s branch, index and files do not move', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  await writeFile(join(w.cwd, 'new.txt'), 'untracked\n');
  const before = { head: run(w.cwd, 'rev-parse', 'HEAD'), status: run(w.cwd, 'status', '--porcelain'), ref: run(w.cwd, 'rev-parse', 'main') };
  const result = await w.move('handoff');
  const { git } = w.posted();
  assert.equal(git.dirty, true);
  assert.match(git.snapshot_branch, /^estelle\/snapshot\/claude-code-/);
  assert.deepEqual({ head: run(w.cwd, 'rev-parse', 'HEAD'), status: run(w.cwd, 'status', '--porcelain'), ref: run(w.cwd, 'rev-parse', 'main') }, before);
  assert.equal(run(w.origin, 'rev-parse', `refs/heads/${git.snapshot_branch}`), git.commit, 'the remote holds it');
  assert.equal(run(w.origin, 'show', `${git.commit}:new.txt`), 'untracked', 'untracked work crosses');
  assert.equal(run(w.origin, 'rev-parse', 'main'), before.head, 'the branch on origin did not move');
  assert.equal(result.snapshot.branch, git.snapshot_branch);
});

test('unpushed commits with a clean tree also go to a snapshot, or the box could not check them out', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'local\n');
  run(w.cwd, 'commit', '-q', '-am', 'local only');
  await w.move('handoff');
  const { git } = w.posted();
  assert.ok(git.snapshot_branch);
  assert.equal(run(w.origin, 'show', `${git.commit}:a.txt`), 'local');
});

test('.env is refused with a reason and nothing is pushed or posted', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, '.env'), 'X=1\n');
  await assert.rejects(w.move('handoff'), error => /looks private/.test(error.reason));
  assert.equal(w.posted(), undefined);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

test('a file the credential scan flags is refused with a reason and nothing is pushed or posted', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'config.txt'), 'flag-this-line\n');
  const scan = text => (text.includes('flag-this-line') ? '[redacted]' : text);
  await assert.rejects(w.move('handoff', '', { scan }), error => /shaped like a credential/.test(error.reason));
  assert.equal(w.posted(), undefined);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

test('an auth file next to the conversation is never read or sent', async t => {
  const w = await world(t, { host: 'codex' });
  await writeFile(join(w.home, '.codex/auth.json'), JSON.stringify({ note: 'auth-file-marker' }));
  await w.move('handoff');
  assert.doesNotMatch(JSON.stringify(w.calls), /auth-file-marker/);
  assert.equal(w.posted().native.session_id, SID);
});

test('Codex names its thread when no hook ran, and the one rollout for that thread is found', async t => {
  const w = await world(t, { host: 'codex' });
  const stateless = join(w.home, 'no-state');
  await w.move('handoff', '', { stateDir: stateless, env: { ...process.env, ESTELLE_REPO: 'acme/app', CODEX_THREAD_ID: SID, CODEX_HOME: join(w.home, '.codex') } });
  assert.equal(w.posted().session_id, `codex-${SID}`);
  assert.equal(w.posted().native.session_id, SID);
});

test('a conversation past the bound says so and still moves from context', async t => {
  const w = await world(t);
  await writeFile(w.transcriptPath, `${JSON.stringify({ type: 'user', sessionId: SID, message: { content: 'x'.repeat(600_000) } })}\n`);
  await w.move('handoff');
  assert.equal(w.posted().native, undefined);
  assert.match(w.posted().native_unavailable, /512 KiB/);
});

test('a host with no proven import sends no conversation and says why', async t => {
  const w = await world(t, { host: 'cursor', transcript: false });
  await w.move('handoff');
  assert.equal(w.posted().native, undefined);
  assert.match(w.posted().native_unavailable, /no proven way/);
});

test('a pending import waits for the server, and the last line is the settled one', async t => {
  const w = await world(t);
  w.replies.move = { moved: true, final: false, session_id: 's', last_message: 'STILL MOVING' };
  w.replies.status = { final: true, last_message: 'SETTLED' };
  assert.equal((await w.move('handoff')).final, 'SETTLED');
});

test('polling is bounded and an unsettled move tells the person to keep the session open', async t => {
  const w = await world(t);
  w.replies.move = { moved: true, final: false, session_id: 's', last_message: 'STILL MOVING' };
  w.replies.status = { final: false };
  const { final } = await w.move('handoff');
  assert.match(final, /STILL MOVING/);
  assert.match(final, /keep this session open/);
  assert.ok(w.calls.filter(c => c.body.action === 'status').length <= 36);
});

test('cloud carries the prompt and a fresh key, and needs no session', async t => {
  const w = await world(t);
  await w.move('cloud', 'codex fix the build');
  const body = w.posted();
  assert.equal(body.prompt, 'fix the build');
  assert.equal(body.harness, 'codex');
  assert.ok(body.move_key.length >= 8);
  assert.equal(body.native, undefined);
});

// ── review blocker 2: a rerun after a timeout never buys a second machine ─────────────────────────────────────────
test('a timed-out cloud run gives a link and says to rerun, and the rerun checks with the same key and starts nothing', async t => {
  const w = await world(t);
  const lost = async (path, body) => {
    w.calls.push({ path, body });
    if (path === '/checkpoint') return {};
    throw new DOMException('deadline', 'TimeoutError');
  };
  let failure;
  await w.move('cloud', 'codex fix the build', { request: lost }).catch(error => { failure = error; });
  assert.match(failure.reason, /could not confirm whether this started/);
  assert.match(failure.needed, /https:\/\/fatelabs\.ca\/dashboard\/sessions\?session=/);
  const key = w.posted().move_key;
  w.calls.length = 0;
  w.replies.status = { found: true, final: true, session_id: 's', state: 'working', moved: true, last_message: 'IT DID START' };
  const again = await w.move('cloud', 'codex fix the build');
  assert.equal(again.final, 'IT DID START');
  assert.equal(w.calls.length, 1, 'only a status read: no git, no checkpoint and no launch');
  assert.deepEqual([w.calls[0].body.action, w.calls[0].body.move_key], ['status', key]);
});

test('when the server never heard of it, the rerun launches once with the same key', async t => {
  const w = await world(t);
  const lost = async () => { throw new DOMException('deadline', 'TimeoutError'); };
  await w.move('cloud', 'fix it', { request: lost }).catch(() => {});
  w.replies.status = { found: false };
  await w.move('cloud', 'fix it');
  const first = w.posted().move_key;
  w.calls.length = 0;
  await w.move('cloud', 'fix it');
  assert.notEqual(w.posted().move_key, first, 'once the outcome is known, running it again is a new intent');
});

test('an unknown answer keeps the key, so the next run checks rather than launches', async t => {
  const w = await world(t);
  w.replies.move = { moved: null, final: true, state: 'unknown', session_id: 's', last_message: 'CANNOT TELL' };
  assert.equal((await w.move('cloud', 'fix it')).final, 'CANNOT TELL');
  w.calls.length = 0;
  w.replies.status = { found: true, final: true, state: 'unknown', moved: null, session_id: 's', last_message: 'STILL CANNOT TELL' };
  assert.equal((await w.move('cloud', 'fix it')).final, 'STILL CANNOT TELL');
  assert.equal(w.posted(), undefined, 'nothing launched');
});

test('a server refusal releases the key, because nothing started', async t => {
  const w = await world(t);
  const refused = async (path, body) => {
    w.calls.push({ path, body });
    if (path === '/checkpoint') return {};
    throw Object.assign(new Error('bad'), { status: 400 });
  };
  await w.move('cloud', 'fix it', { request: refused }).catch(() => {});
  const first = w.posted().move_key;
  w.calls.length = 0;
  await w.move('cloud', 'fix it');
  assert.notEqual(w.posted().move_key, first);
});

test('the shipped commands reach the CLI through stdin, so no shell parses a person\'s words', async () => {
  for (const name of ['handoff', 'cloud']) {
    const text = await readFile(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
    assert.match(text, new RegExp(`move ${name} <<'ESTELLE_MOVE'`));
    assert.match(text, /disable-model-invocation: true/);
    assert.doesNotMatch(text, /!`/, 'no shell injection line holds $ARGUMENTS');
  }
});
