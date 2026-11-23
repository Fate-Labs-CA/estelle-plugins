import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamSession, mapCodex } from '../runtime/stream.mjs';
import { noteCodexSpawn, sessionsRoot, taskTitle } from '../runtime/stream-codex-subagents.mjs';
import { ROOT, CHILD, GRANDCHILD, CALL, GRAND_CALL, at, line, event, item, codexSession, childMeta, dayDir, brief, say,
  spawnCall, spawned, exec } from './fixtures/codex-subagent-session.mjs';

const PARENT = `codex-${ROOT}`;
const KID = `${PARENT}/agent-${CALL}`;
const NOW = Date.parse(at(30));

async function session(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-codex-subagent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await codexSession(dir, options);
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return { accepted: body.events.length }; };
  // The fixture's clock is fixed (`at`), so the test's "now" is fixed beside it: a real clock would age the spawns past ACTIVE_MS.
  return { ...s, calls, options: { ...s.options, stateDir: join(dir, 'state'), request, now: NOW } };
}
const sentTo = (calls, id) => calls.filter(c => c.body.session_id === id).flatMap(c => c.body.events);

test('WIRED: a Codex child rollout becomes its own timeline named by the spawn_agent call, with its steps', async t => {
  const s = await session(t);
  const result = await streamSession(s.options);
  const child = sentTo(s.calls, KID);
  assert.equal(result.subagents.agents, 1);
  assert.equal(result.subagents.sent, child.length);
  assert.deepEqual(child.map(e => e.kind), ['lifecycle', 'agent_message', 'tool_call', 'tool_result', 'agent_message', 'lifecycle']);
  assert.deepEqual(child[0].payload, { state: 'running', reason: 'started', title: 'Code review', repo: 'fixture/repo', origin: 'codex',
    harness: 'subagent', parent: PARENT, call_id: CALL, agent_path: '/root/code_review' });
  assert.equal(child[0].at, at(2));
  assert.deepEqual(child[1].payload, { text: 'Review the diff for regressions', brief_to_subagent: true, from: '/root' });
  assert.equal(child[1].author.id, 'codex', 'the brief is the spawner speaking, not the subagent');
  assert.equal(child[2].author.id, 'subagent');
  assert.equal(child[4].author.id, 'subagent');
  assert.equal(child[4].payload.subagent, undefined, 'inside its own timeline its words are the conversation');
  assert.deepEqual(child.at(-1).payload, { state: 'ended', reason: 'completed' });
  assert.ok(!child.some(e => e.kind === 'customer_message'), 'injected context is not a person speaking');
  // The root keeps its spawn_agent call (what the dashboard hangs the child on) and none of the child's steps.
  const parent = sentTo(s.calls, PARENT);
  const spawn = parent.find(e => e.kind === 'tool_call');
  assert.equal(spawn.payload.tool, 'collaboration.spawn_agent');
  assert.equal(spawn.payload.call_id, CALL);
  assert.ok(!parent.some(e => e.author?.id === 'subagent'));
});

test('UNWIRED: the same child rollout with no SubAgentActivity in the root links to nothing and is not mirrored', async t => {
  const s = await session(t, { withActivity: false });
  const result = await streamSession(s.options);
  assert.deepEqual(result.subagents, { sent: 0, agents: 0, waiting: 0 });
  assert.ok(!s.calls.some(c => c.body.session_id.includes('/agent-')));
});

test('the cursor is durable, and a follow-up turn reopens the child explicitly and ends it again', async t => {
  const s = await session(t);
  await streamSession(s.options);
  const before = sentTo(s.calls, KID).length;
  await streamSession(s.options);
  assert.equal(sentTo(s.calls, KID).length, before, 'nothing new, nothing resent');
  await appendFile(s.file, line(event(9, { type: 'task_started' })) + line(brief(9, '/root', '/root/code_review', 'Check the tests too'))
    + line(say(10, 'Tests pass')) + line(event(11, { type: 'turn_aborted' })));
  await streamSession(s.options);
  const after = sentTo(s.calls, KID).slice(before);
  assert.deepEqual(after.map(e => [e.kind, e.payload.state, e.payload.reason]), [['lifecycle', 'running', 'resumed'],
    ['agent_message', undefined, undefined], ['agent_message', undefined, undefined], ['lifecycle', 'ended', 'cancelled']]);
  const ids = sentTo(s.calls, KID).map(e => e.event_id);
  assert.equal(new Set(ids).size, ids.length, 'every end and reopen has its own id');
  assert.ok(ids.every(id => id.length <= 128));
});

