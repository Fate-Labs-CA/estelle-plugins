// Estelle tells the main agent what its subagents need it to know (estelle#2157), and gives every subagent the same Estelle.
//
// At the PARENT's hook boundaries (UserPromptSubmit, PostToolUse, Stop) the hook asks the server one cheap question,
// `POST /session/mail {action: supervise}`, and prints the answer: at most three short lines, each naming a subagent that
// stalled or keeps failing, how long it has been quiet or what keeps failing, and the moves this host offers. The server
// says each transition ONCE (it keeps the record), reconciles the parent's children before answering, and ends the ones
// nobody finished (a deadline and a sweep on its side). Here: a bounded wait, silence on any failure, a per-session throttle
// at tool calls, and a kill switch. At Stop the line lists children still running; Claude Code and Codex show a Stop
// hook's `systemMessage` to the person, and neither lets a Stop hook add model context without blocking the stop, which this
// never does.
//
// Subagents: a subagent shares its parent's session id, so before this its start hook handed it the PARENT's identity line
// (and with it the parent's Room token). It now asks for its own: `<parent id>-agent-<its agent id>`, a valid Room member
// the server derives its owner from the parent for. See subagentIdentity.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, readJson, writeJson } from './io.mjs';
import { timelineIdentity } from './identity.mjs';

// Hosts that name a subagent's id on its own hooks AND mirror a child transcript the server can read (Claude Code, Codex).
export const SUPERVISED_HOSTS = new Set(['claude-code', 'codex']);
export const SUPERVISE_BOUNDARY = { UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop' };
// A hook never waits longer than this for the server: past it the answer is silence.
export const SUPERVISE_TIMEOUT_MS = 2_000;
// At most one ask per this long per session at tool calls; a prompt and a stop always ask.
export const TOOL_INTERVAL_MS = 20_000;
const MAX_LINES = 3;
const MAX_CHARS = 1_200;
const MAX_AGENT_ID = 60;
const TASK_READ_BYTES = 65_536;
const MAX_TASK_CHARS = 2_000;
const text = value => (typeof value === 'string' ? value.trim() : '');

export const supervisionOff = (env = process.env) => ['0', 'false', 'off', 'no'].includes(text(env.ESTELLE_SUBAGENT_SUPERVISION).toLowerCase());

// The answer, or null once `ms` has passed. The timer is cleared as soon as the answer lands: a hook process must not wait
// out a bound it did not need.
async function silent(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}

/** What the parent is told at this boundary: `{ text }` (joined lines, '' when nothing needs saying) or `{ skipped: true }`. */
export async function superviseAtBoundary(n, stateDir, request, { now = Date.now(), env = process.env } = {}) {
  const boundary = SUPERVISE_BOUNDARY[n.event];
  // A subagent's own hooks carry its agent id; the question is the main conversation's, never a child's.
  if (!boundary || n.agentId || supervisionOff(env)) return { text: '', skipped: true };
  const session = timelineIdentity(n.host, n.sessionId);
  if (boundary === 'tool') {
    const path = join(stateDir, 'supervise', `${hash(`${n.host}:${n.sessionId}`)}.json`);
    const last = await readJson(path).catch(() => null);
    if (last && typeof last.at === 'number' && now - last.at >= 0 && now - last.at < TOOL_INTERVAL_MS) return { text: '', skipped: true };
    await writeJson(path, { at: now }).catch(() => {});
  }
  let answer = null;
  try { answer = await silent(request('/session/mail', { action: 'supervise', session_id: session, boundary }), SUPERVISE_TIMEOUT_MS); }
  catch { return { text: '', skipped: true }; }
  const lines = Array.isArray(answer?.lines) ? answer.lines.filter(line => typeof line === 'string' && line.trim()).slice(0, MAX_LINES) : [];
  return { text: lines.join('\n').slice(0, MAX_CHARS) };
}

/** A subagent's own Room identity: its parent's timeline identity plus `-agent-<agent id>`. '' when the hook named no agent. */
export function subagentIdentity(n) {
  const agent = text(n.agentId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_AGENT_ID);
  return agent ? `${timelineIdentity(n.host, n.sessionId)}-agent-${agent}` : '';
}

const messageText = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => text(block?.text)).filter(Boolean).join('\n') : '');

/** The task a subagent was given: a field its start hook carries, else the first user line of its own transcript (the
    brief), when that file exists yet. '' when neither is there: the memory read then has no query and says so. */
export async function subagentTask(n) {
  const named = text(n.prompt) || text(n.raw?.task) || text(n.raw?.prompt);
  if (named) return named.slice(0, MAX_TASK_CHARS);
  const agent = text(n.agentId).replace(/[^A-Za-z0-9_-]/g, '_');
  const path = text(n.agentTranscriptPath) || (n.transcriptPath && agent
    ? join(n.transcriptPath.replace(/\.jsonl$/, ''), 'subagents', `agent-${agent}.jsonl`) : '');
  if (!path) return '';
  let file;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(TASK_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 20)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if ((entry?.type === 'user' || entry?.message?.role === 'user') && messageText(entry.message?.content)) {
        return messageText(entry.message.content).slice(0, MAX_TASK_CHARS);
      }
    }
  } catch { /* no transcript yet: no task text */ }
  finally { await file?.close().catch(() => {}); }
  return '';
}

export const SUBAGENT_TEXT = 'You are a subagent of an Estelle-connected session. You have the same Estelle as the main agent: its MCP tools '
  + '(if they are missing from your tool list, say so in your reply instead of guessing) and its memory, recalled above for your task. '
  + 'Your Room identity and session_token are the ones above, yours alone: never use, ask for or repeat your parent\'s token. '
  + 'When your task is done, hand back your result and stop; do not wait around. If you cannot make progress, or the same call '
  + 'keeps failing, say so in your reply and stop instead of retrying: Estelle tells your parent when a subagent stalls or loops.';
