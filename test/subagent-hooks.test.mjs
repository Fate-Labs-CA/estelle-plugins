import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { handleHook } from '../runtime/hooks.mjs';

// Hook payloads in the shapes the hosts document: Cursor's subagentStart carries subagent_id, task, parent_conversation_id and
// tool_call_id, its subagentStop carries task, status and summary and names no agent; Grok and Qwen name the agent on both.
const PARENT = 'conv-parent-1';
const cursorStart = (extra = {}) => ({ hook_event_name: 'subagentStart', conversation_id: PARENT, workspace_roots: ['/tmp'],
  subagent_id: 'sub-9', subagent_type: 'generalPurpose', task: 'Audit the billing module', parent_conversation_id: PARENT,
  tool_call_id: 'call_abc', subagent_model: 'x', is_parallel_worker: false, ...extra });
const cursorStop = (extra = {}) => ({ hook_event_name: 'subagentStop', conversation_id: PARENT, workspace_roots: ['/tmp'],
  subagent_type: 'generalPurpose', status: 'completed', task: 'Audit the billing module', description: 'billing audit',
  summary: 'Found two rounding bugs', duration_ms: 4200, message_count: 6, tool_call_count: 3, loop_count: 0, modified_files: [], ...extra });

async function run(t, host, payloads) {
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-subhook-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return { accepted: body?.events?.length ?? 0 }; };
  for (const payload of payloads) await handleHook({ host, payload, stateDir, request });
  return { calls, stateDir, sent: id => calls.filter(c => c.path === '/session/events' && c.body.session_id === id).flatMap(c => c.body.events) };
}

test('WIRED: a Cursor subagent is posted running at its start and ended with its result at its stop, under the parent', async t => {
  const r = await run(t, 'cursor', [cursorStart(), cursorStop()]);
  const child = 'cursor-conv-parent-1/agent-call_abc';
  const events = r.sent(child);
  assert.deepEqual(events.map(e => e.kind), ['lifecycle', 'agent_message', 'lifecycle']);
  assert.deepEqual(events[0].payload, { state: 'running', reason: 'started', title: 'Audit the billing module', repo: events[0].payload.repo,
    origin: 'cursor', harness: 'subagent', parent: 'cursor-conv-parent-1', call_id: 'call_abc' });
  assert.equal(events[1].payload.text, 'Found two rounding bugs');
  assert.deepEqual(events[2].payload, { state: 'ended', reason: 'completed' });
});

test('a Cursor stop with status error is failed, aborted is cancelled; a stop matching no started subagent posts nothing', async t => {
  const failed = await run(t, 'cursor', [cursorStart(), cursorStop({ status: 'error' })]);
  assert.equal(failed.sent('cursor-conv-parent-1/agent-call_abc').at(-1).payload.reason, 'failed');
  const aborted = await run(t, 'cursor', [cursorStart(), cursorStop({ status: 'aborted' })]);
  assert.equal(aborted.sent('cursor-conv-parent-1/agent-call_abc').at(-1).payload.reason, 'cancelled');
  const orphan = await run(t, 'cursor', [cursorStop({ task: 'never started' })]);
  assert.ok(!orphan.calls.some(c => c.body?.session_id?.includes('/agent-')));
});

test('two parallel Cursor subagents with different tasks each end under their own id; a second stop ends nothing', async t => {
  const r = await run(t, 'cursor', [cursorStart(), cursorStart({ subagent_id: 'sub-10', tool_call_id: 'call_def', task: 'Write the migration' }),
    cursorStop({ task: 'Write the migration', summary: 'Wrote it' }), cursorStop({ task: 'Write the migration' })]);
  assert.equal(r.sent('cursor-conv-parent-1/agent-call_def').filter(e => e.payload.state === 'ended').length, 1);
  assert.ok(!r.sent('cursor-conv-parent-1/agent-call_abc').some(e => e.payload.state === 'ended'), 'the other one is still running');
});

test('Grok and Qwen name the agent on both hooks, so the stop closes exactly that child', async t => {
  const grok = await run(t, 'grok', [
    { hook_event_name: 'SubagentStart', session_id: 'g-1', cwd: '/tmp', subagentId: 'child-7', subagentType: 'worker' },
    { hook_event_name: 'SubagentStop', session_id: 'g-1', cwd: '/tmp', subagentId: 'child-7', lastAssistantMessage: 'Done' }]);
  const events = grok.sent('grok-g-1/agent-child-7');
  assert.deepEqual(events.map(e => e.payload.state ?? 'text'), ['running', 'text', 'ended']);
  assert.equal(events[0].payload.title, 'worker');
  const qwen = await run(t, 'qwen-code', [
    { hook_event_name: 'SubagentStart', session_id: 'q-1', cwd: '/tmp', agent_id: 'a1', agent_type: 'Explore' },
    { hook_event_name: 'SubagentStop', session_id: 'q-1', cwd: '/tmp', agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'ok' }]);
  assert.equal(qwen.sent('qwen-code-q-1/agent-a1').at(-1).payload.state, 'ended');
});

