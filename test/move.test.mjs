import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MOVING, messageOf, noteCurrentSession, parseWords, runMove } from '../runtime/move.mjs';

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
  // A URL, as a real origin is. A Windows path has backslashes, and `repository` rightly finds no owner/name in it.
  run(cwd, 'remote', 'add', 'origin', pathToFileURL(origin).href);
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
  const move = (mode, words = '', over = {}) => runMove({ mode, words, env, cwd, stateDir, home, request, sleep: async () => {},
    isPublic: async () => false, ...over });
  return { cwd, origin, calls, replies, move, home, transcriptPath, posted: () => calls.find(c => c.path === '/sessions/move' && !c.body.action)?.body };
}

// A file origin already has, with a local change on top: what a snapshot still carries.
async function tracked(w, name, content) {
  await mkdir(join(w.cwd, name, '..'), { recursive: true });
  await writeFile(join(w.cwd, name), 'plain\n');
  run(w.cwd, 'add', '-f', name);
  run(w.cwd, 'commit', '-q', '-m', `add ${name}`);
  run(w.cwd, 'push', '-q', 'origin', 'main');
  await writeFile(join(w.cwd, name), content);
}

// ── second review ─────────────────────────────────────────────────────────────────────────────────────────────────
test('with no API key the plugin pushes what it must and hands the model one exact MCP call', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  const { final, mcp } = await w.move('handoff', 'finish it', { request: null });
  const [marker, json] = final.split('\n');
  assert.equal(marker, 'ESTELLE_MCP_CALL');
  assert.deepEqual(JSON.parse(json), mcp);
  assert.equal(mcp.mode, 'handoff');
  assert.equal(mcp.confirm, true);
  assert.equal(mcp.note, 'finish it');
  assert.equal(mcp.session_id, `claude-code-${SID}`);
  assert.equal(run(w.origin, 'rev-parse', `refs/heads/${mcp.snapshot_branch}`), mcp.commit, 'the box can check it out');
  assert.equal(mcp.native, undefined, 'a tool call cannot carry the conversation');
  assert.doesNotMatch(final, /could not confirm/);
  assert.equal(w.calls.length, 0, 'nothing reached for a server this process cannot authenticate to');
});

test('with no key the server still learns the id this session checkpoints under, and the CLI adds no speech of its own', async t => {
  const w = await world(t);
  const said = [];
  const { mcp, final } = await w.move('handoff', '', { request: null, say: line => said.push(line) });
  assert.deepEqual(said, [MOVING]);
  assert.equal(mcp.context_session_id, SID, 'the server can find a checkpoint saved under the host id');
  assert.ok(final.startsWith('ESTELLE_MCP_CALL'));
});

test('with a key the server is told the id this session checkpoints under', async t => {
  const w = await world(t);
  await w.move('handoff');
  assert.equal(w.posted().context_session_id, SID);
  assert.ok(w.calls.some(c => c.path === '/checkpoint' && c.body.session_id === SID), 'the id it names is the id it saved under');
});

