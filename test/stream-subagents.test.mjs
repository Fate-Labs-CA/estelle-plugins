import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamSession, mapClaude } from '../runtime/stream.mjs';
import { subagentDir, noteTaskNotification } from '../runtime/stream-subagents.mjs';

// Shapes copied from a real Claude Code 2.1.x session (keys and layout only, synthetic text): the parent transcript at
// `<project>/<session>.jsonl`, each subagent at `<project>/<session>/subagents/agent-<agentId>.jsonl`, every one of its
// lines `isSidechain: true` carrying the PARENT's `sessionId`, and `agent-<agentId>.meta.json` naming the Agent call.
const SESSION = '8528db71-0626-4424-98a7-2ac2e561f091';
const CALL = 'toolu_01Bp52Rqzemjzt1Aaciw53F4';
const AGENT = 'a0bce7caf5df01948';
const CHILD = `claude-code-${SESSION}/agent-${CALL}`;
const line = value => `${JSON.stringify(value)}\n`;
const at = n => `2026-11-19T10:00:${String(n).padStart(2, '0')}.000Z`;
const sub = (uuid, n, type, content) => ({ parentUuid: null, isSidechain: true, agentId: AGENT, type, uuid, timestamp: at(n),
  sessionId: SESSION, userType: 'external', cwd: '/repo', version: '2.1.325', message: { role: type, content } });
const meta = extra => ({ agentType: 'general-purpose', isBuiltIn: false, description: 'Code-split the studio bundle', toolUseId: CALL,
  spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, model: 'sonnet', ...extra });

async function session(t, { finished = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-subagent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcript = join(dir, `${SESSION}.jsonl`);
  await writeFile(transcript, line({ uuid: 'p1', timestamp: at(0), type: 'user', sessionId: SESSION, message: { content: 'Split the bundle' } })
    + line({ uuid: 'p2', timestamp: at(1), type: 'assistant', sessionId: SESSION, message: { content: [
      { type: 'tool_use', id: CALL, name: 'Agent', input: { description: 'Code-split the studio bundle', prompt: 'Split it', run_in_background: true } }] } }));
  const agents = join(dir, SESSION, 'subagents');
  await mkdir(agents, { recursive: true });
  const file = join(agents, `agent-${AGENT}.jsonl`);
  await writeFile(file, line(sub('s1', 2, 'user', 'Split the studio bundle with dynamic imports'))
    + line(sub('s2', 3, 'assistant', [{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'npm run build', description: 'Build' } }]))
    + line(sub('s3', 4, 'user', [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'built' }])));
  await writeFile(join(agents, `agent-${AGENT}.meta.json`), JSON.stringify(meta({ finished })));
  const calls = [];
  const options = { host: 'claude', repo: 'fixture/repo', stateDir: join(dir, 'state'),
    payload: { session_id: SESSION, transcript_path: transcript, hook_event_name: 'PostToolUse' },
    request: async (path, body) => { calls.push({ path, body }); return { accepted: body.events.length }; } };
  return { dir, transcript, agents, file, calls, options };
}
const sentTo = (calls, id) => calls.filter(c => c.body.session_id === id).flatMap(c => c.body.events);

test('WIRED: a subagent transcript becomes its own timeline named by the parent Agent call, with its steps', async t => {
  const s = await session(t);
  const result = await streamSession(s.options);
  const child = sentTo(s.calls, CHILD);
  assert.equal(result.subagents.agents, 1);
  assert.equal(result.subagents.sent, child.length);
  assert.deepEqual(child.map(e => e.kind), ['lifecycle', 'agent_message', 'tool_call', 'tool_result']);
  assert.deepEqual(child[0].payload, { state: 'running', reason: 'started', title: 'Code-split the studio bundle', repo: 'fixture/repo',
    origin: 'claude-code', harness: 'subagent', parent: `claude-code-${SESSION}`, call_id: CALL });
  assert.equal(child[1].payload.brief_to_subagent, true, 'the parent brief is the brief, not the subagent speaking');
  assert.equal(child[2].author.id, 'subagent');
  assert.equal(child[2].payload.tool, 'Bash');
  // The parent keeps its Agent call (what the dashboard hangs the child on) and none of the child's steps.
  const parent = sentTo(s.calls, `claude-code-${SESSION}`);
  assert.equal(parent.find(e => e.kind === 'tool_call').payload.call_id, CALL);
  assert.ok(!parent.some(e => e.author?.id === 'subagent'));
});

test('UNWIRED: with no subagents directory, or on a host that shares the dialect but not the layout, nothing is mirrored', async t => {
  const s = await session(t);
  await rm(s.agents, { recursive: true });
  const result = await streamSession(s.options);
  assert.deepEqual(result.subagents, { sent: 0, agents: 0 });
  assert.equal(sentTo(s.calls, CHILD).length, 0);
  const o = await session(t);
  const opencode = await streamSession({ ...o.options, host: 'opencode' });
  assert.equal(opencode.subagents, undefined);
  assert.ok(!o.calls.some(c => c.body.session_id.includes('/agent-')));
});

