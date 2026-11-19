// Claude Code subagents, each mirrored as its OWN timeline: `<parent timeline>/agent-<toolUseId>`.
//
// Claude Code writes every subagent's transcript beside the session: `<session>/subagents/agent-<id>.jsonl` plus
// `agent-<id>.meta.json`, which names the parent's Agent tool call (`toolUseId`) and the task (`description`). Keying the
// child by `toolUseId` lets the dashboard open it from the Agent call it already draws in the parent, and keeps a
// subagent's hundreds of steps out of the parent's conversation. Port of the Estelle CLI's `hook_stream_subagents.rs`,
// which the first JS port of the stream left out (0.0.13 to 0.0.20 sent no subagent timelines at all).
//
// One subagent's states: unseen -> started (its first event, with title, parent and call id) -> ended. The end is the
// host's word: the meta's `finished: true`, the subagent's own `SubagentHandback`, or a `<task-notification>` for its call
// in the parent (`failed`/`killed` -> `failed`); or its last reply called no tool and the file has been quiet for
// QUIET_MS. An ended subagent is never read again. Every bound is in LIMITS (stream.mjs) or declared below.
import { opendir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cap, sanitize } from './redact.mjs';
import { LIMITS, mapClaude, readWindow, readJson, saveJson, sendBatch, eventBatches } from './stream.mjs';

/** A subagent never seen before and untouched for longer than this is not started now. */
const ACTIVE_MS = 24 * 3600_000;
/** An assistant reply with no tool call, then this long with nothing written: finished. */
export const QUIET_MS = 120_000;
/** Task-notification statuses remembered across runs (one per background call), newest kept. */
const MAX_NOTIFIED = 200;
/** Longest Agent call id accepted into a session id and an event id. */
const MAX_CALL_ID = 100;
/** Longest value read out of a `<task-notification>` tag. */
const MAX_NOTE_TAG = 200;
const NOTE_TAG = /<(tool-use-id|status)>([^<]{1,200})<\/(?:tool-use-id|status)>/g;
const HOOK = { kind: 'system', id: 'estelle-hook' };

const safeCallId = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_CALL_ID && /^[A-Za-z0-9_-]+$/.test(id);

/** A background task (a subagent, a shell) reported back in the parent: remember `[tool-use-id, status]` in notes. */
export function noteTaskNotification(text, notes) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification') || !notes) return;
  let id = null;
  let status = 'completed';
  for (const [, tag, value] of text.matchAll(NOTE_TAG)) {
    if (tag === 'tool-use-id') id = value.slice(0, MAX_NOTE_TAG);
    else status = value.slice(0, MAX_NOTE_TAG);
  }
  if (id) (notes.notified ??= []).push([id, status]);
}

/** `<transcript minus .jsonl>/subagents`, where Claude Code writes them; null for a path that is itself a subagent's. */
export function subagentDir(transcript) {
  const name = basename(transcript);
  if (!name.endsWith('.jsonl') || name.startsWith('agent-')) return null;
  return join(transcript.slice(0, -'.jsonl'.length), 'subagents');
}

/** The newest LIMITS.subagents `agent-*.jsonl` files with their mtimes, newest first. */
async function agentFiles(dir) {
  const files = [];
  let entries = 0;
  try {
    for await (const entry of await opendir(dir)) {
      if (++entries > LIMITS.directoryEntries) break;
      if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
      const info = await stat(join(dir, entry.name)).catch(() => null);
      if (info) files.push({ name: entry.name, path: join(dir, entry.name), mtime: info.mtimeMs });
    }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, LIMITS.subagents);
}

function started(child, at, meta, parent, repo, callId) {
  const title = (typeof meta.description === 'string' && meta.description.trim() ? meta.description : 'Subagent').slice(0, 90);
  return { event_id: `${child}:started`, kind: 'lifecycle', author: HOOK, at,
    payload: { state: 'running', reason: 'started', title: cap(title), repo, origin: 'claude-code', harness: 'subagent', parent, call_id: callId } };
}

/** Track the last assistant reply: when it was, whether it called a tool, whether it handed back. */
function noteReply(st, entry) {
  if (entry?.type !== 'assistant' || typeof entry.timestamp !== 'string') return;
  const content = entry.message?.content;
  const names = Array.isArray(content) ? content.filter(b => b?.type === 'tool_use').map(b => String(b.name ?? '')) : [];
  const handedBack = names.includes('SubagentHandback');
  st.last_at = entry.timestamp;
  st.open_tool = names.length > 0 && !handedBack;
  st.handback ||= handedBack;
}