test('a binary file named as a credential in an unpushed commit is refused by name, which its diff cannot show', async t => {
  const w = await world(t);
  await mkdir(join(w.cwd, 'certs'));
  await writeFile(join(w.cwd, 'certs/signing.p12'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  run(w.cwd, 'add', '.');
  run(w.cwd, 'commit', '-q', '-m', 'oops');
  assert.match(run(w.cwd, 'log', '-p', '-1', '--format='), /Binary files/, 'the premise: the diff has no +++ line for it');
  await rm(join(w.cwd, 'certs'), { recursive: true });
  run(w.cwd, 'add', '-A');
  run(w.cwd, 'commit', '-q', '-m', 'removed it, still in history');
  await assert.rejects(w.move('handoff'), error => /certs\/signing\.p12/.test(error.reason));
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
  assert.equal(w.posted(), undefined);
});

// Built at runtime, because the point is real-shaped values and a literal one in a repository is what this refuses.
const OPAQUE = 'a1B2c3D4'.repeat(4);
const SHAPED = {
  'a Google key': ['AI', 'za', 'aB3_'.repeat(8), 'xyz'].join(''),
  'a SendGrid key': ['SG', '.', 'a1B2'.repeat(6), '.', 'c3D4'.repeat(10)].join(''),
  'an unlabeled vendor prefix': ['crsr', '_', OPAQUE].join(''),
  'an uppercase vendor prefix': ['CRSR', '_', OPAQUE].join(''),
};
for (const [name, value] of Object.entries(SHAPED)) {
  test(`${name} in a changed file never reaches origin`, async t => {
    const w = await world(t);
    await writeFile(join(w.cwd, 'a.txt'), `${value}\n`);
    await w.move('handoff');
    assert.deepEqual(w.posted().left_behind, ['a.txt']);
    assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
  });
  test(`${name} in an unpushed commit never reaches origin`, async t => {
    const w = await world(t);
    await writeFile(join(w.cwd, 'a.txt'), `${value}\n`);
    run(w.cwd, 'commit', '-q', '-am', 'oops');
    await assert.rejects(w.move('handoff', '', { request: null }), error => /in their history/.test(error.reason));
    assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
  });
}

test('a new session pushes nothing, is not refused over its tree, and says first what it leaves out', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'config.key'), 'plain words\n');
  await writeFile(join(w.cwd, 'a.txt'), 'uncommitted\n');
  const said = [];
  await w.move('cloud', 'talk to it about the weather', { say: line => { said.push(line); assert.equal(w.posted(), undefined, 'before the machine starts'); } });
  const body = w.posted();
  const head = run(w.cwd, 'rev-parse', 'HEAD');
  assert.equal(body.git.commit, head, 'the commit origin already has');
  assert.equal(body.git.snapshot_branch, undefined);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
  assert.equal(w.calls.filter(c => c.path === '/checkpoint').length, 0, 'there is no session to save for a new one');
  assert.deepEqual(said, [`Starts from main at ${head.slice(0, 7)}. Your 2 uncommitted files aren't included.`]);
});

test('a clean new session says nothing first, and never says it is moving anything', async t => {
  const w = await world(t);
  const said = [];
  await w.move('cloud', 'fix it', { say: line => said.push(line) });
  assert.deepEqual(said, []);
});

test('one uncommitted file reads as one', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  const said = [];
  await w.move('cloud', 'fix it', { say: line => said.push(line) });
  assert.match(said[0], /Your 1 uncommitted file isn't included\.$/);
});

