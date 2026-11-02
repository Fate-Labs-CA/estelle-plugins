import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, appendFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamSession, mapClaude, mapCodex, mapKimi, mapCursor, mapGrok, safeSession, LIMITS } from '../runtime/stream.mjs';
import { handleHook } from '../runtime/hooks.mjs';

const AT = '2026-10-30T12:00:00.000Z';
const claude = (uuid, type, content) => ({ uuid, timestamp: AT, type, message: { content } });
const rollout = payload => ({ timestamp: AT, type: 'response_item', payload });
const line = value => `${JSON.stringify(value)}\n`;

async function fixture(t, host = 'claude') {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-stream-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcript = join(dir, 'fixture.jsonl');
  await writeFile(transcript, '');
  const calls = [];
  const options = { host, repo: 'fixture/repository', stateDir: join(dir, 'state'),
    payload: { session_id: 'fixture-session', transcript_path: transcript, hook_event_name: 'PostToolUse' },
    request: async (path, body) => { calls.push({ path, body }); return { accepted: body.events.length }; } };
  return { dir, transcript, calls, options, state: join(options.stateDir, `${host === 'claude' ? 'claude-code' : host}-fixture-session.stream.json`) };
}

test('Claude fixture maps actual messages, tools, edits, usage and ignores harness messages', () => {
  const notes = {};
  const user = mapClaude(claude('u1', 'user', 'Please fix this'), 0, notes);
  assert.equal(user[0].kind, 'customer_message');
  assert.equal(user[0].event_id, 'u1:0');
  assert.equal(user[1].payload.reason, 'input_received');
  assert.equal(notes.title, 'Please fix this');
  assert.deepEqual(mapClaude(claude('injected', 'user', '<system-reminder>instruction'), 0), []);
  const entry = claude('a1', 'assistant', [{ type: 'text', text: 'Working' }, { type: 'tool_use', id: 'call1', name: 'Write', input: { file_path: 'test.py', content: 'hello' } }]);
  entry.message.usage = { input_tokens: 10, output_tokens: 3 };
  const out = mapClaude(entry, 0);
  assert.equal(out[0].payload.usage.input, 10);
  assert.equal(out[1].kind, 'edit');
  assert.equal(out[1].payload.diff, '+hello');
  assert.equal(out[1].payload.call_id, 'call1');
});

test('Codex fixture uses rollout offsets, skips duplicate event messages and encrypted reasoning', () => {
  const out = mapCodex(rollout({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }), 123);
  assert.equal(out[0].event_id, 'r123:0');
  assert.equal(out[0].kind, 'customer_message');
  assert.deepEqual(mapCodex({ timestamp: AT, type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }, 999), []);
  assert.deepEqual(mapCodex(rollout({ type: 'reasoning', encrypted_content: 'not-public' }), 999), []);
  assert.deepEqual(mapCodex(rollout({ type: 'message', role: 'developer', content: 'internal' }), 999), []);
  const result = mapCodex(rollout({ type: 'function_call_output', call_id: 'x', output: 'exit code zero' }), 234);
  assert.equal(result[0].payload.ok, null);
  assert.equal(result[0].payload.call_id, 'x');
});

test('successful stream ACK advances durable cursor on every OS; second run sends no duplicates', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('u', 'user', 'hello')) + line(claude('a', 'assistant', 'done')));
  const result = await streamSession(f.options);
  assert.equal(result.sent, 4);
  assert.equal(result.session_id, 'claude-code-fixture-session');
  assert.equal(f.calls[0].path, '/session/events');
  assert.equal(f.calls[0].body.events[0].payload.repo, 'fixture/repository');
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, (await stat(f.transcript)).size);
  assert.equal((await streamSession(f.options)).sent, 0);
});

test('POSIX durable stream cursor is readable and writable only by its owner', {
  skip: process.platform === 'win32' && 'POSIX mode bits do not measure Windows ACL protection; Windows ACLs remain unverified',
}, async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('u', 'user', 'hello')));
  const result = await streamSession(f.options);
  assert.equal(result.sent, 3);
  assert.equal((await stat(f.state)).mode & 0o777, 0o600);
});

test('failed upload retains cursor and spools redacted batch; another session drains it', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('u', 'user', 'fixture estelle_live_abcdefgh1234')));
  f.options.request = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
  const result = await streamSession(f.options);
  assert.equal(result.pending, true);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, 0);
  const spoolDir = join(f.options.stateDir, 'spool');
  const files = await readdir(spoolDir);
  assert.equal(files.length, 1);
  const spooled = await readFile(join(spoolDir, files[0]), 'utf8');
  assert.ok(!spooled.includes('estelle_live_abcdefgh1234'));
  assert.match(spooled, /redacted estelle key/);
  await rm(f.transcript);
  f.options.payload = { session_id: 'other-session' };
  f.options.request = async (path, body) => f.calls.push({ path, body });
  const drained = await streamSession(f.options);
  assert.equal(drained.replayed, 3);
  assert.equal((await readdir(spoolDir)).length, 0);
  assert.equal(f.calls[0].body.session_id, 'claude-code-fixture-session');
});

