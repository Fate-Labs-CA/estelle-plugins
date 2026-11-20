// A synthetic Codex session in the on-disk shapes of a real Codex 0.166-0.170 multi-agent v2 session (keys, ids and
// layout measured on local rollouts; every text here is invented). The root rollout calls `collaboration.spawn_agent`
// and records `SubAgentActivity` (`id` = that call id, `agent_thread_id` = the child); the child's own rollout sits in the
// dated directory of its local start time, its `session_meta` naming the root as `session_id` and its spawner as
// `parent_thread_id`. Shared by test/stream-codex-subagents.test.mjs and the backend/web fixture generator.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ROOT = '01a19176-0000-7000-8000-000000000001';
export const CHILD = '01a19176-15a1-7bc3-a99a-000000000002';
export const GRANDCHILD = '01a19176-15a1-7bc3-a99a-000000000003';
export const CALL = 'call_915cc6bf14d0472bba47acaa643b2f52';
export const GRAND_CALL = 'call_aa00bb11cc22dd33ee44ff5566778899';
export const at = n => `2026-11-19T10:00:${String(n).padStart(2, '0')}.000Z`;
export const line = value => `${JSON.stringify(value)}\n`;
const record = (n, type, payload) => ({ timestamp: at(n), type, payload });
export const event = (n, payload) => record(n, 'event_msg', payload);
export const item = (n, payload) => record(n, 'response_item', payload);

/** `<sessions>/YYYY/MM/DD` for an instant, by the machine's local date, as Codex names it. */
export function dayDir(sessions, iso) {
  const d = new Date(iso);
  return join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}

export function meta(n, id, extra = {}) {
  return record(n, 'session_meta', { id, session_id: ROOT, timestamp: at(n), cwd: '/repo', originator: 'codex-tui',
    cli_version: '0.170.0', source: 'vscode', multi_agent_version: 'v2', ...extra });
}

export function childMeta(n, id, parent, path, extra = {}) {
  return meta(n, id, { parent_thread_id: parent, agent_path: path, agent_nickname: 'Nietzsche', agent_role: 'code-reviewer',
    thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path } } }, ...extra });
}

export const spawnCall = (n, call, task) => item(n, { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: call,
  arguments: JSON.stringify({ task_name: task, agent_type: 'code-reviewer', fork_turns: 'none', message: 'Review the diff' }) });
export const spawned = (n, call, thread, path) => event(n, { type: 'item_completed', item: { type: 'SubAgentActivity', model: 'gpt-x',
  reasoning_effort: 'high', id: call, kind: 'started', agent_thread_id: thread, agent_path: path } });
export const brief = (n, from, to, text) => item(n, { type: 'agent_message', id: `amsg_${n}`, author: from, recipient: to,
  content: [{ type: 'input_text', text }, { type: 'encrypted_content', encrypted_content: 'opaque' }] });
export const say = (n, text) => item(n, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
export const exec = (n, call) => [item(n, { type: 'custom_tool_call', name: 'exec', call_id: call, input: 'git diff --stat' }),
  item(n, { type: 'custom_tool_call_output', call_id: call, output: '2 files changed' })];

/** Writes the session under `dir`; returns the paths and the hook options streamSession takes. */
export async function codexSession(dir, { withActivity = true } = {}) {
  const sessions = join(dir, 'sessions');
  const day = dayDir(sessions, at(0));
  await mkdir(day, { recursive: true });
  const transcript = join(day, `rollout-2026-11-19T10-00-00-${ROOT}.jsonl`);
  await writeFile(transcript, line(meta(0, ROOT, { thread_source: 'user' }))
    + line(item(0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review my branch' }] }))
    + line(spawnCall(1, CALL, 'code_review'))
    + (withActivity ? line(spawned(1, CALL, CHILD, '/root/code_review')) : '')
    + line(item(1, { type: 'function_call_output', call_id: CALL, output: JSON.stringify({ task_name: '/root/code_review' }) })));
  const file = join(dayDir(sessions, at(1)), `rollout-2026-11-19T10-00-01-${CHILD}.jsonl`);
  await writeFile(file, line(childMeta(1, CHILD, ROOT, '/root/code_review'))
    + line(event(2, { type: 'task_started' }))
    + line(item(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }))
    + line(brief(2, '/root', '/root/code_review', 'Review the diff for regressions'))
    + exec(3, 'call_exec_1').map(line).join('')
    + line(say(4, 'No regressions found'))
    + line(event(4, { type: 'task_complete' })));
  return { sessions, day, transcript, file,
    options: { host: 'codex', repo: 'fixture/repo', payload: { session_id: ROOT, transcript_path: transcript, hook_event_name: 'Stop' } } };
}