test('a new session on an unpushed commit names the commit it starts from, and pushes nothing', async t => {
  const w = await world(t);
  const pushed = run(w.cwd, 'rev-parse', 'HEAD');
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  run(w.cwd, 'commit', '-q', '-am', 'local only');
  const said = [];
  const { mcp } = await w.move('cloud', 'fix it', { request: null, say: line => said.push(line) });
  assert.equal(mcp.commit, pushed);
  assert.deepEqual(said, [`Starts from main at ${pushed.slice(0, 7)}. Your 1 unpushed commit isn't included.`]);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

test('a slow git is not a clean tree: a handoff refuses and pushes nothing', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  await rm(join(w.cwd, '.git/index'));
  await writeFile(join(w.cwd, '.git/index'), 'not an index');
  await assert.rejects(w.move('handoff'), error => /could not read this repository/.test(error.reason));
  assert.equal(w.posted(), undefined);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

test('an origin that is not on GitHub is refused by name rather than cloned as a namesake', async t => {
  const w = await world(t);
  run(w.cwd, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/app.git');
  const env = { ...process.env, ESTELLE_REPO: '' };
  for (const mode of ['cloud', 'handoff']) {
    await assert.rejects(w.move(mode, 'fix it', { env }), error => /origin is gitlab\.com/.test(error.reason));
  }
  assert.equal(w.posted(), undefined);
  run(w.cwd, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  await w.move('cloud', 'fix it', { env, request: async (path, body) => { w.calls.push({ path, body }); return { moved: true, last_message: 'L' }; } });
  assert.equal(w.posted().repo, 'acme/app');
});

test('a box starts no box through this door', async t => {
  const w = await world(t);
  await assert.rejects(w.move('cloud', 'fix it', { env: { ...process.env, ESTELLE_EXECUTION_SESSION_ID: 'ade-launch-0123456789abcdef' } }),
    error => /already running in the cloud/.test(error.reason));
  assert.equal(w.posted(), undefined);
});

test('a new session needs no repository at all, and a handoff still does', async t => {
  const base = await mkdtemp(join(tmpdir(), 'estelle-no-repo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ESTELLE_REPO: '' };
  const calls = [];
  const request = async (path, body) => { calls.push(body); return { moved: true, final: true, session_id: 's', last_message: 'LINE' }; };
  const options = { env, cwd: base, stateDir: join(base, 'state'), request, sleep: async () => {} };
  const { final } = await runMove({ mode: 'cloud', words: 'talk about the weather', ...options });
  assert.equal(final, 'LINE');
  assert.equal(calls[0].repo, undefined);
  assert.deepEqual(calls[0].git, {});
  assert.equal((await runMove({ mode: 'cloud', words: 'talk about the weather', ...options, request: null })).mcp.repo, undefined);
  await assert.rejects(runMove({ mode: 'handoff', words: '', ...options }), error => /not a Git repository/.test(error.reason));
});

test('every refusal ends on a link, and one that could not tell keeps its own', () => {
  const env = { ESTELLE_SITE_URL: 'https://example.test/' };
  assert.match(messageOf(Object.assign(new Error('move_refused'), { reason: 'No.', needed: 'Do this.' }), env), /^No\. Do this\. https:\/\/example\.test\/dashboard\/sessions$/);
  assert.match(messageOf(new Error('boom'), env), /https:\/\/example\.test\/dashboard\/sessions$/);
  assert.doesNotMatch(messageOf(Object.assign(new Error('move_refused'), { reason: 'Unsure.', needed: 'Watch it: https://x.test/a', uncertain: true }), env), /example\.test/);
});

for (const name of ['cloud', 'handoff']) {
  test(`/estelle ${name} tells the model to just do it, with one line back`, async () => {
    const text = await readFile(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
    for (const word of ['Say nothing first', '`estelle_resume`', '`estelle_silo`', '`session_message`', 'do not run git', 'one line', 'link', '`Starts from`']) {
      assert.ok(text.includes(word), word);
    }
  });
}

test('the MCP call is a body the tool schema accepts: scalars, and a list of names', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'new.txt'), 'untracked\n');
  const { mcp } = await w.move('cloud', 'codex fix it', { request: null });
  for (const value of Object.values(mcp)) assert.notEqual(typeof value, 'object');
  assert.equal(mcp.harness, 'codex');
  assert.equal(mcp.prompt, 'fix it');
  await writeFile(join(w.cwd, 'server.pem'), 'x\n');
  const handoff = await w.move('handoff', '', { request: null });
  assert.equal(handoff.mcp.files_carried, 1);
  assert.deepEqual(handoff.mcp.left_behind, ['server.pem']);
});

test('with no key, the same tree and words are the same intent and a changed tree is a new one', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  const first = (await w.move('handoff', 'go', { request: null })).mcp;
  const again = (await w.move('handoff', 'go', { request: null })).mcp;
  assert.equal(again.move_key, first.move_key);
  assert.equal(again.commit, first.commit, 'a rerun pushes the same commit');
  await writeFile(join(w.cwd, 'a.txt'), 'three\n');
  assert.notEqual((await w.move('handoff', 'go', { request: null })).mcp.move_key, first.move_key);
});

test('the command ends at the link: it never polls, so a shell timeout cannot leave a machine with no link', async t => {
  const w = await world(t);
  w.replies.move = { moved: true, final: false, session_id: 's', last_message: 'THE LINK LINE' };
  for (const mode of ['handoff', 'cloud']) {
    const { final } = await w.move(mode, 'go');
    assert.equal(final, 'THE LINK LINE');
  }
  assert.equal(w.calls.filter(c => c.body.action === 'status').length, 0);
});

for (const name of ['config/master.key', 'deploy/server.pem', '.aws/credentials', '.env']) {
  test(`${name}, tracked and changed, stays behind by name and the handoff goes on`, async t => {
    const w = await world(t);
    await tracked(w, name, 'new words\n');
    await writeFile(join(w.cwd, 'a.txt'), 'two\n');
    await w.move('handoff');
    const { git, left_behind: behind } = w.posted();
    assert.deepEqual(behind, [name]);
    assert.equal(run(w.origin, 'show', `${git.commit}:${name}`), 'plain', 'origin keeps what it had, not the change');
    assert.equal(run(w.origin, 'show', `${git.commit}:a.txt`), 'two');
  });
  test(`${name}, untracked, never goes and is named`, async t => {
    const w = await world(t);
    await mkdir(join(w.cwd, name, '..'), { recursive: true });
    await writeFile(join(w.cwd, name), 'plain words\n');
    await writeFile(join(w.cwd, 'a.txt'), 'two\n');
    await w.move('handoff');
    const { git, left_behind: behind } = w.posted();
    assert.deepEqual(behind, [name]);
    assert.throws(() => run(w.origin, 'show', `${git.commit}:${name}`), 'a credential path does not cross');
  });
}

test('untracked work goes with a handoff, and the count says so', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'new.txt'), 'untracked\n');
  await writeFile(join(w.cwd, 'customers.csv'), 'a,b\n');
  await w.move('handoff');
  const { git, files_carried: went, left_behind: behind } = w.posted();
  assert.equal(run(w.origin, 'show', `${git.commit}:new.txt`), 'untracked');
  assert.equal(run(w.origin, 'show', `${git.commit}:customers.csv`), 'a,b');
  assert.equal(went, 2);
  assert.equal(behind, undefined);
});

test('a file the scan flags stays behind by name, tracked or not, and the rest go', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'flagged.txt'), 'flag-this-line\n');
  await writeFile(join(w.cwd, 'fine.txt'), 'fine\n');
  await w.move('handoff', '', { scan: text => text.includes('flag-this-line') });
  const { git, left_behind: behind, files_carried: went } = w.posted();
  assert.deepEqual(behind, ['flagged.txt']);
  assert.equal(went, 1);
  assert.throws(() => run(w.origin, 'show', `${git.commit}:flagged.txt`));
  assert.equal(run(w.origin, 'show', `${git.commit}:fine.txt`), 'fine');
});