test('half-written last line is retained until newline arrives', async t => {
  const f = await fixture(t);
  const first = line(claude('u', 'user', 'hello'));
  const second = JSON.stringify(claude('a', 'assistant', 'done'));
  await writeFile(f.transcript, first + second);
  const result = await streamSession(f.options);
  assert.equal(result.offset, Buffer.byteLength(first));
  assert.equal(result.incomplete, true);
  await appendFile(f.transcript, '\n');
  const next = await streamSession(f.options);
  assert.equal(next.sent, 1);
  assert.equal(f.calls.at(-1).body.events[0].payload.text, 'done');
});

test('known poison event is isolated while other 400 refusals do not advance cursor', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('u', 'user', 'hello')));
  let attempts = 0;
  f.options.request = async (path, body) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('event 1: invalid fixture'), { status: 400 });
    f.calls.push({ path, body });
  };
  const result = await streamSession(f.options);
  assert.equal(result.dropped, 1);
  assert.equal(result.sent, 2);
  assert.equal(f.calls[0].body.events.some(e => e.event_id === 'u:0'), false);
  await appendFile(f.transcript, line(claude('a', 'assistant', 'next')));
  const oldOffset = JSON.parse(await readFile(f.state, 'utf8')).offset;
  f.options.request = async () => { throw Object.assign(new Error('invalid entire request'), { status: 400 }); };
  assert.equal((await streamSession(f.options)).pending, true);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, oldOffset);
});

test('wire batches have an event bound and do not report finished ahead of backlog', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, Array.from({ length: 400 }, (_, i) => line(claude(`u${i}`, 'assistant', `message${i}`))).join(''));
  f.options.payload.hook_event_name = 'Stop';
  const result = await streamSession(f.options);
  assert.equal(result.incomplete, true);
  assert.ok(f.calls.every(call => call.body.events.length <= LIMITS.batchEvents));
  assert.ok(f.calls.flatMap(call => call.body.events).every(e => e.payload.reason !== 'input_required'));
  assert.equal((await streamSession(f.options)).incomplete, false);
});

test('invalid session identities fail before networking and unverified dialect is explicit', async t => {
  const f = await fixture(t);
  assert.equal(safeSession('../escape'), false);
  assert.equal(safeSession('valid_123-id'), true);
  f.options.payload.session_id = '../escape';
  await assert.rejects(streamSession(f.options), /invalid host session identity/);
  assert.equal(f.calls.length, 0);
  const result = await streamSession({ ...f.options, host: 'unverified-host' });
  assert.equal(result.unsupported, true);
});

test('Kimi legacy and current wire use recorded timestamps and IDs while unknown journal types remain unsupported', () => {
  const user = mapKimi({ type: 'context.append_message', time: Date.parse(AT), message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] } }, 12);
  assert.equal(user[0].event_id, 'r12:0');
  assert.equal(user[0].kind, 'customer_message');
  assert.equal(user[0].at, AT);
  const assistant = mapKimi({ type: 'context.append_message', time: Date.parse(AT), message: { role: 'assistant', content: [{ type: 'text', text: 'Working' }],
    toolCalls: [{ type: 'function', id: 'call1', name: 'Read', arguments: '{"path":"file.txt"}' }] } }, 24);
  assert.equal(assistant[1].kind, 'tool_call');
  assert.equal(assistant[1].payload.call_id, 'call1');
  assert.equal(assistant[1].author.id, 'kimi-code');
  assert.deepEqual(assistant[1].payload.input, { path: 'file.txt' });
  const current = mapKimi({ type: 'agent.message.appended', time: Date.parse(AT), message: { message: { role: 'user', content: [{ type: 'text', text: 'current format' }] } } }, 48);
  assert.equal(current[0].kind, 'customer_message');
  assert.equal(current[0].payload.text, 'current format');
  assert.deepEqual(mapKimi({ type: 'agent.future_message.appended', time: Date.parse(AT), message: { message: { role: 'user', content: [{ type: 'text', text: 'unverified future format' }] } } }, 48), []);
  assert.deepEqual(mapKimi({ type: 'context.append_message', time: 1e300 }, 50), []);
  assert.deepEqual(mapClaude(claude('invalid-blocks', 'assistant', [null, 'invalid']), 0), []);
});

test('corrupt state refuses to masquerade as a successful empty stream', async t => {
  const f = await fixture(t);
  await streamSession({ ...f.options, payload: { session_id: 'fixture-session' } });
  await writeFile(f.state, '{broken json');
  await assert.rejects(streamSession(f.options), /stream state is unreadable or invalid/);
  assert.equal(f.calls.length, 0);
});

