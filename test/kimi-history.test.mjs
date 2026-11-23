import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeKimiRecord, activeKimiRecords, readKimiHistory, KIMI_HISTORY_LIMITS } from '../runtime/kimi-history.mjs';

const at = 1_700_000_000_000;
const metadata = { type: 'metadata', protocol_version: '1.5', created_at: at };
const appended = (role, text, time = at) => ({ type: 'agent.message.appended', kind: 'event', time,
  message: { message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { toolCalls: [] } : {}) },
    meta: { source: role === 'user' ? 'input' : 'llm', ...(role === 'user' ? { origin: { kind: 'user' } } : {}) } } });

async function fixture(t, records) {
  const home = await mkdtemp(join(tmpdir(), 'estelle-kimi-current-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const session = join(home, 'sessions', 'workspace', 'session-one');
  const wire = join(session, 'agents', 'main', 'wire.jsonl');
  await mkdir(join(session, 'agents', 'main'), { recursive: true });
  const cwd = join(home, 'project');
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: 'session-one', workDir: cwd, sessionDir: session }) + '\n');
  await writeFile(wire, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { home, cwd, wire, sessionId: 'session-one' };
}

test('current machine message wrapper and human compatibility alias normalize without hidden reasoning', () => {
  const record = appended('assistant', 'Public reply');
  record.message.message.content.unshift({ type: 'think', think: 'hidden reasoning', encrypted: 'encrypted' });
  record.message.message.toolCalls.push({ type: 'function', id: 'call-1', name: 'Read', arguments: '{"path":"src/a.ts"}' });
  const normalized = normalizeKimiRecord(record);
  assert.equal(normalized.type, 'context.append_message');
  assert.equal(normalized.time, at);
  assert.equal(normalized.message.content[0].text, 'Public reply');
  assert.equal(normalized.message.toolCalls[0].name, 'Read');
  assert.doesNotMatch(JSON.stringify(normalized), /hidden reasoning|encrypted/);
  assert.deepEqual(normalizeKimiRecord({ ...record, type: 'human.agent.message.appended' }), normalized);
});

test('does not invent timestamps, expose unsupported roles, or turn injections into person messages', () => {
  const record = appended('user', 'hello');
  delete record.time;
  assert.equal(normalizeKimiRecord(record), null);
  assert.equal(normalizeKimiRecord({ type: 'agent.message.appended', time: at, message: { role: 'system', content: [] } }), null);
  const injected = appended('user', 'Injected rules'); injected.message.meta.source = 'injection';
  assert.equal(normalizeKimiRecord(injected), null);
  assert.deepEqual(normalizeKimiRecord({ type: 'agent.turn.ended', time: at }), { type: 'turn.ended', time: at });
});

test('active branch ancestry excludes abandoned turn while retaining base history', () => {
  const base = appended('user', 'Keep this');
  const abandoned = appended('assistant', 'Abandoned answer');
  const revised = appended('assistant', 'Revised answer');
  const records = [metadata, base, abandoned,
    { type: 'agent.switched', branch: 'b1', base: { branch: 'main', line: 2 }, legacyUndoLine: 5, time: at },
    { type: 'context.undo', count: 1, time: at }, revised];
  const selected = activeKimiRecords(records);
  assert.ok(selected.includes(base)); assert.ok(selected.includes(revised));
  assert.ok(!selected.includes(abandoned));
});

test('registered current wire yields visible active conversation and exact coverage', async t => {
  const records = [metadata, appended('user', 'Please fix it'), appended('assistant', 'I fixed it'),
    { type: 'agent.turn.ended', time: at, turnId: 0, outcome: 'done' }];
  const fx = await fixture(t, records);
  const result = await readKimiHistory(fx);
  assert.equal(result.available, true); assert.equal(result.format, 'kimi-wire-1.5');
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.messages.map(message => message.content), ['Please fix it', 'I fixed it']);
  assert.equal(result.sourcePath, await realpath(fx.wire));
  assert.equal(result.coverage.recordsRead, 4);
});

test('registry scoped lookup rejects another cwd and future wire version', async t => {
  const fx = await fixture(t, [{ ...metadata, protocol_version: '2.0' }, appended('user', 'future')]);
  const wrong = await readKimiHistory({ ...fx, cwd: `${fx.cwd}-other` });
  assert.equal(wrong.available, false);
  const future = await readKimiHistory(fx);
  assert.equal(future.coverage.reason, 'unsupported_wire_version'); assert.equal(future.coverage.complete, false);
});