test('a file past the scan bound stays behind by name', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'huge.bin'), Buffer.alloc(2_000_001, 97));
  await writeFile(join(w.cwd, 'fine.txt'), 'fine\n');
  await w.move('handoff');
  assert.deepEqual(w.posted().left_behind, ['huge.bin']);
});

test('when everything is skipped there is no snapshot, and the handoff still goes', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'server.pem'), 'x\n');
  await w.move('handoff');
  assert.equal(w.posted().git.snapshot_branch, undefined);
  assert.deepEqual(w.posted().left_behind, ['server.pem']);
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

test('past the list sent, the count of what stayed is still true', async t => {
  const w = await world(t);
  for (let n = 0; n < 70; n += 1) await writeFile(join(w.cwd, `key${n}.pem`), 'x\n');
  await w.move('handoff');
  assert.equal(w.posted().left_behind.length, 64);
  assert.equal(w.posted().left_behind_more, 6);
});

test('a line origin already has is not refused for sitting beside a new one', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'flag-this-line\none\n');
  run(w.cwd, 'commit', '-q', '-am', 'first');
  run(w.cwd, 'push', '-q', 'origin', 'main');
  await writeFile(join(w.cwd, 'a.txt'), 'flag-this-line\none\ntwo\n');
  run(w.cwd, 'commit', '-q', '-am', 'second');
  await w.move('handoff', '', { scan: text => text.includes('flag-this-line') && !text.startsWith('flag-this-line') });
  assert.ok(w.posted().git.snapshot_branch);
});

test('every skipped file is named at once', async t => {
  const w = await world(t);
  await tracked(w, 'config/master.key', 'x\n');
  await tracked(w, 'id_rsa', 'x\n');
  await w.move('handoff');
  assert.deepEqual(w.posted().left_behind.sort(), ['config/master.key', 'id_rsa']);
});

test('text the scan flags in an unpushed commit is refused even when a later commit deleted it', async t => {
  const w = await world(t);
  await writeFile(join(w.cwd, 'a.txt'), 'flag-this-line\n');
  run(w.cwd, 'commit', '-q', '-am', 'oops');
  await writeFile(join(w.cwd, 'a.txt'), 'clean\n');
  run(w.cwd, 'commit', '-q', '-am', 'fixed it');
  const scan = text => text.includes('flag-this-line');
  await assert.rejects(w.move('handoff', '', { scan }), error => /in their history/.test(error.reason));
  assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
});