/** Map whole new lines of one subagent file, at most `maxLines` lines and (at a line boundary) `maxEvents` events. */
async function readAgent(path, st, startedEvent, maxLines, maxEvents) {
  const window = await readWindow(path, st.offset);
  if (window.oversized) return { events: [], lines: 1, offset: window.skipTo ?? st.offset };
  const out = [];
  const notes = {};
  const buffer = window.buffer;
  let from = 0;
  let lines = 0;
  while (from < buffer.length && lines < maxLines && out.length < maxEvents) {
    const end = buffer.indexOf(10, from) + 1;
    if (!end) break;
    let entry = null;
    try { entry = JSON.parse(buffer.subarray(from, end).toString('utf8')); } catch { /* counted as a line, skipped */ }
    const mapped = entry ? mapClaude(entry, window.start + from, notes, true) : [];
    if (!st.started && mapped.length) { out.push(startedEvent(mapped[0].at)); st.started = true; }
    out.push(...mapped);
    if (mapped.length) st.last_event_at = mapped.at(-1).at;
    noteReply(st, entry);
    lines++;
    from = end;
  }
  return { events: out, lines, offset: window.start + from };
}

/** One subagent's new events, the `ended` event included when the host says it is done. `st` is a fresh copy. */
async function stepAgent(file, meta, callId, ctx, st, bounds) {
  const child = `${ctx.parent}/agent-${callId}`;
  const startedEvent = at => started(child, at, meta, ctx.parent, ctx.repo, callId);
  const { events, lines, offset } = await readAgent(file.path, st, startedEvent, bounds.lines, bounds.events);
  const unread = offset < (await stat(file.path)).size;
  st.offset = offset;
  const status = ctx.notified.get(callId);
  const quiet = ctx.now - file.mtime >= QUIET_MS;
  // Never end a subagent ahead of its own unread lines.
  const done = !unread && (meta.finished === true || st.handback || status !== undefined || (quiet && !st.open_tool));
  const endAt = st.last_at ?? st.last_event_at;
  if (st.started && done && endAt) {
    const reason = ['failed', 'killed'].includes(status) ? 'failed' : 'completed';
    events.push({ event_id: `${child}:ended`, kind: 'lifecycle', author: HOOK, at: endAt, payload: { state: 'ended', reason } });
    st.done = true;
  }
  return { child, events, lines };
}

async function send(request, child, events) {
  let sent = 0;
  for (const batch of eventBatches(events.map(item => sanitize(item)))) {
    const result = await sendBatch(request, child, batch);
    sent += batch.length - result.dropped;
  }
  return sent;
}

function loadNotified(saved, fresh) {
  const merged = new Map(Array.isArray(saved) ? saved.filter(pair => Array.isArray(pair) && pair.length === 2) : []);
  for (const [id, status] of fresh) { merged.delete(id); merged.set(id, status); }
  return new Map([...merged].slice(-MAX_NOTIFIED));
}

/** Mirror every subagent's new lines. Runs after the parent's own upload; `notified` is what the parent pass just read.
    Returns `{ sent, agents, error? }`. An agent's cursor moves only after the server accepted its events. */
export async function syncSubagents({ transcript, parent, repo, stateDir, request, notified = [], now = Date.now() }) {
  try {
    return await mirror({ transcript, parent, repo, stateDir, request, notified, now });
  } catch {
    // The parent's own upload already landed; a subagent pass that cannot run says so instead of failing the hook.
    return { sent: 0, agents: 0, error: 'subagent transcripts could not be read; nothing was mirrored this run' };
  }
}

async function mirror({ transcript, parent, repo, stateDir, request, notified, now }) {
  const dir = subagentDir(transcript);
  const report = { sent: 0, agents: 0 };
  if (!dir) return report;
  const files = await agentFiles(dir);
  if (!files.length) return report;
  const statePath = join(stateDir, `${parent}.subagents.json`);
  const state = await readJson(statePath, { agents: {}, notified: [] }, LIMITS.subagentStateBytes);
  const ctx = { parent, repo, now, notified: loadNotified(state.notified, notified) };
  const agents = {};
  let lines = LIMITS.subagentLines;
  let budget = LIMITS.subagentEvents;
  for (const file of files) {
    const known = state.agents?.[file.name];
    if (known) agents[file.name] = known;
    if (known?.done || (!known && now - file.mtime > ACTIVE_MS) || lines <= 0 || budget <= 0) continue;
    const meta = await readJson(`${file.path.slice(0, -'.jsonl'.length)}.meta.json`, null, LIMITS.stateBytes).catch(() => null);
    const callId = meta?.toolUseId;
    if (!safeCallId(callId)) continue; // no parent call recorded: nothing in the parent conversation to hang it on
    const st = { offset: 0, started: false, done: false, open_tool: true, handback: false, ...known };
    try {
      const step = await stepAgent(file, meta, callId, ctx, st, { lines, events: budget });
      lines -= Math.max(1, step.lines);
      if (step.events.length) report.sent += await send(request, step.child, step.events);
      budget -= step.events.length;
      agents[file.name] = st; // only after the send landed
      report.agents++;
    } catch (error) {
      report.error = error.status ? `subagent upload refused (${error.status}); its cursor is retained` : 'a subagent transcript could not be mirrored; its cursor is retained';
      if (error.status) break;
    }
  }
  await saveJson(statePath, { agents, notified: [...ctx.notified] });
  return report;
}