test('Kimi names the agent only by agent_name: the stop closes the oldest started child of that name', async t => {
  const kimi = await run(t, 'kimi', [
    { hook_event_name: 'SubagentStart', session_id: 'k-1', cwd: '/tmp', agent_name: 'coder', prompt: 'Fix the parser', tool_call_id: 'tc_1' },
    { hook_event_name: 'SubagentStop', session_id: 'k-1', cwd: '/tmp', agent_name: 'coder', response: 'Fixed' }]);
  const events = kimi.sent('kimi-code-k-1/agent-tc_1');
  assert.deepEqual(events.map(e => e.payload.state ?? 'text'), ['running', 'text', 'ended']);
});

test('UNWIRED: Claude Code and Codex do not announce (their transcripts are mirrored), and a refused post leaves the child open', async t => {
  const claude = await run(t, 'claude-code', [{ hook_event_name: 'SubagentStart', session_id: 'c-1', cwd: '/tmp', agent_id: 'a', agent_type: 'Explore' }]);
  assert.ok(!claude.calls.some(c => c.body?.session_id?.includes('/agent-')));
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-subhook-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let refuse = true;
  const request = async (path, body) => { if (refuse) throw Object.assign(new Error('down'), { status: 503 }); return { accepted: body.events.length }; };
  await handleHook({ host: 'cursor', payload: cursorStart(), stateDir, request });
  refuse = false;
  const calls = [];
  await handleHook({ host: 'cursor', payload: cursorStop(), stateDir, request: async (p, b) => { calls.push(b); return { accepted: 1 }; } });
  assert.ok(!calls.some(b => b.session_id?.includes('/agent-')), 'a start that never landed is not invented at the stop');
});

test('a Claude Code SubagentStart streams the parent so its child shows running at once, and SubagentStop ends it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-subhook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const SESSION = '8528db71-0626-4424-98a7-2ac2e561f091';
  const CALL = 'toolu_01Bp52Rqzemjzt1Aaciw53F4';
  const AGENT = 'a0bce7caf5df01948';
  const at = n => `2026-11-19T10:00:${String(n).padStart(2, '0')}.000Z`;
  const line = value => `${JSON.stringify(value)}\n`;
  const sub = (n, type, content) => ({ isSidechain: true, agentId: AGENT, type, uuid: `s${n}`, timestamp: at(n), sessionId: SESSION, message: { role: type, content } });
  const transcript = join(dir, `${SESSION}.jsonl`);
  await writeFile(transcript, line({ uuid: 'p1', timestamp: at(0), type: 'user', sessionId: SESSION, message: { content: 'go' } })
    + line({ uuid: 'p2', timestamp: at(1), type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'tool_use', id: CALL, name: 'Agent', input: { description: 'Review', prompt: 'x' } }] } }));
  const agents = join(dir, SESSION, 'subagents');
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, `agent-${AGENT}.jsonl`), line(sub(2, 'user', 'Review the diff'))
    + line(sub(3, 'assistant', [{ type: 'text', text: 'Looks right' }])));
  await writeFile(join(agents, `agent-${AGENT}.meta.json`), JSON.stringify({ description: 'Review', toolUseId: CALL }));
  assert.equal(spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']).status, 0);
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/fixture/estelle-hooks.git']);
  const calls = [];
  const request = async (path, body) => { calls.push(body); return { accepted: body?.events?.length ?? 0 }; };
  const stateDir = join(dir, 'state');
  const fire = hook => handleHook({ host: 'claude-code', stateDir, request, payload: payload(hook) });
  const payload = hook => ({ hook_event_name: hook, session_id: SESSION, cwd: dir, transcript_path: transcript, agent_id: AGENT, agent_type: 'Explore',
    ...(hook === 'PostToolUse' ? { tool_name: 'Read', tool_input: { file_path: 'a' }, tool_response: {} } : {}) });
  const child = `claude-code-${SESSION}/agent-${CALL}`;
  const states = () => calls.filter(b => b.session_id === child).flatMap(b => b.events).filter(e => e.kind === 'lifecycle').map(e => e.payload.state);
  // SubagentStart carries no transcript read of its own; the mirror runs on it now.
  await fire('SubagentStart');
  assert.deepEqual(states(), ['running']);
  // The subagent's last reply called no tool, but it is not quiet yet: only its own SubagentStop ends it.
  await fire('PostToolUse');
  assert.deepEqual(states(), ['running']);
  await fire('SubagentStop');
  assert.deepEqual(states(), ['running', 'ended']);
});