for (const [answer, kind] of [[true, 'public'], [null, 'unreadable']]) {
  for (const request of ['key', 'no key']) {
    test(`on a ${kind} remote with ${request} nothing leaves this machine, it is all named, and the handoff goes on`, async t => {
      const w = await world(t);
      await writeFile(join(w.cwd, 'a.txt'), 'two\n');
      await writeFile(join(w.cwd, 'config.local.conf'), 'three\n');
      const said = [];
      const options = { isPublic: async () => answer, say: line => said.push(line) };
      const { mcp } = await w.move('handoff', '', request === 'key' ? options : { ...options, request: null });
      const sent = mcp ?? w.posted();
      assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '', 'nothing pushed');
      assert.equal(sent.snapshot_branch ?? sent.git?.snapshot_branch, undefined);
      assert.equal(sent.native?.files?.length ?? 0, 0, 'and nothing goes to the box either');
      assert.deepEqual([...sent.left_behind].sort(), ['a.txt', 'config.local.conf']);
      assert.ok(said.some(line => /stay on this machine/.test(line)), said.join('|'));
    });
  }
  test(`on a ${kind} remote, unpushed commits stay too, and it starts from the commit origin has`, async t => {
    const w = await world(t);
    const pushed = run(w.cwd, 'rev-parse', 'HEAD');
    await writeFile(join(w.cwd, 'a.txt'), 'two\n');
    run(w.cwd, 'commit', '-q', '-am', 'local');
    await w.move('handoff', '', { isPublic: async () => answer });
    assert.equal(w.posted().git.commit, pushed);
    assert.deepEqual(w.posted().left_behind, ['1 unpushed commit']);
    assert.equal(run(w.origin, 'for-each-ref', 'refs/heads/estelle'), '');
  });
}

test('the commands name a path that exists, and Codex documents the skill and says there is no slash command', async () => {
  for (const name of ['handoff', 'cloud']) {
    const text = await readFile(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /named at\s+session start/, 'nothing names it at session start');
    const skill = new URL(`../plugins/codex/command-skills/${name}/`, import.meta.url);
    assert.match(await readFile(new URL('../../runtime/cli.mjs', skill), 'utf8'), /move/, 'the Codex path resolves from the skill folder');
  }
  const docs = await readFile(new URL('../docs/install/codex.md', import.meta.url), 'utf8');
  assert.match(docs, /`estelle:handoff`/);
  assert.match(docs, /no `\/estelle:handoff` here/);
});

test('a public repository with nothing to snapshot still hands off, and a private one pushes', async t => {
  const w = await world(t);
  await w.move('handoff', '', { isPublic: async () => { throw new Error('nothing to snapshot, so nothing to ask'); } });
  assert.equal(w.posted().git.snapshot_branch, undefined);
  await writeFile(join(w.cwd, 'a.txt'), 'two\n');
  await w.move('handoff', 'again');
  assert.ok(w.calls.filter(c => c.path === '/sessions/move').at(-1).body.git.snapshot_branch);
});

test('a long note is refused rather than quietly cut', () => {
  assert.throws(() => parseWords('handoff', 'x'.repeat(601)), /move_refused/);
  assert.equal(parseWords('handoff', 'x'.repeat(600)).note.length, 600);
});

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
  assert.equal(run(w.origin, 'show', `${git.commit}:a.txt`), 'two', 'a tracked change crosses');
  assert.equal(w.posted().files_carried, 2);
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



test('cloud carries the prompt and needs no session', async t => {
  const w = await world(t);
  await w.move('cloud', 'codex fix the build');
  const body = w.posted();
  assert.equal(body.prompt, 'fix the build');
  assert.equal(body.harness, 'codex');
  assert.ok(body.move_key.length >= 8);
  assert.equal(body.native, undefined);
});