test('Stop reports turn completion even if preceding tool hook already streamed its last reply', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('u', 'user', 'hello')) + line(claude('a', 'assistant', 'done')));
  await streamSession(f.options);
  f.options.payload.hook_event_name = 'Stop';
  const stopped = await streamSession(f.options);
  assert.equal(stopped.sent, 1);
  assert.equal(f.calls.at(-1).body.events[0].payload.reason, 'input_required');
  assert.equal(f.calls.at(-1).body.events[0].at, AT);
  assert.equal((await streamSession(f.options)).sent, 0);
  f.options.payload.hook_event_name = 'UserPromptSubmit';
  assert.equal((await streamSession(f.options)).sent, 1);
  assert.equal(f.calls.at(-1).body.events[0].payload.reason, 'input_received');
});

test('an oversized complete line is counted and skipped; an oversized partial line retains cursor', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, 'x'.repeat(LIMITS.readBytes + 20) + '\n' + line(claude('u', 'user', 'next')));
  const first = await streamSession(f.options);
  assert.equal(first.skipped_lines, 1);
  assert.equal(first.incomplete, true);
  const second = await streamSession(f.options);
  assert.equal(second.sent, 3);
  assert.equal(f.calls[0].body.events[1].payload.text, 'next');
  await writeFile(f.transcript, 'x'.repeat(LIMITS.readBytes + 20));
  await rm(f.state);
  const partial = await streamSession(f.options);
  assert.match(partial.reason, /cursor retained/);
  assert.equal(partial.sent, 0);
});

test('a transcript entry exceeding block bound is refused explicitly before cursor movement', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, line(claude('a', 'assistant', Array.from({ length: LIMITS.messageBlocks + 1 }, () => ({ type: 'text', text: 'block' })))));
  await assert.rejects(streamSession(f.options), /message exceeds block bound; cursor retained/);
  assert.equal(f.calls.length, 0);
});

test('Cursor dialect maps role and control lines and refuses records without any timestamp source', () => {
  const notes = { observedAt: AT };
  const user = mapCursor({ role: 'user', message: { content: [{ type: 'text', text: 'Fix the parser' }] } }, 0, notes);
  assert.equal(user[0].kind, 'customer_message');
  assert.equal(user[0].event_id, 'c0:0');
  assert.equal(user[0].at, AT);
  assert.equal(notes.title, 'Fix the parser');
  const assistant = mapCursor({ role: 'assistant', message: { content: [
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 't1', name: 'Write', input: { path: 'a.ts', contents: 'one\ntwo' } },
  ] } }, 10, notes);
  assert.equal(assistant[1].kind, 'edit');
  assert.equal(assistant[1].author.id, 'cursor');
  assert.equal(assistant[1].payload.path, 'a.ts');
  assert.equal(assistant[1].payload.diff, '+one\n+two');
  const shell = mapCursor({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }] } }, 20, notes);
  assert.equal(shell[0].kind, 'tool_call');
  assert.equal(shell[0].payload.summary, 'Ran npm test');
  const ended = mapCursor({ type: 'turn_ended', status: 'success' }, 30, notes);
  assert.equal(ended[0].kind, 'lifecycle');
  assert.equal(ended[0].payload.reason, 'input_required');
  assert.deepEqual(mapCursor({ type: 'turn_ended' }, 40), []);
  assert.deepEqual(mapCursor({ role: 'system', message: { content: 'hidden' } }, 50, notes), []);
  assert.deepEqual(mapCursor({ irrelevant: true }, 60, notes), []);
  assert.deepEqual(mapCursor(null, 70, notes), []);
});

