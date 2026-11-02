import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleHook, drainOne } from '../runtime/hooks.mjs';
import { apiClient } from '../runtime/io.mjs';
import { timelineIdentity } from '../runtime/identity.mjs';

const AT = '2026-10-30T12:00:00.000Z';
const gitKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function git(root, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of gitKeys) delete env[key];
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
    env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'estelle-hook-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/fixture/estelle-hooks.git']);
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior === undefined) delete process.env.ESTELLE_REPO; else process.env.ESTELLE_REPO = prior; });
  return { directory, root, stateDir: join(directory, 'state') };
}

async function transcript(f, name, count = 1) {
  const file = join(f.directory, `${name}.jsonl`);
  const records = Array.from({ length: count }, (_, index) => ({ type: 'user', uuid: `${name}-${index}`,
    timestamp: AT, message: { role: 'user', content: [{ type: 'text', text: `request ${index}` }] } }));
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  return file;
}

function requestSpy() {
  const calls = [];
  return { calls, request: async (route, body) => {
    calls.push({ route, body });
    return route === '/search' ? { recall: 'verified fixture recall' } : {};
  } };
}

const claudePayload = (f, event, extra = {}) => ({ session_id: 'claude-fixture', cwd: f.root,
  hook_event_name: event, transcript_path: null, ...extra });

async function codexCaptureFixture(t, withGit = false) {
  const f = await fixture(t);
  const cwd = withGit ? f.root : join(f.directory, 'not-a-git-worktree');
  if (!withGit) await mkdir(cwd);
  const path = join(f.directory, 'codex-capture.jsonl');
  await writeFile(path, JSON.stringify({ type: 'response_item', timestamp: AT,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Explain the local parser' }] } }) + '\n');
  const payload = { session_id: 'repoless-codex', cwd, transcript_path: path, hook_event_name: 'PostToolUse',
    model: 'fixture-model', turn_id: 'fixture-turn', permission_mode: 'default', tool_name: 'Read',
    tool_input: { path: 'parser.js' }, tool_use_id: 'read-fixture', tool_response: { ok: true } };
  return { ...f, payload };
}

test('Codex without a local Git repository streams its exact session without inventing a repository', async t => {
  const f = await codexCaptureFixture(t);
  const spy = requestSpy();
  await handleHook({ host: 'codex', payload: f.payload, stateDir: f.stateDir, request: spy.request });
  const batch = spy.calls.find(call => call.route === '/session/events');
  assert.ok(batch, 'a Gitless workspace still has a session timeline');
  assert.equal(batch.body.session_id, 'codex-repoless-codex');
  assert.ok(batch.body.events.some(event => event.kind === 'customer_message'));
  const started = batch.body.events.find(event => event.payload.reason === 'started');
  assert.ok(started);
  assert.equal(JSON.parse(JSON.stringify(started)).payload.repo, undefined, 'no Estelle/default/invented repository');
  assert.equal(spy.calls.some(call => call.route !== '/session/events'), false);
  const status = JSON.parse(await readFile(join(f.stateDir, 'status', 'codex-stream.json'), 'utf8'));
  assert.equal(status.status, 'ok');
  const sent = spy.calls.length;
  await handleHook({ host: 'codex', payload: f.payload, stateDir: f.stateDir, request: spy.request });
  assert.equal(spy.calls.length, sent, 'an ACKed transcript is not emitted twice');
});

test('Git capture retains its actual discovered repository and exact same session contract', async t => {
  const f = await codexCaptureFixture(t, true);
  const spy = requestSpy();
  await handleHook({ host: 'codex', payload: f.payload, stateDir: f.stateDir, request: spy.request });
  const batch = spy.calls.find(call => call.route === '/session/events');
  assert.ok(batch);
  assert.equal(batch.body.session_id, 'codex-repoless-codex');
  assert.equal(batch.body.events.find(event => event.payload.reason === 'started').payload.repo, 'fixture/estelle-hooks');
});

test('Gitless prompt capture does not authorize repository recall or reindex', async t => {
  const f = await codexCaptureFixture(t);
  const spy = requestSpy();
  const output = await handleHook({ host: 'codex', payload: { ...f.payload, hook_event_name: 'UserPromptSubmit',
    prompt: 'Explain the local parser' }, stateDir: f.stateDir, request: spy.request });
  assert.equal(output, null);
  assert.ok(spy.calls.some(call => call.route === '/session/events'));
  assert.equal(spy.calls.some(call => call.route !== '/session/events'), false, 'only capture, no repository guess');
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'status', 'codex-context.json'), 'utf8')).status, 'skipped');
});