test('malformed branch references, duplicate branches and malformed JSON are refusals', async t => {
  const badEdge = { type: 'agent.switched', branch: 'b1', base: { branch: 'unknown', line: 1 }, time: at };
  const fx = await fixture(t, [metadata, badEdge, appended('user', 'wrong ancestry')]);
  assert.equal((await readKimiHistory(fx)).coverage.reason, 'invalid_branch_history');
  assert.throws(() => activeKimiRecords([metadata, { ...badEdge, branch: 'main' }]), /duplicate/);
  await writeFile(fx.wire, JSON.stringify(metadata) + '\n{broken}\n');
  assert.equal((await readKimiHistory(fx)).coverage.reason, 'invalid_records');
});

test('partial last record is not consumed or certified complete; unknown record is disclosed', async t => {
  const fx = await fixture(t, [metadata, appended('user', 'Saved')]);
  await writeFile(fx.wire, JSON.stringify(metadata) + '\n' + JSON.stringify(appended('user', 'Saved')) + '\n{"type":');
  const partial = await readKimiHistory(fx);
  assert.equal(partial.available, true); assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.messages.map(message => message.content), ['Saved']);
  await writeFile(fx.wire, [metadata, { type: 'agent.future-data', time: at }].map(JSON.stringify).join('\n') + '\n');
  const unknown = await readKimiHistory(fx);
  assert.equal(unknown.coverage.complete, false); assert.equal(unknown.coverage.unsupported, 1);
});

test('byte cap refuses a sparse oversized journal without reading or claiming empty history', async t => {
  const fx = await fixture(t, [metadata]);
  const file = await open(fx.wire, 'r+');
  await file.truncate(KIMI_HISTORY_LIMITS.bytes + 1); await file.close();
  const result = await readKimiHistory(fx);
  assert.equal(result.available, false); assert.equal(result.coverage.reason, 'byte_bound');
  assert.equal(result.coverage.complete, false); assert.equal(result.records, undefined);
});

test('paired switch undo is already projected; unsupported standalone context mutations are explicit', async t => {
  const records = [metadata, appended('user', 'kept'), appended('assistant', 'old'),
    { type: 'agent.switched', branch: 'b1', base: { branch: 'main', line: 2 }, legacyUndoLine: 5, time: at },
    { type: 'context.undo', count: 1, time: at }, appended('assistant', 'new')];
  const fx = await fixture(t, records);
  const result = await readKimiHistory(fx);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.messages.map(message => message.content), ['kept', 'new']);
  await writeFile(fx.wire, [metadata, appended('user', 'old'), { type: 'context.clear', time: at }].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await readKimiHistory(fx)).coverage.reason, 'unsupported_context_mutation');
});

test('known credentials are redacted, unknown content and text caps remain partial', async t => {
  const token = 'ghp_' + 'x'.repeat(24);
  const record = appended('user', `Key ${token}`);
  record.message.message.content.push({ type: 'future_part', value: 'unknown' });
  const fx = await fixture(t, [metadata, record]);
  const result = await readKimiHistory(fx);
  assert.doesNotMatch(JSON.stringify(result.records), new RegExp(token));
  assert.match(result.messages[0].content, /redacted/);
  assert.equal(result.coverage.complete, false);
});

test('a loop-only wire (Kimi 2.6.0) is read as turns and tool records; a wire with appended turns keeps the old reading', async t => {
  const loop = event => ({ type: 'context.append_loop_event', time: at + 1, event });
  const loopOnly = await fixture(t, [metadata, appended('user', 'go'),
    loop({ type: 'content.part', part: { type: 'text', text: 'working' } }),
    loop({ type: 'tool.call', toolCallId: 'k1', name: 'Read', args: { path: 'a' } }),
    loop({ type: 'tool.result', toolCallId: 'k1', result: { output: 'ok' } }),
    loop({ type: 'step.end', step: 1 })]);
  const read = await readKimiHistory({ sessionId: loopOnly.sessionId, cwd: loopOnly.cwd, home: loopOnly.home });
  assert.deepEqual(read.records.map(r => r.message.role), ['user', 'assistant', 'assistant', 'tool']);
  assert.equal(read.records[2].message.toolCalls[0].name, 'Read');
  assert.equal(read.coverage.unsupported, 0);
  const mixed = await fixture(t, [metadata, appended('user', 'go'), appended('assistant', 'done'),
    loop({ type: 'content.part', part: { type: 'text', text: 'done' } })]);
  const both = await readKimiHistory({ sessionId: mixed.sessionId, cwd: mixed.cwd, home: mixed.home });
  assert.deepEqual(both.records.map(r => r.message.role), ['user', 'assistant']);
});