test('Grok dialect reads ACP update and chat-history lines, skipping unrecognized records', () => {
  const notes = { observedAt: AT };
  const chunk = mapGrok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix it' } }, 0, notes);
  assert.equal(chunk[0].kind, 'customer_message');
  assert.equal(chunk[0].event_id, 'g0');
  assert.equal(notes.title, 'Fix it');
  assert.deepEqual(mapGrok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<system-reminder>fake' } }, 4, notes), []);
  const enveloped = mapGrok({ jsonrpc: '2.0', method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } }, 8, notes);
  assert.equal(enveloped[0].kind, 'agent_message');
  assert.equal(enveloped[0].author.id, 'grok');
  const thought = mapGrok({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking aloud' } }, 16, notes);
  assert.equal(thought[0].kind, 'thinking');
  const call = mapGrok({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', rawInput: { path: 'a.ts' } }, 24, notes);
  assert.equal(call[0].kind, 'tool_call');
  assert.equal(call[0].payload.call_id, 'call-1');
  const done = mapGrok({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file text' } }] }, 32, notes);
  assert.equal(done[0].kind, 'tool_result');
  assert.equal(done[0].payload.ok, true);
  assert.equal(done[0].payload.output, 'file text');
  const history = mapGrok({ role: 'assistant', content: 'Working',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] }, 40, notes);
  assert.equal(history[0].kind, 'agent_message');
  assert.equal(history[1].kind, 'tool_call');
  assert.deepEqual(history[1].payload.input, { path: 'a.ts' });
  const toolResult = mapGrok({ role: 'tool', tool_call_id: 'c1', content: 'file text' }, 48, notes);
  assert.equal(toolResult[0].kind, 'tool_result');
  assert.equal(toolResult[0].payload.call_id, 'c1');
  assert.deepEqual(mapGrok({ role: 'system', content: 'prompt' }, 56, notes), []);
  assert.deepEqual(mapGrok({ sessionUpdate: 'plan', entries: [] }, 64, notes), []);
  assert.deepEqual(mapGrok({ role: 'user', content: 'no time anywhere' }, 72), []);
});

test('Cursor stream sends conversation with capture-time stamps, survives malformed lines, and does not repeat', async t => {
  const f = await fixture(t, 'cursor');
  await writeFile(f.transcript, [
    '{"role":"user","message":{"content":[{"type":"text","text":"hello cursor"}]}}',
    '{malformed json',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"type":"turn_ended","status":"success"}',
  ].join('\n') + '\n');
  const result = await streamSession(f.options);
  assert.equal(result.session_id, 'cursor-fixture-session');
  assert.equal(result.transcript_format, 'cursor-jsonl-inferred');
  assert.equal(result.current_format_verified, false);
  assert.equal(result.event_times, 'capture-time');
  assert.equal(result.invalid_lines, 1);
  const events = f.calls[0].body.events;
  assert.ok(events.some(item => item.kind === 'customer_message' && item.payload.text === 'hello cursor'));
  assert.ok(events.some(item => item.kind === 'agent_message'));
  assert.ok(events.some(item => item.payload.reason === 'input_required'));
  assert.ok(events.every(item => Number.isFinite(Date.parse(item.at))));
  assert.equal((await streamSession(f.options)).sent, 0);
});

test('Grok stream reads the ACP update dialect over a stateful cursor', async t => {
  const f = await fixture(t, 'grok');
  await writeFile(f.transcript, [
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello grok' } } } }),
    '{malformed json',
    JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } }),
  ].join('\n') + '\n');
  const result = await streamSession(f.options);
  assert.equal(result.session_id, 'grok-fixture-session');
  assert.equal(result.transcript_format, 'grok-jsonl-inferred');
  assert.equal(result.invalid_lines, 1);
  const events = f.calls.flatMap(call => call.body.events);
  assert.ok(events.some(item => item.kind === 'customer_message' && item.payload.text === 'hello grok'));
  assert.ok(events.some(item => item.kind === 'agent_message' && item.payload.text === 'working'));
  assert.equal((await streamSession(f.options)).sent, 0);
});

test('an empty inferred-dialect transcript sends nothing and a missing file fails without sending', async t => {
  const f = await fixture(t, 'grok');
  const empty = await streamSession(f.options);
  assert.equal(empty.sent, 0);
  assert.equal(f.calls.length, 0);
  f.options.payload.transcript_path = join(f.dir, 'missing.jsonl');
  await assert.rejects(streamSession(f.options), /ENOENT/);
  assert.equal(f.calls.length, 0);
});


// Rollout schema: openai/codex rust-v0.166.0 protocol/src/items.rs + protocol.rs.
// These PascalCase/snake_case records are NOT the app-server v2 camelCase projection.
const completed = item => ({ timestamp: AT, type: 'event_msg', payload: { type: 'item_completed', item } });
const nativeCommand = extra => ({ type: 'CommandExecution', id: 'native-call', command: ['gh', 'pr', 'create'],
  cwd: 'file:///workspace', status: 'completed', exit_code: 0, aggregated_output: 'https://github.com/fixture/repository/pull/1', ...extra });

test('Codex native completion records typed command provenance without canonical work or output', () => {
  const [out] = mapCodex(completed(nativeCommand()), 120);
  assert.equal(out.event_id, 'r120:0');
  assert.equal(out.kind, 'artifact');
  assert.equal(out.payload.native_id, 'native-call');
  assert.deepEqual(out.payload.argv, ['gh', 'pr', 'create']);
  assert.equal(out.payload.cwd, 'file:///workspace');
  assert.equal(out.payload.status, 'completed');
  assert.equal(out.payload.exit_code, 0);
  assert.equal(out.payload.metadata_complete, true);
  assert.equal(out.payload.source, 'codex.event_msg.item_completed');
  assert.equal(out.payload.schema, 'codex-rust-v0.166.0');
  for (const forbidden of ['pr_url', 'output', 'aggregated_output', 'command', 'diff']) assert.ok(!Object.hasOwn(out.payload, forbidden));
  assert.equal(JSON.stringify(out).includes('github.com'), false);
});

test('Codex native completion preserves failure and unknown rather than inventing success', () => {
  const failed = mapCodex(completed(nativeCommand({ status: 'failed', exit_code: 7 })), 1)[0].payload;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exit_code, 7);
  assert.equal(failed.completion, 'failed');
  for (const exit_code of [null, undefined, false, '0', 0.5]) {
    const result = mapCodex(completed(nativeCommand({ exit_code })), 2)[0].payload;
    assert.equal(result.exit_code, null);
    assert.equal(result.completion, 'unknown');
  }
  assert.equal(mapCodex(completed(nativeCommand({ status: 'failed', exit_code: 0 })), 3)[0].payload.completion, 'inconsistent');
  assert.equal(mapCodex(completed(nativeCommand({ status: 'completed', exit_code: 7 })), 4)[0].payload.completion, 'inconsistent');
  assert.equal(mapCodex(completed(nativeCommand({ status: 'new-unknown-status' })), 5)[0].payload.status, null);
});

