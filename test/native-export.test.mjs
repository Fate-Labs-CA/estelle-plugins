import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareContinuation, continueCloud } from '../runtime/native-export.mjs';

const sid = '11111111-2222-4333-8444-555555555555';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'native-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo'), home = join(dir, 'home');
  await mkdir(cwd);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = args => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'core.hooksPath', '/dev/null']); git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  await writeFile(join(cwd, 'app.py'), 'print(1)\n'); git(['add', 'app.py']); git(['commit', '-m', 'fixture']);
  const project = join(home, '.claude/projects/project'); await mkdir(project, { recursive: true });
  const transcriptPath = join(project, `${sid}.jsonl`);
  await writeFile(transcriptPath, JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'native-only-marker' } }) + '\n');
  return { dir, cwd, home, transcriptPath, sessionId: sid, siloId: 'silo-own', harness: 'claude-code', git, consent: true, replace: true };
}

test('explicit selected session and supported dirty file are posted without unrelated history', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'app.py'), 'print(2)\n');
  let sent;
  const out = await continueCloud({ ...f, consent: true, replace: true }, async (path, body) => {
    sent = { path, body }; return { artifacts_verified: true, native_command_started: true, silo_id: f.siloId };
  });
  assert.equal(sent.path, '/ade'); assert.equal(sent.body.action, 'restore_native');
  assert.equal(sent.body.native.files[0].text, 'print(2)\n');
  assert.match(sent.body.native.transcript, /native-only-marker/);
  assert.equal(out.safe_to_close_laptop, false);
});

test('missing consent refuses before file reads or requests', async () => {
  let called = false;
  await assert.rejects(continueCloud({}, async () => { called = true; }), /consent/);
  assert.equal(called, false);
});

test('staged, untracked, binary and secret-shaped source are refused rather than lost', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'app.py'), 'staged'); f.git(['add', 'app.py']);
  await assert.rejects(prepareContinuation(f), /staged_changes/);
  f.git(['reset', '--', 'app.py']); await writeFile(join(f.cwd, 'new.py'), 'untracked');
  await assert.rejects(prepareContinuation(f), /untracked_changes/);
  await rm(join(f.cwd, 'new.py')); await writeFile(join(f.cwd, 'app.py'), 'binary\0');
  await assert.rejects(prepareContinuation(f), /credential_or_binary/);
  await writeFile(join(f.cwd, 'app.py'), 'sk-' + 'a'.repeat(30));
  await assert.rejects(prepareContinuation(f), /credential_or_binary/);
});

test('session path escape and symlinks cannot export credentials or another selected file', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareContinuation({ ...f, transcriptPath: join(f.dir, 'auth.json') }));
  const target = f.transcriptPath; await rm(target); await symlink(join(f.cwd, 'app.py'), target);
  await assert.rejects(prepareContinuation(f), /reserved_path/);
});

test('native JSON is scrubbed without truncation and byte bound refuses the entire upload', async t => {
  const f = await fixture(t);
  await writeFile(f.transcriptPath, JSON.stringify({ type: 'user', sessionId: sid, message: {
    role: 'user', content: 'Its session_token is ' + '1'.repeat(32) + ': pass it with the post.' } }) + '\n');
  const body = await prepareContinuation(f);
  assert.doesNotMatch(body.native.transcript, /1{32}/);
  assert.match(body.native.transcript, /redacted named credential/);
  await writeFile(f.transcriptPath, 'x'.repeat(512 * 1024 + 1));
  await assert.rejects(prepareContinuation(f), /bound/);
});

test('structured Rooms proofs are refused rather than sent as bare opaque values', async t => {
  const f = await fixture(t);
  await writeFile(f.transcriptPath, JSON.stringify({ type: 'user', sessionId: sid, message: {
    role: 'assistant', content: [{ type: 'tool_use', input: { session_token: '1'.repeat(32) } }] } }) + '\n');
  await assert.rejects(prepareContinuation(f), /credential_field/);
});

test('NUL git paths retain leading spaces and never substitute the similarly named file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, ' app.py'), 'original\n');
  f.git(['add', ' app.py']); f.git(['commit', '-m', 'space filename']);
  await writeFile(join(f.cwd, ' app.py'), 'dirty selected space filename\n');
  const body = await prepareContinuation(f);
  assert.deepEqual(body.native.files.map(file => file.path), [' app.py']);
  assert.equal(body.native.files[0].text, 'dirty selected space filename\n');
  assert.notEqual(body.native.files[0].text, 'print(1)\n');
});