test('the child cursor is durable: a second run sends only new lines, and the host finishing it ends it once', async t => {
  const s = await session(t);
  await streamSession(s.options);
  const before = sentTo(s.calls, CHILD).length;
  await streamSession(s.options);
  assert.equal(sentTo(s.calls, CHILD).length, before, 'nothing new, nothing resent');
  await appendFile(s.file, line(sub('s4', 5, 'assistant', [{ type: 'text', text: 'Split into three chunks' }])));
  await writeFile(join(s.agents, `agent-${AGENT}.meta.json`), JSON.stringify(meta({ finished: true })));
  await streamSession(s.options);
  const after = sentTo(s.calls, CHILD).slice(before);
  assert.deepEqual(after.map(e => e.kind), ['agent_message', 'lifecycle']);
  assert.equal(after[0].payload.subagent, undefined, 'inside its own timeline its words are the conversation');
  assert.deepEqual(after[1].payload, { state: 'ended', reason: 'completed' });
  assert.equal(after[1].at, at(5));
  await appendFile(s.file, line(sub('s5', 6, 'assistant', [{ type: 'text', text: 'late' }])));
  await streamSession(s.options);
  assert.equal(sentTo(s.calls, CHILD).length, before + 2, 'an ended subagent is never read again');
});

test('a task-notification in the parent ends its subagent, failed when the host says killed', async t => {
  const s = await session(t);
  await streamSession(s.options);
  await appendFile(s.transcript, line({ uuid: 'p3', timestamp: at(9), type: 'attachment', sessionId: SESSION, attachment: { type: 'queued_command',
    prompt: `<task-notification>\n<task-id>${AGENT}</task-id>\n<tool-use-id>${CALL}</tool-use-id>\n<status>killed</status>\n</task-notification>` } }));
  await streamSession(s.options);
  const end = sentTo(s.calls, CHILD).at(-1);
  assert.deepEqual(end.payload, { state: 'ended', reason: 'failed' });
  assert.equal(end.at, at(3), 'ends at its last reply, not at the clock');
});

test('a handback, or a reply with no tool followed by quiet, ends it; an open tool call keeps it running', async t => {
  const s = await session(t);
  await appendFile(s.file, line(sub('s4', 5, 'assistant', [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Done: three chunks' } }])));
  await streamSession(s.options);
  const events = sentTo(s.calls, CHILD);
  assert.equal(events.at(-2).payload.report, true);
  assert.deepEqual(events.at(-1).payload, { state: 'ended', reason: 'completed' });
  const q = await session(t);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(q.file, old, old);
  await streamSession(q.options);
  assert.ok(!sentTo(q.calls, CHILD).some(e => e.payload.state === 'ended'), 'its last reply called Bash: still working, however quiet');
  await appendFile(q.file, line(sub('s4', 5, 'assistant', [{ type: 'text', text: 'All done' }])));
  await utimes(q.file, old, old);
  await streamSession(q.options);
  assert.deepEqual(sentTo(q.calls, CHILD).at(-1).payload, { state: 'ended', reason: 'completed' });
});

test('a refused child upload keeps its cursor and the parent result; the next run resends the same events', async t => {
  const s = await session(t);
  let refuse = true;
  const request = async (path, body) => {
    if (refuse && body.session_id === CHILD) throw Object.assign(new Error('unavailable'), { status: 503 });
    s.calls.push({ path, body }); return { accepted: body.events.length };
  };
  const first = await streamSession({ ...s.options, request });
  assert.match(first.subagents.error, /503/);
  assert.ok(first.sent > 0, 'the parent upload is not undone by a child refusal');
  refuse = false;
  await streamSession({ ...s.options, request });
  assert.equal(sentTo(s.calls, CHILD)[0].event_id, `${CHILD}:started`);
});

test('a subagent with no recorded Agent call is skipped, and a subagent path never nests', async t => {
  const s = await session(t);
  await writeFile(join(s.agents, `agent-${AGENT}.meta.json`), JSON.stringify(meta({ toolUseId: 'bad id/../x' })));
  await streamSession(s.options);
  assert.ok(!s.calls.some(c => c.body.session_id.includes('/agent-')));
  assert.equal(subagentDir(join(s.agents, `agent-${AGENT}.jsonl`)), null);
  assert.equal(subagentDir(s.transcript), s.agents);
});

test('mapping: the brief, the handback and task notifications read as the old CLI bridge read them', () => {
  const notes = {};
  noteTaskNotification('<task-notification><tool-use-id>toolu_1</tool-use-id><status>completed</status></task-notification>', notes);
  noteTaskNotification('plain text', notes);
  assert.deepEqual(notes.notified, [['toolu_1', 'completed']]);
  const parentNotes = {};
  assert.deepEqual(mapClaude({ uuid: 'n', timestamp: at(1), type: 'user', origin: { kind: 'task-notification' },
    message: { content: '<task-notification><tool-use-id>toolu_2</tool-use-id><status>failed</status></task-notification>' } }, 0, parentNotes), []);
  assert.deepEqual(parentNotes.notified, [['toolu_2', 'failed']]);
  const [brief] = mapClaude(sub('b', 1, 'user', 'Do the thing'), 0, {}, true);
  assert.equal(brief.kind, 'agent_message');
  assert.equal(brief.author.id, 'claude-code');
  const [reply] = mapClaude(sub('r', 2, 'assistant', [{ type: 'text', text: 'ok' }]), 0, {}, false);
  assert.equal(reply.payload.subagent, true, 'a sidechain reply read inline in a parent stays an aside');
});