test('Codex native completion bounds malformed command metadata explicitly', () => {
  for (const extra of [{ id: '' }, { id: 'x'.repeat(201) }, { command: 'gh pr create' },
    { command: ['x'.repeat(20_001)] }, { command: Array(101).fill('x') }, { command: ['x', null] }, { cwd: [] }]) {
    const [out] = mapCodex(completed(nativeCommand(extra)), 20);
    assert.equal(out.kind, 'artifact');
    assert.equal(out.payload.metadata_complete, false);
    assert.ok(out.payload.unavailable_fields.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) < 200_000);
  }
});

test('Codex native completion retains only known FileChange metadata, never edit ownership or content', () => {
  const item = { type: 'FileChange', id: 'native-patch', status: 'completed', changes: {
    'src/add.js': { type: 'add', content: 'PRIVATE_ADDED_CONTENT' },
    'src/delete.js': { type: 'delete', content: 'PRIVATE_DELETED_CONTENT' },
    'src/update.js': { type: 'update', unified_diff: 'PRIVATE_DIFF', move_path: 'src/moved.js' },
  }, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', reasoning: 'PRIVATE_REASONING' };
  const [out] = mapCodex(completed(item), 100);
  assert.equal(out.kind, 'artifact');
  assert.equal(out.payload.native_id, 'native-patch');
  assert.equal(out.payload.metadata_complete, true);
  assert.deepEqual(out.payload.changes, [
    { path: 'src/add.js', change_type: 'add', move_path: null },
    { path: 'src/delete.js', change_type: 'delete', move_path: null },
    { path: 'src/update.js', change_type: 'update', move_path: 'src/moved.js' },
  ]);
  assert.ok(!JSON.stringify(out).includes('PRIVATE_'));
  assert.ok(!Object.hasOwn(out.payload, 'pr_url'));
});

test('Codex native completion refuses guessed FileChange shapes and oversized paths', () => {
  for (const changes of [[], null, { x: { type: 'unknown', content: 'x' } },
    { x: { type: 'add', content: false } }, { x: { type: 'update', unified_diff: 'x', move_path: false } },
    { ['x'.repeat(20_001)]: { type: 'delete', content: 'x' } },
    Object.fromEntries(Array.from({ length: 101 }, (_, n) => ['p'+n, { type: 'add', content: 'x' }]))]) {
    const [out] = mapCodex(completed({ type: 'FileChange', id: 'patch', status: 'completed', changes }), 1);
    assert.equal(out.payload.metadata_complete, false);
    assert.equal(out.payload.changes, null);
  }
});

test('Codex native completion never inspects private reasoning or replaces response-item fallback', () => {
  assert.deepEqual(mapCodex(completed({ type: 'Reasoning', encrypted_content: 'PRIVATE' }), 1), []);
  const call = mapCodex(rollout({ type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'native-call', arguments: '{"cmd":"gh pr create"}' }), 10);
  const native = mapCodex(completed(nativeCommand()), 20);
  const result = mapCodex(rollout({ type: 'function_call_output', call_id: 'native-call', output: 'fallback output' }), 30);
  assert.equal(call[0].kind, 'tool_call');
  assert.equal(result[0].kind, 'tool_result');
  assert.equal(result[0].payload.output, 'fallback output');
  assert.deepEqual([...call, ...native, ...result].map(x => x.event_id), ['r10:0', 'r20:0', 'r30:0']);
  assert.equal([...call, ...native, ...result].filter(x => ['command', 'edit'].includes(x.kind)).length, 0);
});

test('Codex native completion uses existing ACK cursor/spool and server replay identity without new state', async t => {
  const f = await fixture(t, 'codex');
  const records = [rollout({ type: 'function_call', name: 'exec_command', call_id: 'native-call', arguments: '{"cmd":"gh pr create"}' }),
    completed(nativeCommand()), rollout({ type: 'function_call_output', call_id: 'native-call', output: 'fallback output' })];
  await writeFile(f.transcript, records.map(line).join(''));
  const server = new Map();
  let requests = 0;
  f.options.request = async (path, body) => {
    requests++;
    for (const event of body.events) {
      const serialized = JSON.stringify(event);
      if (server.has(event.event_id)) assert.equal(server.get(event.event_id), serialized);
      else server.set(event.event_id, serialized);
    }
    if (requests === 1) throw Object.assign(new Error('fixture lost ACK after commit'), { status: 503 });
    return { accepted: body.events.length };
  };
  const pending = await streamSession(f.options);
  assert.equal(pending.pending, true);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, 0);
  const saved = await streamSession(f.options);
  assert.equal(saved.pending, undefined);
  assert.equal(server.size, 5); // original four events plus the separate target candidate
  assert.equal([...server.values()].map(JSON.parse).filter(e => e.payload.native_type === 'CommandExecution').length, 1);
  assert.equal(prCandidates([...server.values()].map(JSON.parse)).length, 1);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(state.offset, Buffer.byteLength(records.map(line).join('')));
  assert.ok(!Object.keys(state).some(key => /codex|correlat|tombstone/.test(key)));
  assert.equal((await streamSession(f.options)).sent, 0);
});