test('a forked child skips the copied history before subagent_history_start_ordinal', async t => {
  const s = await session(t);
  // Lines 0-1 are metas, 2-5 the spawner's copied history (its own spawn and turn end among them), 6 on are the child's.
  await writeFile(s.file, line(childMeta(1, CHILD, ROOT, '/root/code_review', { forked_from_id: ROOT, subagent_history_start_ordinal: 6 }))
    + line({ timestamp: at(1), type: 'session_meta', payload: { id: ROOT } })
    + line(item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Copied: the person asked this' }] }))
    + line(spawned(1, 'call_copied', GRANDCHILD, '/root/other'))
    + line(say(1, 'Copied: the root answered'))
    + line(event(1, { type: 'task_complete' }))
    + line(event(2, { type: 'thread_settings_applied' })) + line(event(2, { type: 'task_started' }))
    + line(say(3, 'My own review')) + line(event(4, { type: 'task_complete' })));
  await streamSession(s.options);
  const child = sentTo(s.calls, KID);
  assert.deepEqual(child.map(e => e.kind), ['lifecycle', 'agent_message', 'lifecycle']);
  assert.equal(child[1].payload.text, 'My own review');
  assert.ok(!s.calls.some(c => c.body.session_id.endsWith('/agent-call_copied')), 'a copied spawn is not this child\'s');
});

test('a subagent spawned by a subagent is mirrored flat under the root, keyed by its own spawn call', async t => {
  const s = await session(t);
  await appendFile(s.file, line(event(5, { type: 'task_started' })) + line(spawnCall(5, GRAND_CALL, 'deep_check'))
    + line(spawned(5, GRAND_CALL, GRANDCHILD, '/root/code_review/deep_check')));
  await writeFile(join(dayDir(s.sessions, at(5)), `rollout-2026-11-19T10-00-05-${GRANDCHILD}.jsonl`),
    line(childMeta(5, GRANDCHILD, CHILD, '/root/code_review/deep_check'))
    + line(event(6, { type: 'task_started' })) + exec(6, 'call_exec_2').map(line).join('') + line(event(7, { type: 'task_complete' })));
  await streamSession(s.options);
  await streamSession(s.options);   // the grandchild is found from the child's lines, so it is read on the next pass
  const grand = sentTo(s.calls, `${PARENT}/agent-${GRAND_CALL}`);
  assert.deepEqual(grand.map(e => e.kind), ['lifecycle', 'tool_call', 'tool_result', 'lifecycle']);
  assert.equal(grand[0].payload.parent, PARENT);
  assert.equal(grand[0].payload.title, 'Deep check');
  const spawn = sentTo(s.calls, KID).find(e => e.kind === 'tool_call' && e.payload.call_id === GRAND_CALL);
  assert.equal(spawn.payload.tool, 'collaboration.spawn_agent', 'the child timeline carries the call the dashboard opens it from');
});

test('a refused child upload keeps its cursor and the root result; the next run resends the same events', async t => {
  const s = await session(t);
  let refuse = true;
  const request = async (path, body) => {
    if (refuse && body.session_id === KID) throw Object.assign(new Error('unavailable'), { status: 503 });
    s.calls.push({ path, body }); return { accepted: body.events.length };
  };
  const first = await streamSession({ ...s.options, request });
  assert.match(first.subagents.error, /503/);
  assert.ok(first.sent > 0, 'the root upload is not undone by a child refusal');
  refuse = false;
  await streamSession({ ...s.options, request });
  assert.equal(sentTo(s.calls, KID)[0].event_id, `${KID}:started`);
});

test('a rollout whose meta names another root is not mirrored, and one not yet written waits', async t => {
  const s = await session(t);
  await writeFile(s.file, line(childMeta(1, CHILD, ROOT, '/root/code_review', { session_id: '01a19176-0000-7000-8000-00000000ffff' }))
    + line(event(2, { type: 'task_started' })) + line(say(3, 'not yours')));
  const wrong = await streamSession(s.options);
  assert.equal(wrong.subagents.agents, 0);
  assert.ok(!s.calls.some(c => c.body.session_id.includes('/agent-')));
  const m = await session(t);
  await rm(m.file);
  const missing = await streamSession({ ...m.options, payload: { ...m.options.payload } });
  assert.equal(missing.subagents.waiting, 1);
});

test('mapping: SubAgentActivity notes a spawn and draws nothing; titles and the sessions root are derived', () => {
  const notes = {};
  assert.deepEqual(mapCodex(spawned(1, CALL, CHILD, '/root/code_review'), 0, notes), []);
  assert.deepEqual(notes.spawns, [{ thread: CHILD, call: CALL, path: '/root/code_review', at: at(1) }]);
  noteCodexSpawn({ type: 'SubAgentActivity', kind: 'interacted', id: CALL, agent_thread_id: CHILD }, at(2), notes);
  noteCodexSpawn({ type: 'SubAgentActivity', kind: 'started', id: 'bad id/..', agent_thread_id: CHILD }, at(2), notes);
  assert.equal(notes.spawns.length, 1);
  assert.equal(taskTitle('/root/monitor_oncall_v2_finish'), 'Monitor oncall v2 finish');
  assert.equal(taskTitle(''), 'Subagent');
  assert.equal(sessionsRoot('/h/.codex/sessions/2026/11/19/rollout-x.jsonl'), '/h/.codex/sessions');
  assert.equal(sessionsRoot('/h/elsewhere/rollout-x.jsonl'), null);
});
