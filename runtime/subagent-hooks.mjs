// Hook-announced subagents: the hosts whose SubagentStart/SubagentStop hooks name a subagent but whose child transcript the
// plugin does not read (Cursor, Grok Build, Qwen Code, Kimi Code). Claude Code and Codex mirror the child's own transcript
// (stream-subagents.mjs, stream-codex-subagents.mjs) and never come through here.
//
// The child is its own timeline under the parent, `<parent timeline>/agent-<key>`, in the dialect the server and the
// dashboard already read for Claude Code and Codex children (`harness: 'subagent'`, `parent`, `call_id`). One subagent's
// states: unseen -> running (its SubagentStart, with the task as its title) -> ended (its SubagentStop: completed, failed
// for status `error`, cancelled for `aborted`) with the result text beside the end. What each host's hook carries is the
// limit of what is captured: the child's own tool calls are not, and a stop that names no agent and matches no started one
// is not linked (a child the plugin never saw start is not invented). Open children are remembered per host, at most
// MAX_OPEN, oldest dropped: Cursor's stop hook names no parent, and its start names the parent in `parent_conversation_id`
// (which need not be the hook's own `conversation_id`), so a stop is matched across the host's open children.
import { join } from 'node:path';
import { hash } from './io.mjs';
import { canonicalHost, timelineIdentity } from './identity.mjs';
import { cap, sanitize } from './redact.mjs';
import { LIMITS, readJson, safeSession, saveJson, sendBatch } from './stream.mjs';

export const ANNOUNCING_HOSTS = new Set(['cursor', 'grok', 'qwen-code', 'kimi']);
const MAX_OPEN = 100;
const MAX_KEY = 100;
const HOOK = { kind: 'system', id: 'estelle-hook' };
const ENDS = { completed: 'completed', error: 'failed', aborted: 'cancelled' };
const text = value => (typeof value === 'string' ? value.trim() : '');
const key = value => text(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_KEY);

/** What the hook says about the subagent: its key (the child's call id), what a stop can be matched by, its title. */
function announced(n) {
  const raw = n.raw ?? {};
  const task = text(raw.task) || text(n.prompt);
  const kind = text(n.agentType) || text(raw.subagent_type) || text(n.agentName);
  // The call that spawned it, when the host names one (the parent draws that call), else the subagent's own id.
  const own = key(raw.tool_call_id ?? n.toolCallId) || key(n.agentId ?? raw.subagent_id);
  return { id: own, match: text(n.agentId) || text(n.agentName) || task, title: (task.split('\n')[0] || kind || 'Subagent').slice(0, 90) };
}

const resultOf = n => text(n.raw?.summary) || text(n.lastAssistantMessage) || text(n.response);
const endReason = n => ENDS[text(n.raw?.status)] ?? 'completed';

/** The child a stop closes: its own id when the host names one, else the oldest started child with the same task,
    one under this session first. */
function closing(open, n) {
  const { id, match } = announced(n);
  const named = id && open.find(item => item.key === id);
  if (named) return named;
  const same = match ? open.filter(item => item.match === match) : [];
  return same.find(item => item.session === n.sessionId) ?? same[0];
}

function startEvent({ child, parent, repo, host, item, at }) {
  return { event_id: `${child}:started`, kind: 'lifecycle', author: HOOK, at,
    payload: { state: 'running', reason: 'started', title: cap(item.title), repo, origin: canonicalHost(host),
      harness: 'subagent', parent, call_id: item.key } };
}

function stopEvents({ child, n, at }) {
  const result = resultOf(n);
  return [...(result ? [{ event_id: `${child}:result`, kind: 'agent_message', author: { kind: 'agent', id: 'subagent' }, at,
    payload: { text: cap(result) } }] : []),
    { event_id: `${child}:ended`, kind: 'lifecycle', author: HOOK, at, payload: { state: 'ended', reason: endReason(n) } }];
}

async function post(request, child, events) {
  const result = await sendBatch(request, child, events.map(item => sanitize(item)));
  if (result.dropped) throw new Error('subagent event refused');
}

/** Post one SubagentStart or SubagentStop. Returns `{ sent, key? }`; `sent: 0` says why in `skipped`. */
export async function announceSubagent({ n, host, repo, stateDir, request, now = new Date() }) {
  if (!['SubagentStart', 'SubagentStop'].includes(n.event)) return { sent: 0, skipped: 'not a subagent event' };
  // Cursor names the parent on the start (`parent_conversation_id`); everywhere else the hook's session is the parent.
  const named = n.event === 'SubagentStart' ? text(n.raw?.parent_conversation_id) : '';
  const parent = timelineIdentity(host, safeSession(named) ? named : n.sessionId);
  const path = join(stateDir, `${hash(`${host}:announced`)}.announced.json`);
  const state = await readJson(path, { open: [] }, LIMITS.subagentStateBytes);
  const open = Array.isArray(state.open) ? state.open : [];
  const at = now.toISOString();
  if (n.event === 'SubagentStart') {
    const { id, match, title } = announced(n);
    const item = { key: id || key(`${match || 'agent'}-${now.getTime()}`), match, title, session: n.sessionId, parent };
    if (open.some(other => other.key === item.key && other.parent === parent)) return { sent: 0, skipped: 'already started', key: item.key };
    const child = `${parent}/agent-${item.key}`;
    await post(request, child, [startEvent({ child, parent, repo, host, item, at })]);
    await saveJson(path, { open: [...open, item].slice(-MAX_OPEN) });
    return { sent: 1, key: item.key };
  }
  const item = closing(open, n);
  if (!item) return { sent: 0, skipped: 'no started subagent matches this stop' };
  const child = `${item.parent}/agent-${item.key}`;
  const events = stopEvents({ child, n, at });
  await post(request, child, events);
  await saveJson(path, { open: open.filter(other => other !== item) });
  return { sent: events.length, key: item.key };
}