test('Gitless deferred exit captures checkpoint and events on a later drain with no repository fallback', async t => {
  const f = await codexCaptureFixture(t);
  const spy = requestSpy();
  await handleHook({ host: 'codex', payload: { ...f.payload, hook_event_name: 'SessionEnd', reason: 'exit' },
    stateDir: f.stateDir, request: spy.request });
  assert.equal(spy.calls.length, 0, 'exit remains nonblocking and does not upload');
  assert.equal((await readdir(join(f.stateDir, 'deferred'))).length, 1);
  await drainOne(f.stateDir, spy.request);
  const stream = spy.calls.find(call => call.route === '/session/events');
  const checkpoint = spy.calls.find(call => call.route === '/checkpoint');
  assert.ok(stream && checkpoint, 'a Gitless deferred reference must not be stranded as unavailable');
  assert.equal(stream.body.session_id, 'codex-repoless-codex');
  assert.equal(checkpoint.body.session_id, 'repoless-codex'); // Existing checkpoint/native identity contract.
  assert.equal(JSON.parse(JSON.stringify(checkpoint.body)).client.repo, undefined);
  assert.equal((await readdir(join(f.stateDir, 'deferred'))).length, 0);
  await drainOne(f.stateDir, spy.request);
  assert.equal(spy.calls.length, 2, 'completed deferred capture is removed once');
});

test('Gitless capture without authentication retains the cursor and reports pending, never successful capture', async t => {
  const f = await codexCaptureFixture(t);
  let fetched = 0;
  const request = apiClient({ env: {}, fetchImpl: async () => { fetched++; throw new Error('must not fetch'); } });
  await handleHook({ host: 'codex', payload: f.payload, stateDir: f.stateDir, request });
  assert.equal(fetched, 0);
  const status = JSON.parse(await readFile(join(f.stateDir, 'status', 'codex-stream.json'), 'utf8'));
  assert.equal(status.status, 'pending');
  const state = JSON.parse(await readFile(join(f.stateDir, 'codex-repoless-codex.stream.json'), 'utf8'));
  assert.equal(state.offset, 0, 'no ACK has advanced the initial transcript');
  assert.equal(state.last_error, 'stream upload pending');
  assert.equal((await readdir(join(f.stateDir, 'spool'))).length, 1);
});

test('scan-bound partial status is silent in host context while Cursor keeps its native permission shape', async t => {
  const f = await codexCaptureFixture(t);
  const input = Array.from({ length: 10_001 }, () => 'ordinary');
  const cases = [
    ['codex', { ...f.payload, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input }, null],
    ['claude-code', claudePayload(f, 'PreToolUse', { tool_name: 'Write', tool_input: input }), null],
    ['cursor', { hook_event_name: 'preToolUse', conversation_id: 'scan-bound-cursor',
      cwd: f.root, tool_name: 'Write', tool_input: input }, { permission: 'allow' }],
  ];
  for (const [host, payload, expected] of cases) await t.test(host, async () => {
    let requests = 0;
    const output = await handleHook({ host, payload, stateDir: f.stateDir,
      request: async () => { requests++; throw new Error('must not request'); } });
    assert.deepEqual(output, expected, 'unsupported scan is not per-edit advice or a clean-scan claim');
    assert.equal(requests, 0);
    const status = JSON.parse(await readFile(join(f.stateDir, 'status', `${host}-protect.json`), 'utf8'));
    assert.equal(status.status, 'partial');
    assert.equal(status.code, 'input_bound');
  });
});