test('Codex native completion reuses existing credential filtering without storing hidden bodies', () => {
  const existingFixture = 'fixture estelle_live_abcdefgh1234'; // same non-authentic redaction fixture above
  const [command] = mapCodex(completed(nativeCommand({ command: ['echo', existingFixture], encrypted_content: 'DO_NOT_CAPTURE_PRIVATE' })), 1);
  assert.ok(!JSON.stringify(command).includes('estelle_live_abcdefgh1234'));
  assert.match(JSON.stringify(command), /redacted estelle key/);
  assert.ok(!JSON.stringify(command).includes('DO_NOT_CAPTURE_PRIVATE'));
  for (const status of ['failed', 'declined', null, 'in_progress']) {
    const [change] = mapCodex(completed({ type: 'FileChange', id: 'patch', status, changes: {} }), 2);
    assert.equal(change.kind, 'artifact');
    assert.equal(change.payload.status, ['failed', 'declined'].includes(status) ? status : null);
    assert.equal(change.payload.metadata_complete, ['failed', 'declined'].includes(status));
  }
});

const prCandidates = events => events.filter(e => e.payload.source === 'codex.gh_pr_create_candidate');
const prNotes = { repository: 'fixture/repository' };
test('Codex successful gh create observes separate target candidate without changing original artifact', () => {
  const record = completed(nativeCommand());
  const original = mapCodex(record, 7)[0];
  const events = mapCodex(record, 7, prNotes);
  assert.deepEqual(events[0], original);
  const [candidate] = prCandidates(events);
  assert.ok(candidate);
  assert.equal(candidate.event_id, 'r7:pr-candidate');
  assert.equal(candidate.payload.completion_event_id, original.event_id);
  assert.equal(candidate.payload.url, 'https://github.com/fixture/repository/pull/1');
  assert.equal(candidate.payload.repo, prNotes.repository);
  assert.equal(candidate.payload.number, 1);
  assert.equal(Object.hasOwn(candidate.payload, 'pr_url'), false);
  assert.equal(Object.hasOwn(candidate.payload, 'output'), false);
});

test('Codex candidate supports only direct gh and one known shell command', () => {
  for (const command of [['gh', 'pr', 'create', '--repo', 'fixture/repository'],
    ['/bin/zsh', '-lc', "gh pr create --title 'A quoted title' --body 'one; two'"],
    ['/bin/bash', '-c', 'gh pr create --body-file /tmp/owned-fixture.md']]) {
    assert.equal(prCandidates(mapCodex(completed(nativeCommand({ command })), 8, prNotes)).length, 1);
  }
  for (const command of [['echo', 'gh pr create'], ['gh', 'pr', 'view'],
    ['/bin/zsh', '-lc', 'gh pr create; echo forged'], ['/bin/zsh', '-lc', 'gh pr create && echo forged'],
    ['/bin/zsh', '-lc', 'echo x | gh pr create'], ['/bin/zsh', '-lc', 'gh pr create > /tmp/out'],
    ['/bin/zsh', '-lc', 'gh pr create --title "$(echo untrusted)"'],
    ['/bin/zsh', '-lc', "gh pr create --title 'unterminated"],
    ['node', '-e', 'gh pr create'], ['gh', 'pr', 'merge']]) {
    assert.deepEqual(prCandidates(mapCodex(completed(nativeCommand({ command })), 8, prNotes)), []);
  }
});

test('Codex candidate refuses unknown status, output, context and malformed target without storing output', () => {
  for (const extra of [{ status: 'failed', exit_code: 1 }, { status: 'completed', exit_code: null },
    { status: 'failed', exit_code: 0 }, { aggregated_output: 'A reply: https://github.com/fixture/repository/pull/1' },
    { aggregated_output: 'https://github.com/fixture/repository/pull/1\nPRIVATE_TRAILING_TEXT' },
    { aggregated_output: 'https://github.com/fixture/repository/pull/1?token=fixture' },
    { aggregated_output: 'https://github.com/foreign/repository/pull/1' },
    { aggregated_output: 'https://github.com/fixture/repository/pull/0' },
    { aggregated_output: 'https://github.com/fixture/repository/pull/1\n' + 'x'.repeat(4096) }]) {
    const events = mapCodex(completed(nativeCommand(extra)), 9, prNotes);
    assert.deepEqual(prCandidates(events), []);
    assert.equal(JSON.stringify(events).includes('PRIVATE_TRAILING_TEXT'), false);
  }
  assert.deepEqual(prCandidates(mapCodex(completed(nativeCommand()), 9)), []);
});