test('the same ask is one key, so the server can say it is already running, and another folder is another ask', async t => {
  const w = await world(t);
  await w.move('cloud', 'fix it');
  const first = w.posted().move_key;
  w.calls.length = 0;
  w.replies.move = { moved: false, already_running: true, final: true, session_id: 's', last_message: 'ALREADY' };
  const again = await w.move('cloud', 'fix it');
  assert.equal(again.final, 'ALREADY');
  assert.equal(w.posted().move_key, first);
  const base = await mkdtemp(join(tmpdir(), 'estelle-folders-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const keys = [];
  const request = async (_path, body) => { keys.push(body.move_key); return { moved: true, last_message: 'L' }; };
  for (const folder of ['one', 'two']) {
    await mkdir(join(base, folder));
    await runMove({ mode: 'cloud', words: 'talk about the weather', env: { ...process.env, ESTELLE_REPO: '' }, cwd: join(base, folder), stateDir: join(base, 'state'), request });
  }
  assert.notEqual(keys[0], keys[1]);
});

// ── review blocker 2: a rerun after a timeout never buys a second machine ─────────────────────────────────────────
const lostAnswer = w => async (path, body) => {
  w.calls.push({ path, body });
  if (path === '/checkpoint') return {};
  throw new DOMException('deadline', 'TimeoutError');
};

test('a timed-out handoff gives a link and says to rerun, and the rerun checks with the same key and starts nothing', async t => {
  const w = await world(t);
  let failure;
  await w.move('handoff', 'fix the build', { request: lostAnswer(w) }).catch(error => { failure = error; });
  assert.match(failure.reason, /could not confirm whether this started/);
  assert.match(failure.needed, /https:\/\/fatelabs\.ca\/dashboard\/sessions\?session=/);
  const key = w.posted().move_key;
  w.calls.length = 0;
  w.replies.status = { found: true, final: true, session_id: 's', state: 'working', moved: true, last_message: 'IT DID START' };
  const again = await w.move('handoff', 'fix the build');
  assert.equal(again.final, 'IT DID START');
  assert.equal(w.calls.length, 1, 'only a status read: no git, no checkpoint and no launch');
  assert.deepEqual([w.calls[0].body.action, w.calls[0].body.move_key], ['status', key]);
});

test('a timed-out new session gives a link, and asking again is the same key', async t => {
  const w = await world(t);
  let failure;
  await w.move('cloud', 'fix it', { request: lostAnswer(w) }).catch(error => { failure = error; });
  assert.match(failure.needed, /dashboard\/sessions/);
  const key = w.posted().move_key;
  w.calls.length = 0;
  await w.move('cloud', 'fix it');
  assert.equal(w.posted().move_key, key);
});

test('when the server never heard of it, the rerun launches once with the same key, and then the intent is over', async t => {
  const w = await world(t);
  await w.move('handoff', 'go', { request: lostAnswer(w) }).catch(() => {});
  const first = w.posted().move_key;
  w.calls.length = 0;
  w.replies.status = { found: false };
  await w.move('handoff', 'go');
  assert.equal(w.posted().move_key, first);
  w.calls.length = 0;
  await w.move('handoff', 'go');
  assert.notEqual(w.posted().move_key, first, 'once the outcome is known, running it again is a new intent');
});

test('an unknown answer keeps the key, so the next run checks rather than launches', async t => {
  const w = await world(t);
  w.replies.move = { moved: null, final: true, state: 'unknown', session_id: 's', last_message: 'CANNOT TELL' };
  assert.equal((await w.move('handoff', 'go')).final, 'CANNOT TELL');
  w.calls.length = 0;
  w.replies.status = { found: true, final: true, state: 'unknown', moved: null, session_id: 's', last_message: 'STILL CANNOT TELL' };
  assert.equal((await w.move('handoff', 'go')).final, 'STILL CANNOT TELL');
  assert.equal(w.posted(), undefined, 'nothing launched');
});

test('a server refusal releases the key, because nothing started', async t => {
  const w = await world(t);
  const refused = async (path, body) => {
    w.calls.push({ path, body });
    if (path === '/checkpoint') return {};
    throw Object.assign(new Error('bad'), { status: 400 });
  };
  await w.move('handoff', 'go', { request: refused }).catch(() => {});
  const first = w.posted().move_key;
  w.calls.length = 0;
  await w.move('handoff', 'go');
  assert.notEqual(w.posted().move_key, first);
});

test('the shipped commands reach the CLI through stdin, so no shell parses a person\'s words', async () => {
  for (const name of ['handoff', 'cloud']) {
    const text = await readFile(new URL(`../commands/${name}.md`, import.meta.url), 'utf8');
    assert.match(text, new RegExp(`move ${name} <<'ESTELLE_MOVE'`));
    assert.match(text, /only act on this when the person typed the command themselves/i);
    assert.doesNotMatch(text, /!`/, 'no shell injection line holds $ARGUMENTS');
  }
});