test('silent scan-bound handling does not change actual credential denial in Codex or Cursor', async t => {
  const f = await codexCaptureFixture(t);
  const value = 'ghp_' + 'a'.repeat(30); // Same synthetic shape as test/protect.test.mjs.
  const input = { content: `key=${value}` };
  const codex = await handleHook({ host: 'codex', payload: { ...f.payload, hook_event_name: 'PreToolUse',
    tool_name: 'Write', tool_input: input }, stateDir: f.stateDir, request: async () => { throw new Error('must not request'); } });
  assert.equal(codex.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.stringify(codex).includes(value), false);
  const cursor = await handleHook({ host: 'cursor', payload: { hook_event_name: 'preToolUse',
    conversation_id: 'literal-cursor', cwd: f.root, tool_name: 'Write', tool_input: input },
    stateDir: f.stateDir, request: async () => { throw new Error('must not request'); } });
  assert.equal(cursor.permission, 'deny');
  assert.equal(JSON.stringify(cursor).includes(value), false);
});

test('unwritable state during concurrent capture and slow recall cannot create an unhandled rejection', async t => {
  const f = await fixture(t);
  const path = await transcript(f, 'unwritable');
  await writeFile(f.stateDir, 'a file cannot hold hook state');
  const script = `
    import {handleHook} from ${JSON.stringify(new URL('../runtime/hooks.mjs', import.meta.url).href)};
    process.on('unhandledRejection', () => { console.error('UNHANDLED_ACTION_REJECTION'); process.exit(3); });
    try {
      const result = await handleHook({host:'claude-code', stateDir:${JSON.stringify(f.stateDir)},
        payload:${JSON.stringify(claudePayload(f, 'UserPromptSubmit', { prompt: 'Explain parser', transcript_path: path }))},
        request: async route => { await new Promise(resolve=>setTimeout(resolve,100)); return route==='/search'?{recall:'real fixture context'}:{}; }});
      console.log(JSON.stringify(result));
    } catch { console.log('outer failure caught'); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 100_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stderr.includes('UNHANDLED_ACTION_REJECTION'));
  assert.match(result.stderr, /could not save local hook status/);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'real fixture context');
});

test('Codex model boundaries record only bounded host metadata and inject no prompt or control output', async t => {
  const f = await fixture(t);
  const spy = requestSpy();
  const payload = { hook_event_name: 'PreModelRequest', session_id: 'model-fixture', cwd: f.root,
    transcript_path: null, model: 'fixture-model', turn_id: 'fixture-turn' };
  assert.equal(await handleHook({ host: 'codex', stateDir: f.stateDir, request: spy.request, payload }), null);
  assert.equal(await handleHook({ host: 'codex', stateDir: f.stateDir, request: spy.request,
    payload: { ...payload, hook_event_name: 'PostModelRequest', status: 'completed', error: null,
      token_usage: { input_tokens: 123, output_tokens: 45, hidden_field: 'must not persist' } } }), null);
  assert.equal(spy.calls.length, 0);
  const files = await readdir(join(f.stateDir, 'model'));
  assert.equal(files.length, 1);
  const record = JSON.parse(await readFile(join(f.stateDir, 'model', files[0]), 'utf8'));
  assert.deepEqual(record.usage, { input_tokens: 123, output_tokens: 45 });
  assert.equal(record.event, 'PostModelRequest');
  assert(!JSON.stringify(record).includes('hidden_field'));
});

test('assembled prompt hook redacts pasted credentials before recall while preserving ordinary query and native context JSON', async t => {
  const f = await fixture(t);
  const spy = requestSpy();
  const syntheticToken = `ghp_${'x'.repeat(25)}`;
  const output = await handleHook({ host: 'claude-code', stateDir: f.stateDir, request: spy.request,
    payload: claudePayload(f, 'UserPromptSubmit', { prompt: `Explain the existing parser; pasted token ${syntheticToken}` }) });
  const search = spy.calls.find(call => call.route === '/search');
  assert.ok(search, 'the recall request must actually run');
  assert.ok(search.body.query.includes('Explain the existing parser'));
  assert.equal(search.body.query.includes(syntheticToken), false);
  assert.equal(search.body.timeline_session, 'claude-code-claude-fixture');
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'verified fixture recall' } });
  assert.equal(typeof JSON.parse(JSON.stringify(output)), 'object', 'native context must not be double encoded');
});

test('assembled Codex prompt uses the native schema and failure context differs from a measured empty recall', async t => {
  const f = await fixture(t);
  const payload = { ...claudePayload(f, 'UserPromptSubmit'), session_id: 'codex-fixture',
    model: 'fixture-model', turn_id: 'fixture-turn', permission_mode: 'default', prompt: 'Explain the parser' };
  const empty = await handleHook({ host: 'codex', payload, stateDir: f.stateDir,
    request: async route => route === '/search' ? { recall: '' } : {} });
  assert.equal(empty, null, 'a successful empty recall adds no model context');
  const failure = await handleHook({ host: 'codex', payload, stateDir: f.stateDir,
    request: async () => { const error = new Error('fixture offline'); error.status = 503; throw error; } });
  assert.match(failure.hookSpecificOutput.additionalContext, /not obtained \(http_503\)/);
  assert.doesNotMatch(failure.hookSpecificOutput.additionalContext, /found no relevant recall/);
  const status = JSON.parse(await readFile(join(f.stateDir, 'status', 'codex-context.json'), 'utf8'));
  assert.deepEqual({ status: status.status, code: status.code }, { status: 'failed', code: 'http_503' });
});

test('Kimi native prompt and verified legacy stream share exactly one timeline identity and return one JSON object', async t => {
  const f = await fixture(t);
  const kimiHome = join(f.directory, 'kimi-home');
  const sessionDir = join(kimiHome, 'sessions', 'fixture');
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(kimiHome, 'session_index.jsonl'), JSON.stringify({ sessionId: 'kimi-fixture', workDir: f.root, sessionDir }) + '\n');
  await writeFile(join(agentDir, 'wire.jsonl'), JSON.stringify({ type: 'context.append_message', time: Date.parse(AT),
    message: { role: 'user', content: [{ type: 'text', text: 'Explain existing parser' }] } }) + '\n');
  const prior = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = kimiHome;
  t.after(() => { if (prior === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prior; });
  const spy = requestSpy();
  const output = await handleHook({ host: 'kimi', stateDir: f.stateDir, request: spy.request,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: 'kimi-fixture', cwd: f.root,
      client_type: 'kimi_code_cli', prompt: [{ type: 'text', text: 'Explain existing parser' }] } });
  const recall = spy.calls.find(call => call.route === '/search');
  const streamed = spy.calls.find(call => call.route === '/session/events');
  assert.ok(recall && streamed, 'both actual recall and actual transcript stream must run');
  assert.equal(recall.body.timeline_session, streamed.body.session_id);
  assert.equal(streamed.body.session_id, timelineIdentity('kimi', 'kimi-fixture'));
  assert.ok(streamed.body.events.some(event => event.kind === 'customer_message'));
  assert.deepEqual(output, { message: 'verified fixture recall' });
  assert.deepEqual(JSON.parse(JSON.stringify(output)), { message: 'verified fixture recall' });
});

test('Grok prompt recall remains pending until its supported PreToolUse boundary emits native context once', async t => {
  const f = await fixture(t);
  const spy = requestSpy();
  const payload = { hookEventName: 'user_prompt_submit', sessionId: 'grok-fixture', cwd: f.root, promptId: 'grok-turn',
    prompt: 'Explain existing parser' };
  const queued = await handleHook({ host: 'grok', stateDir: f.stateDir, request: spy.request, payload });
  assert.equal(queued, null, 'Grok prompt hooks cannot inject model context');
  assert.equal(spy.calls.find(call => call.route === '/search')?.body.query, 'Explain existing parser');
  const statusFile = join(f.stateDir, 'status', 'grok-context.json');
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).status, 'pending');
  const tool = { ...payload, hookEventName: 'pre_tool_use', toolName: 'Read', toolInput: { path: 'a.ts' }, toolUseId: 'grok-tool' };
  const emitted = await handleHook({ host: 'grok', stateDir: f.stateDir, request: spy.request, payload: tool });
  assert.deepEqual(emitted, { hookSpecificOutput: { additionalContext: 'verified fixture recall' } });
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).status, 'emitted');
  assert.equal(await handleHook({ host: 'grok', stateDir: f.stateDir, request: spy.request, payload: tool }), null);
  assert.equal(spy.calls.filter(call => call.route === '/search').length, 1, 'tool-boundary emission reuses existing recall');
});

test('parallel Grok tool hooks claim queued context once rather than injecting duplicate recall', async t => {
  const f = await fixture(t);
  const spy = requestSpy();
  const payload = { hookEventName: 'user_prompt_submit', sessionId: 'grok-parallel', cwd: f.root, promptId: 'parallel-turn',
    prompt: 'Explain existing parser' };
  await handleHook({ host: 'grok', stateDir: f.stateDir, request: spy.request, payload });
  const outputs = await Promise.all(Array.from({ length: 8 }, (_, index) => handleHook({
    host: 'grok', stateDir: f.stateDir, request: spy.request,
    payload: { ...payload, hookEventName: 'pre_tool_use', toolName: 'Read', toolInput: { path: 'a.ts' }, toolUseId: `parallel-${index}` },
  })));
  assert.equal(outputs.filter(Boolean).length, 1, 'one queued recall must have one atomic tool-hook consumer');
  assert.equal(outputs.find(Boolean).hookSpecificOutput.additionalContext, 'verified fixture recall');
});

test('a failed new Grok prompt cannot emit stale unconsumed recall from the preceding prompt', async t => {
  const f = await fixture(t);
  const payload = { hookEventName: 'user_prompt_submit', sessionId: 'grok-new-prompt', cwd: f.root, promptId: 'old-turn',
    prompt: 'Inspect old task' };
  await handleHook({ host: 'grok', stateDir: f.stateDir,
    request: async () => ({ recall: 'old task recall must expire' }), payload });
  await handleHook({ host: 'grok', stateDir: f.stateDir, payload: { ...payload, promptId: 'new-turn', prompt: 'Inspect new task' },
    request: async () => { const error = new Error('fixture offline'); error.status = 503; throw error; } });
  const output = await handleHook({ host: 'grok', stateDir: f.stateDir, request: async () => ({}),
    payload: { ...payload, promptId: 'new-turn', hookEventName: 'pre_tool_use', toolName: 'Read', toolInput: { path: 'a.ts' }, toolUseId: 'after-failure' } });
  assert.equal(JSON.stringify(output).includes('old task recall must expire'), false,
    'a new failed recall cannot fall back to an older prompt’s pending context');
});

test('assembled reindex enqueues successful writes but neither reads nor failed writes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'a.ts'), 'export const changed = true;\n');
  const spy = requestSpy();
  const payload = claudePayload(f, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: {} });
  await handleHook({ host: 'claude-code', stateDir: f.stateDir, request: spy.request, payload });
  await assert.rejects(readdir(join(f.stateDir, 'reindex')), { code: 'ENOENT' });
  await handleHook({ host: 'claude-code', stateDir: f.stateDir, request: spy.request,
    payload: { ...payload, tool_name: 'Write', tool_response: { is_error: true } } });
  await assert.rejects(readdir(join(f.stateDir, 'reindex')), { code: 'ENOENT' });
  await handleHook({ host: 'claude-code', stateDir: f.stateDir, request: spy.request,
    payload: { ...payload, tool_name: 'Write', tool_response: { success: true } } });
  const files = await readdir(join(f.stateDir, 'reindex'));
  const records = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name =>
    JSON.parse(await readFile(join(f.stateDir, 'reindex', name), 'utf8'))));
  const pending = records.find(record => record.pending);
  assert.ok(pending, 'a successful Write must reach the real reindex queue');
  assert.deepEqual(Object.keys(pending.pending), ['a.ts']);
  assert.equal(spy.calls.some(call => call.route === '/reindex'), false, 'write capture is debounced rather than uploaded immediately');
});

test('SessionEnd queues only a durable reference without network, Git access, or transcript reads', async t => {
  const f = await fixture(t);
  let requests = 0;
  const output = await handleHook({ host: 'claude-code', stateDir: f.stateDir,
    payload: { session_id: 'exit-fixture', hook_event_name: 'SessionEnd', cwd: '/nonexistent/fixture',
      transcript_path: '/nonexistent/fixture/transcript.jsonl', prompt: 'must not be stored' },
    request: async () => { requests++; throw new Error('must not run'); } });
  assert.equal(output, null);
  assert.equal(requests, 0);
  const files = await readdir(join(f.stateDir, 'deferred'));
  assert.equal(files.length, 1);
  const raw = await readFile(join(f.stateDir, 'deferred', files[0]), 'utf8');
  assert.equal(raw.includes('must not be stored'), false);
  const queued = JSON.parse(raw);
  assert.equal(queued.payload.session_id, 'exit-fixture');
  assert.equal(queued.payload.transcript_path, '/nonexistent/fixture/transcript.jsonl');
});

async function deferred(f, name, sessionId, path) {
  await mkdir(join(f.stateDir, 'deferred'), { recursive: true });
  await writeFile(join(f.stateDir, 'deferred', name), JSON.stringify({ host: 'claude-code', queuedAt: AT,
    payload: { session_id: sessionId, cwd: f.root, transcript_path: path, hook_event_name: 'SessionEnd' } }));
}

test('missing deferred transcript is retained for diagnosis without starving a later valid session', async t => {
  const f = await fixture(t);
  const unavailableName = `${'0'.repeat(64)}.json`, validName = `${'1'.repeat(64)}.json`;
  await deferred(f, unavailableName, 'missing-fixture', null);
  await deferred(f, validName, 'valid-fixture', await transcript(f, 'valid'));
  const spy = requestSpy();
  await drainOne(f.stateDir, spy.request);
  assert.deepEqual(await readdir(join(f.stateDir, 'unavailable')), [unavailableName]);
  assert.equal(spy.calls.find(call => call.route === '/checkpoint')?.body.session_id, 'valid-fixture');
  assert.ok(spy.calls.some(call => call.route === '/session/events' && call.body.session_id === 'claude-code-valid-fixture'));
  assert.deepEqual(await readdir(join(f.stateDir, 'deferred')), []);
});

test('round-robin replay lets a small session finish while an older large session still has transcript backlog', async t => {
  const f = await fixture(t);
  const largeName = `${'0'.repeat(64)}.json`, smallName = `${'1'.repeat(64)}.json`;
  await deferred(f, largeName, 'large-fixture', await transcript(f, 'large', 250));
  await deferred(f, smallName, 'small-fixture', await transcript(f, 'small'));
  const spy = requestSpy();
  await drainOne(f.stateDir, spy.request);
  assert.ok((await readdir(join(f.stateDir, 'deferred'))).includes(largeName), 'first session must still have a real backlog');
  assert.equal(spy.calls.filter(call => call.route === '/checkpoint').at(-1).body.session_id, 'large-fixture');
  await drainOne(f.stateDir, spy.request);
  assert.equal(spy.calls.filter(call => call.route === '/checkpoint').at(-1).body.session_id, 'small-fixture');
  assert.deepEqual(await readdir(join(f.stateDir, 'deferred')), [largeName]);
});

test('Grok tool hook streams its transcript dialect and SessionEnd drains into checkpoint and events', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'grok-transcript.jsonl');
  await writeFile(path, JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Explain the parser' }] }) + '\n');
  const spy = requestSpy();
  await handleHook({ host: 'grok', stateDir: f.stateDir, request: spy.request,
    payload: { hookEventName: 'post_tool_use', sessionId: 'grok-stream', cwd: f.root, transcriptPath: path,
      promptId: 'grok-turn', toolName: 'Read', toolInput: { path: 'a.ts' }, toolUseId: 'grok-tool' } });
  const streamed = spy.calls.find(call => call.route === '/session/events');
  assert.ok(streamed, 'grok PostToolUse must stream its transcript');
  assert.equal(streamed.body.session_id, 'grok-grok-stream');
  assert.ok(streamed.body.events.some(event => event.kind === 'customer_message'));
  const ended = await handleHook({ host: 'grok', stateDir: f.stateDir, request: async () => { throw new Error('must not run at exit'); },
    payload: { hookEventName: 'session_end', sessionId: 'grok-stream', cwd: f.root, transcriptPath: path } });
  assert.equal(ended, null);
  await drainOne(f.stateDir, spy.request);
  const saved = spy.calls.find(call => call.route === '/checkpoint');
  assert.equal(saved.body.session_id, 'grok-stream');
  assert.equal(saved.body.client.name, 'grok');
  assert.equal(saved.body.client.format_verified, false);
  assert.match(saved.body.messages[0].content, /Explain the parser/);
});

test('all five prompt hooks keep successful empty recall silent and retain useful context', async t => {
  const f = await fixture(t);
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = join(f.directory, 'empty-kimi-home');
  t.after(() => { if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome; });
  const cases = [
    ['claude-code', claudePayload(f, 'UserPromptSubmit', { prompt: 'Explain parser' }), null],
    ['codex', { ...claudePayload(f, 'UserPromptSubmit'), model: 'fixture', turn_id: 'turn',
      permission_mode: 'default', prompt: 'Explain parser' }, null],
    ['kimi', { hook_event_name: 'UserPromptSubmit', session_id: 'quiet-kimi', cwd: f.root, prompt: 'Explain parser' }, null],
    ['grok', { hookEventName: 'user_prompt_submit', sessionId: 'quiet-grok', cwd: f.root, promptId: 'turn', prompt: 'Explain parser' }, null],
    ['cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'quiet-cursor', generation_id: 'turn',
      workspace_roots: [f.root], prompt: 'Explain parser' }, { continue: true }],
  ];
  for (const [host, payload, nativeDefault] of cases) {
    const calls = [];
    const request = async (route, body) => { calls.push({ route, body }); return route === '/search' ? { recall: '', degraded: false, chunk_push_skipped: true } : {}; };
    const result = await handleHook({ host, payload, stateDir: f.stateDir, request });
    assert.deepEqual(result, nativeDefault, `${host}: empty recall must not add model context`);
    const search = calls.find(call => call.route === '/search');
    assert.ok(search, `${host}: silence must follow a real search`);
    assert.equal(search.body.code, false, `${host}: automatic recall must not request code context`);
    const row = JSON.parse(await readFile(join(f.stateDir, 'status', `${host}-context.json`), 'utf8'));
    assert.equal(row.status, 'ok', `${host}: an empty success is not a failure`);
    const positive = await handleHook({ host, payload, stateDir: f.stateDir,
      request: async route => route === '/search' ? { recall: 'useful remembered decision' } : {} });
    if (['grok', 'cursor'].includes(host)) {
      const tool = host === 'grok' ? { ...payload, hookEventName: 'pre_tool_use', toolName: 'Read', toolInput: {} }
        : { ...payload, hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: {}, tool_output: '{}' };
      const emitted = await handleHook({ host, payload: tool, stateDir: f.stateDir, request });
      assert.match(JSON.stringify(emitted), /useful remembered decision/, `${host}: useful recall must reach its supported boundary`);
    } else assert.match(JSON.stringify(positive), /useful remembered decision/, `${host}: useful recall must still be delivered`);
  }
});

test('startup context does not report an authenticated MCP connection without testing it', async t => {
  const f = await fixture(t);
  const result = await handleHook({ host: 'claude-code', payload: claudePayload(f, 'SessionStart'),
    stateDir: f.stateDir, request: async () => ({}) });
  assert.match(result.hookSpecificOutput.additionalContext, /estelle_resume/);
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /is connected/);
});

test('all five hosts distinguish degraded empty recall from a healthy empty result without losing rules', async t => {
  const f = await fixture(t);
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = join(f.directory, 'empty-kimi-home');
  t.after(() => { if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome; });
  const cases = [
    ['claude-code', claudePayload(f, 'UserPromptSubmit', { prompt: 'Explain parser' })],
    ['codex', { ...claudePayload(f, 'UserPromptSubmit'), model: 'fixture', turn_id: 'turn', permission_mode: 'default', prompt: 'Explain parser' }],
    ['kimi', { hook_event_name: 'UserPromptSubmit', session_id: 'degraded-kimi', cwd: f.root, prompt: 'Explain parser' }],
    ['grok', { hookEventName: 'user_prompt_submit', sessionId: 'degraded-grok', cwd: f.root, promptId: 'turn', prompt: 'Explain parser' }],
    ['cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'degraded-cursor', generation_id: 'turn', workspace_roots: [f.root], prompt: 'Explain parser' }],
  ];
  for (const [host, payload] of cases) await t.test(host, async () => {
    const queued = ['grok', 'cursor'].includes(host);
    const tool = host === 'grok' ? { ...payload, hookEventName: 'pre_tool_use', toolName: 'Read', toolInput: {} }
      : { ...payload, hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: {}, tool_output: '{}' };
    const run = (input, recall) => handleHook({ host, payload: input, stateDir: f.stateDir,
      request: async route => route === '/search' ? { recall, degraded: true, chunk_push_skipped: true } : {} });
    const promptOutput = await run(payload, '');
    if (queued) {
      assert.deepEqual(promptOutput, host === 'cursor' ? { continue: true } : null);
      const pending = JSON.parse(await readFile(join(f.stateDir, 'status', `${host}-context.json`), 'utf8'));
      assert.equal(pending.status, 'partial', `${host}: pending delivery must not hide failed retrieval`);
      assert.equal(pending.pending, true);
    }
    const output = queued ? await run(tool, '') : promptOutput;
    assert.match(JSON.stringify(output), /recall.*unavailable/i, `${host}: degraded empty response must deliver an actionable notice`);
    assert.match(JSON.stringify(output), /estelle_resume|memory_chat/, `${host}: notice must name a recovery action`);
    const row = JSON.parse(await readFile(join(f.stateDir, 'status', `${host}-context.json`), 'utf8'));
    assert.deepEqual({ status: row.status, code: row.code }, { status: 'partial', code: 'recall_degraded' });
    const rules = 'Repository rule: use the recorded project test command.';
    const rulesPrompt = await run(payload, rules);
    const rulesOutput = queued ? await run(tool, '') : rulesPrompt;
    const text = host === 'cursor' ? rulesOutput.additional_context : host === 'kimi' ? rulesOutput.message
      : rulesOutput.hookSpecificOutput.additionalContext;
    assert.equal(text, rules, `${host}: returned context and rules must remain unchanged even when degraded`);
  });
});