test('opaque structured credentials are refused, including password, token and client_secret', async t => {
  const f = await fixture(t);
  for (const key of ['password', 'token', 'client_secret']) {
    await writeFile(f.transcriptPath, JSON.stringify({ type: 'user', sessionId: sid, message: {
      role: 'user', content: [{ type: 'tool_use', input: { [key]: 'opaque-credential-32' } }] } }) + '\n');
    await assert.rejects(prepareContinuation(f), /credential_field/);
  }
});

test('private reasoning is removed before any upload and the visible message stays', async t => {
  const f = await fixture(t);
  await writeFile(f.transcriptPath, JSON.stringify({ type: 'assistant', sessionId: sid, message: {
    role: 'assistant', usage: { input_tokens: 3 }, content: [{ type: 'redacted_thinking', data: 'encrypted-private-marker' },
      { type: 'text', text: 'visible-message' }] } }) + '\n');
  const sent = JSON.stringify(await prepareContinuation(f));
  assert.doesNotMatch(sent, /encrypted-private-marker/);
  assert.match(sent, /visible-message/);
});

test('POSIX space-only staged and untracked names cannot bypass unsupported-state refusal', {
  skip: process.platform === 'win32' && 'Windows cannot represent a space-only filename',
}, async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, '   '), 'fixture');
  await assert.rejects(prepareContinuation(f), /untracked_changes/);
  f.git(['add', '   ']);
  await assert.rejects(prepareContinuation(f), /staged_changes/);
});

test('UTF8 source BOM survives the selected-file snapshot byte-for-byte', async t => {
  const f = await fixture(t);
  const content = '\ufeffprint(2)\n';
  await writeFile(join(f.cwd, 'app.py'), content);
  const body = await prepareContinuation(f);
  assert.equal(body.native.files[0].text, content);
});

test('ignored ancestor symlink replacement cannot export an unrelated ignored file', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, 'safe'));
  await writeFile(join(f.cwd, 'safe/app.py'), 'original');
  f.git(['add', 'safe/app.py']);
  await writeFile(join(f.cwd, '.gitignore'), 'safe\n.private\n');
  f.git(['add', '.gitignore']); f.git(['commit', '-m', 'tracked beneath ignored directory']);
  await rm(join(f.cwd, 'safe'), { recursive: true }); await mkdir(join(f.cwd, '.private'));
  await writeFile(join(f.cwd, '.private/app.py'), 'unrelated ignored private text');
  await symlink(join(f.cwd, '.private'), join(f.cwd, 'safe'));
  await assert.rejects(prepareContinuation(f), /reserved_path/);
});

test('Codex selected rollout preserves visible conversation and typed usage metadata', async t => {
  const f = await fixture(t);
  const dir = join(f.home, '.codex/sessions/2026/10/30'); await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-30T10-00-00-${sid}.jsonl`);
  const rows = [
    { timestamp: '2026-10-30T10:00:00Z', type: 'session_meta', payload: { id: sid, timestamp: '2026-10-30T10:00:00Z', cwd: f.cwd, cli_version: '0.166.0', source: 'cli', model_provider: 'openai' } },
    { timestamp: '2026-10-30T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex-visible-marker' }] } },
    { timestamp: '2026-10-30T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 } } } },
  ];
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const options = { ...f, harness: 'codex', transcriptPath: path };
  const body = await prepareContinuation(options);
  assert.match(body.native.transcript, /codex-visible-marker/);
  assert.match(body.native.transcript, /total_token_usage/);
  const bad = structuredClone(rows); bad[0].payload.id = 'wrong';
  await writeFile(path, bad.map(row => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(prepareContinuation(options), /native_selection/);
  rows.push({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque' } });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.doesNotMatch(JSON.stringify(await prepareContinuation(options)), /opaque/);
});

test('executable-to-nonexecutable source change is explicitly refused', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'script.sh'), 'echo fixture');
  f.git(['add', 'script.sh']); f.git(['update-index', '--chmod=+x', 'script.sh']); f.git(['commit', '-m', 'executable fixture']);
  await assert.rejects(prepareContinuation(f), /file_mode_unsupported/);
});