test('Codex candidate retry keeps immutable original and candidate IDs after a lost ACK', async t => {
  const f = await fixture(t, 'codex');
  const record = completed(nativeCommand());
  await writeFile(f.transcript, line(record));
  const server = new Map(); let lose = true;
  f.options.request = async (_path, body) => {
    for (const event of body.events) {
      const bytes = JSON.stringify(event);
      if (server.has(event.event_id)) assert.equal(server.get(event.event_id), bytes);
      else server.set(event.event_id, bytes);
    }
    if (lose) throw Object.assign(new Error('owned lost ACK'), { status: 503 });
    return { accepted: body.events.length };
  };
  assert.equal((await streamSession(f.options)).pending, true);
  lose = false;
  await streamSession(f.options);
  const captured = [...server.values()].map(JSON.parse);
  assert.equal(prCandidates(captured).length, 1);
  assert.equal(captured.filter(e => e.payload.native_type === 'CommandExecution').length, 1);
  assert.equal((await streamSession(f.options)).sent, 0);
});


test('Codex target output cap accepts exactly bounded URL output without truncating oversized data', () => {
  const url = nativeCommand().aggregated_output;
  const output = url + ' '.repeat(LIMITS.prResultBytes - Buffer.byteLength(url));
  assert.equal(Buffer.byteLength(output), LIMITS.prResultBytes);
  assert.equal(prCandidates(mapCodex(completed(nativeCommand({ aggregated_output: output })), 1, prNotes)).length, 1);
  assert.equal(prCandidates(mapCodex(completed(nativeCommand({ aggregated_output: output + ' ' })), 1, prNotes)).length, 0);
});

test('Codex candidate pair does not cross the existing event window cap or drop its cursor', async t => {
  const f = await fixture(t, 'codex');
  const before = Array.from({ length: LIMITS.codexEvents - 1 }, (_, n) => rollout({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `owned line ${n}` }] }));
  const prefix = before.map(line).join('');
  await writeFile(f.transcript, prefix + line(completed(nativeCommand())));
  await streamSession(f.options);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, Buffer.byteLength(prefix));
  assert.equal(prCandidates(f.calls.flatMap(call => call.body.events)).length, 0);
  await streamSession(f.options);
  assert.equal(prCandidates(f.calls.flatMap(call => call.body.events)).length, 1);
});

test('Codex verification partial status preserves upload ACK and cursor without leaking reply fields', async t => {
  for (const metadata of [undefined, { state: 'unavailable', linked: 0 },
    { state: 'partial', linked: 1, deferred: 1, unconfirmed: 0 },
    { state: 'linked', linked: 1, deferred: 0, unconfirmed: 0 }]) {
    const f = await fixture(t, 'codex');
    await writeFile(f.transcript, line(completed(nativeCommand())));
    f.options.request = async (_route, body) => ({ accepted: body.events.length,
      ...(metadata ? { captured_pr: metadata } : {}), raw: 'PRIVATE_REPLY_OMITTED' });
    const out = await streamSession(f.options);
    assert.equal(out.association_partial === true, metadata?.state !== 'linked');
    assert.equal(out.pending, undefined);
    assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, Buffer.byteLength(line(completed(nativeCommand()))));
    assert.equal(JSON.stringify(out).includes('PRIVATE_REPLY_OMITTED'), false);
  }
});

async function spooledCandidate(t) {
  const f = await fixture(t, 'codex');
  await writeFile(f.transcript, line(completed(nativeCommand())));
  f.options.request = async () => { throw Object.assign(new Error('owned upload unavailable'), { status: 503 }); };
  assert.equal((await streamSession(f.options)).pending, true);
  const next = join(f.dir, 'next.jsonl');
  await writeFile(next, '');
  const payload = { session_id: 'next-session', transcript_path: next, hook_event_name: 'PostToolUse' };
  return { ...f, next, payload, spool: join(f.options.stateDir, 'spool') };
}

for (const state of ['unavailable', 'partial', 'linked']) {
  test(`spooled candidate ${state} survives another session's replay without retrying its ACK`, async t => {
    const f = await spooledCandidate(t);
    const calls = [];
    const request = async (_route, body) => {
      calls.push(body);
      return { captured_pr: { state, linked: state === 'linked' ? 1 : 0, deferred: state === 'partial' ? 1 : 0,
        unconfirmed: 0 }, private: 'REPLAY_PRIVATE_RESPONSE' };
    };
    const result = await streamSession({ ...f.options, payload: f.payload, request });
    assert.equal(result.association_partial === true, state !== 'linked');
    assert.ok(result.replayed > 0);
    assert.equal(result.sent, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session_id, 'codex-fixture-session');
    assert.equal(prCandidates(calls[0].events).length, 1);
    assert.deepEqual(await readdir(f.spool), [], 'ACKed batches are deleted even when verification is unknown');
    assert.equal(JSON.parse(await readFile(f.state, 'utf8')).offset, 0, 'replay does not fabricate a source cursor ACK');
    assert.equal(JSON.stringify(result).includes('REPLAY_PRIVATE_RESPONSE'), false);
    await streamSession({ ...f.options, payload: f.payload, request });
    assert.equal(calls.length, 1, 'no reupload or association retry was added');
  });
}

test('spooled partial survives a linked fresh batch and stream early-return paths', async t => {
  for (const path of ['fresh-linked', 'missing-transcript', 'pending']) {
    const f = await spooledCandidate(t);
    if (path !== 'missing-transcript') await writeFile(f.next, line(completed(nativeCommand())));
    let calls = 0;
    const request = async (_route, body) => {
      if (++calls === 1) return { captured_pr: { state: 'unavailable', linked: 0 } };
      if (path === 'pending') throw Object.assign(new Error('new upload unavailable'), { status: 503 });
      return { captured_pr: { state: 'linked', linked: 1, deferred: 0, unconfirmed: 0 } };
    };
    const result = await streamSession({ ...f.options, payload: { ...f.payload,
      transcript_path: path === 'missing-transcript' ? null : f.next }, request });
    assert.equal(result.association_partial, true, path);
    assert.equal(result.pending === true, path === 'pending');
    assert.equal(calls, path === 'missing-transcript' ? 1 : 2);
    assert.equal((await readdir(f.spool)).length, path === 'pending' ? 1 : 0);
  }
});

test('multiple ACKed spool batches retain any partial result without retrying either batch', async t => {
  const f = await spooledCandidate(t);
  await writeFile(f.next, line(completed(nativeCommand())));
  assert.equal((await streamSession({ ...f.options, payload: f.payload })).pending, true);
  assert.equal((await readdir(f.spool)).length, 2);
  await writeFile(f.next, '');
  let calls = 0;
  const request = async () => ({ captured_pr: ++calls === 1 ? { state: 'unavailable', linked: 0 }
    : { state: 'linked', linked: 1, deferred: 0, unconfirmed: 0 } });
  const result = await streamSession({ ...f.options, payload: { ...f.payload, session_id: 'drain-only' }, request });
  assert.equal(calls, 2);
  assert.equal(result.association_partial, true);
  assert.deepEqual(await readdir(f.spool), []);
});

for (const state of ['unavailable', 'linked']) {
  test(`deferred capture reports ${state} replay status without retaining successful work`, async t => {
    const f = await spooledCandidate(t);
    await writeFile(f.next, line(rollout({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Owned next session' }] })));
    const calls = [];
    const request = async (route, body) => {
      calls.push({ route, body });
      return { captured_pr: { state, linked: state === 'linked' ? 1 : 0, deferred: 0, unconfirmed: 0 },
        private: 'DEFERRED_PRIVATE_RESPONSE' };
    };
    const payload = { ...f.payload, cwd: f.dir, reason: 'exit', hook_event_name: 'SessionEnd' };
    await handleHook({ host: 'codex', payload, stateDir: f.options.stateDir, request });
    assert.equal(calls.length, 0, 'exit still only records a deferred reference');
    const start = { session_id: 'third-session', cwd: f.dir, transcript_path: null,
      hook_event_name: 'SessionStart', model: 'fixture-model', permission_mode: 'default', source: 'startup' };
    await handleHook({ host: 'codex', payload: start, stateDir: f.options.stateDir, request });
    const status = JSON.parse(await readFile(join(f.options.stateDir, 'status', 'codex-deferred.json'), 'utf8'));
    assert.equal(status.status, state === 'linked' ? 'ok' : 'partial');
    assert.equal(status.code, state === 'linked' ? undefined : 'association_unverified');
    assert.equal(JSON.stringify(status).includes('DEFERRED_PRIVATE_RESPONSE'), false);
    assert.equal(JSON.stringify(status).includes('pull/1'), false);
    assert.deepEqual(await readdir(f.spool), []);
    assert.deepEqual(await readdir(join(f.options.stateDir, 'deferred')), []);
    assert.equal(calls.filter(call => prCandidates(call.body.events ?? []).length).length, 1);
    assert.equal(calls.filter(call => call.route === '/checkpoint').length, 1);
    const count = calls.length;
    await handleHook({ host: 'codex', payload: start, stateDir: f.options.stateDir, request });
    assert.equal(calls.length, count, 'completed deferred work is not retried for association');
  });
}
