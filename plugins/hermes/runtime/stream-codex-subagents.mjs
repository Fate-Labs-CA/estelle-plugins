// Codex subagents (multi-agent v2), each mirrored as its OWN timeline: `<root timeline>/agent-<spawn_agent call id>`.
//
// Codex writes a subagent as a separate rollout, `<sessions>/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`, whose
// `session_meta` names its `parent_thread_id` and, as `session_id`, the ROOT thread. The spawner's rollout records the
// link to the call: an `item_completed` `SubAgentActivity` item with `kind: "started"`, `id` = the `spawn_agent`
// call id and `agent_thread_id` = the child's thread (measured over 336 local children on Codex 0.166-0.170: every one
// linked exactly once, none by any other route). Keying the child by that call id lets the dashboard open it from the
// spawn_agent call it already draws, as it opens a Claude Code subagent from its Agent call. A subagent spawned by a
// subagent is mirrored flat under the root, as the dashboard expects (web subagents.ts `subagentRoot`).
//
// One subagent's states: spawned (its SubAgentActivity read) -> located (its rollout found and its meta matches) ->
// running (its first own event, with title, parent and call id) -> ended (its own turn ended: `task_complete` ->
// completed, `turn_aborted` -> cancelled) -> running again (`task_started` after an end: the spawner sent a follow-up,
// which Codex allows, so the end is per turn and every reopen is an explicit `resumed`). A child that was never located
// within ACTIVE_MS of its spawn is dropped. A forked child's rollout begins with the spawner's copied history: the lines
// before `subagent_history_start_ordinal` (a line index, measured on 142 forks: the line there is always the child's
// `thread_settings_applied`) are skipped. Every bound is in LIMITS (stream.mjs) or declared below.
import { opendir, stat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { cap, sanitize } from './redact.mjs';
import { LIMITS, mapCodex, readWindow, readJson, saveJson, sendBatch, eventBatches } from './stream.mjs';

/** A spawn whose rollout has not been found this long after the spawn is dropped. */
const ACTIVE_MS = 24 * 3600_000;
/** Spawns remembered per root session, newest kept. */
const MAX_AGENTS = 200;
/** Spawns one transcript pass may note. */
const MAX_SPAWNS_NOTED = 200;
/** Longest spawn call id accepted into a session id and an event id. */
const MAX_CALL_ID = 100;
/** Longest agent path kept (`/root/<task>/<task>`). */
const MAX_AGENT_PATH = 200;
/** Day directories looked in for one rollout: the spawn's local day and the days either side. */
const DAY_SPREAD = 1;
/** Bytes read for a rollout's first line; measured `session_meta` lines are about 23 KB. */
const META_BYTES = 1_000_000;
/** Largest copied-history line index a forked child may declare. */
const MAX_SKIP_LINES = 1_000_000;
const HOOK = { kind: 'system', id: 'estelle-hook' };
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}\/\d{2}\/\d{2}$/;

const safeCallId = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_CALL_ID && /^[A-Za-z0-9_-]+$/.test(id);
const string = value => typeof value === 'string' ? value : '';

/** A `SubAgentActivity` started item read in a rollout: remember `{thread, call, path, at}` in notes. */
export function noteCodexSpawn(item, at, notes) {
  if (!notes || item?.type !== 'SubAgentActivity' || item.kind !== 'started') return;
  if (!THREAD.test(string(item.agent_thread_id)) || !safeCallId(item.id)) return;
  const spawns = (notes.spawns ??= []);
  if (spawns.length >= MAX_SPAWNS_NOTED) return;
  spawns.push({ thread: item.agent_thread_id, call: item.id, path: string(item.agent_path).slice(0, MAX_AGENT_PATH), at });
}

/** `code_review` from `/root/code_review`, as words: "Code review". */
export function taskTitle(path) {
  const last = string(path).split('/').filter(Boolean).at(-1) ?? '';
  const words = last.replace(/[_-]+/g, ' ').trim();
  return words ? (words[0].toUpperCase() + words.slice(1)).slice(0, 90) : 'Subagent';
}

/** `<sessions>` from `<sessions>/YYYY/MM/DD/rollout-*.jsonl`; null for a rollout not in Codex's dated layout. */
export function sessionsRoot(transcript) {
  const day = dirname(transcript);
  const root = dirname(dirname(dirname(day)));
  return basename(transcript).startsWith('rollout-') && DAY.test(day.slice(root.length + 1).split('\\').join('/')) ? root : null;
}

function dayDirs(root, at) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return [];
  const out = [];
  for (let offset = -DAY_SPREAD; offset <= DAY_SPREAD; offset++) {
    const d = new Date(time + offset * 86_400_000);   // Codex names the directory by the machine's local date
    out.push(join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return out;
}

/** Rollout names in one day directory, at most LIMITS.directoryEntries, cached for this run. */
async function rolloutNames(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  const names = [];
  try {
    let entries = 0;
    for await (const entry of await opendir(dir)) {
      if (++entries > LIMITS.directoryEntries) break;
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) names.push(entry.name);
    }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  cache.set(dir, names);
  return names;
}

async function firstRecord(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_BYTES, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    return end < 0 ? null : JSON.parse(buffer.subarray(0, end).toString('utf8'));
  } catch { return null; } finally { await handle.close(); }
}

/** The child's rollout and what its meta says, or null when it is not (yet) on disk or is not this root's child. */
async function locate(agent, ctx) {
  const suffix = `-${agent.thread}.jsonl`;
  for (const dir of dayDirs(ctx.root, agent.at)) {
    const name = (await rolloutNames(dir, ctx.dirs)).find(n => n.endsWith(suffix));
    if (!name) continue;
    const meta = (await firstRecord(join(dir, name)))?.payload;
    if (meta?.id !== agent.thread || meta.session_id !== ctx.session || !THREAD.test(string(meta.parent_thread_id))) return null;
    const ordinal = meta.forked_from_id ? meta.subagent_history_start_ordinal : 0;
    const skip = Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal <= MAX_SKIP_LINES ? ordinal : 0;
    return { file: join(dir, name), skip, path: string(meta.agent_path).slice(0, MAX_AGENT_PATH) || agent.path };
  }
  return null;
}

function started(child, at, agent, ctx) {
  return { event_id: `${child}:started`, kind: 'lifecycle', author: HOOK, at,
    payload: { state: 'running', reason: 'started', title: cap(taskTitle(agent.path)), repo: ctx.repo, origin: 'codex',
      harness: 'subagent', parent: ctx.parent, call_id: agent.call, ...(agent.path ? { agent_path: agent.path } : {}) } };
}

const lifecycle = (event_id, at, state, reason) => ({ event_id, kind: 'lifecycle', author: HOOK, at, payload: { state, reason } });

/** One child record in its own timeline: its turn boundaries become its lifecycle, a message from another agent is a
    brief to it, and everything it does is the subagent's. */
function childEvents(record, offset, agent, child, st, notes) {
  if (record?.type === 'event_msg' && typeof record.timestamp === 'string') {
    const kind = record.payload?.type;
    if (kind === 'task_started' && st.ended) { st.ended = false; return [lifecycle(`${child}:resumed:${offset}`, record.timestamp, 'running', 'resumed')]; }
    if (kind === 'task_complete' || kind === 'turn_aborted') {
      if (!st.started || st.ended) return [];
      st.ended = true;
      return [lifecycle(`${child}:ended:${offset}`, record.timestamp, 'ended', kind === 'task_complete' ? 'completed' : 'cancelled')];
    }
  }
  const item = record?.payload;
  if (record?.type === 'response_item' && item?.type === 'agent_message' && string(item.author) !== agent.path) {
    const mapped = mapCodex(record, offset, notes);
    return mapped.map(e => ({ ...e, author: { kind: 'agent', id: 'codex' },
      payload: { text: e.payload.text, brief_to_subagent: true, ...(item.author ? { from: cap(string(item.author)) } : {}) } }));
  }
  return mapCodex(record, offset, notes).filter(e => e.kind !== 'lifecycle')
    .map(e => e.author?.kind === 'agent' || e.author?.kind === 'estelle' ? { ...e, author: { ...e.author, id: 'subagent' } } : e);
}

/** Map whole new lines of one child rollout, at most `maxLines` lines and (at a line boundary) `maxEvents` events. */
async function readChild(agent, st, child, ctx, bounds) {
  const window = await readWindow(st.file, st.offset);
  if (window.oversized) return { events: [], spawns: [], lines: 1, offset: window.skipTo ?? st.offset, line: st.line + (window.skipTo ? 1 : 0) };
  const out = [];
  const notes = { repository: ctx.repo };
  const buffer = window.buffer;
  let from = 0;
  let lines = 0;
  let line = st.line;
  while (from < buffer.length && lines < bounds.lines && out.length < bounds.events) {
    const end = buffer.indexOf(10, from) + 1;
    if (!end) break;
    if (line >= st.skip) {
      let record = null;
      try { record = JSON.parse(buffer.subarray(from, end).toString('utf8')); } catch { /* counted as a line, skipped */ }
      const mapped = record ? childEvents(record, window.start + from, agent, child, st, notes) : [];
      if (!st.started && mapped.length) { out.push(started(child, mapped[0].at, agent, ctx)); st.started = true; }
      out.push(...mapped);   // mapCodex notes a grandchild's SubAgentActivity into notes.spawns
    }
    lines++;
    line++;
    from = end;
  }
  return { events: out, spawns: notes.spawns ?? [], lines, offset: window.start + from, line };
}

async function send(request, child, events) {
  let sent = 0;
  for (const batch of eventBatches(events.map(item => sanitize(item)))) {
    const result = await sendBatch(request, child, batch);
    sent += batch.length - result.dropped;
  }
  return sent;
}

function merge(saved, spawns) {
  const agents = { ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
  for (const spawn of spawns) {
    if (!THREAD.test(string(spawn?.thread)) || !safeCallId(spawn.call) || agents[spawn.thread]) continue;
    agents[spawn.thread] = { call: spawn.call, path: string(spawn.path).slice(0, MAX_AGENT_PATH), at: string(spawn.at) };
  }
  const newest = Object.entries(agents).sort(([, a], [, b]) => string(b.at).localeCompare(string(a.at))).slice(0, MAX_AGENTS);
  return Object.fromEntries(newest);
}

/** Mirror every Codex subagent's new lines. Runs after the root's own upload; `spawns` is what that pass just read.
    Returns `{ sent, agents, waiting, error? }`. A child's cursor moves only after the server accepted its events. */
export async function syncCodexSubagents({ transcript, session, parent, repo, stateDir, request, spawns = [], now = Date.now() }) {
  try {
    return await mirror({ transcript, session, parent, repo, stateDir, request, spawns, now });
  } catch {
    return { sent: 0, agents: 0, error: 'Codex subagent rollouts could not be read; nothing was mirrored this run' };
  }
}

async function mirror({ transcript, session, parent, repo, stateDir, request, spawns, now }) {
  const report = { sent: 0, agents: 0, waiting: 0 };
  const root = sessionsRoot(transcript);
  if (!root || !THREAD.test(string(session))) return report;
  const statePath = join(stateDir, `${parent}.codex-subagents.json`);
  const state = await readJson(statePath, { agents: {} }, LIMITS.subagentStateBytes);
  if (!spawns.length && !Object.keys(state.agents ?? {}).length) return report;
  const agents = merge(state.agents, spawns);
  await saveJson(statePath, { agents });   // a spawn the root pass read is kept even if a child below cannot be mirrored
  const ctx = { root, session, parent, repo, dirs: new Map() };
  let lines = LIMITS.subagentLines;
  let budget = LIMITS.subagentEvents;
  let visited = 0;
  for (const [thread, known] of Object.entries(agents)) {
    if (lines <= 0 || budget <= 0 || visited >= LIMITS.subagents) break;
    const agent = { thread, ...known };
    const st = { offset: 0, line: 0, skip: 0, started: false, ended: false, ...known };
    if (!st.file) {
      const found = await locate(agent, ctx);
      if (!found) {
        if (now - Date.parse(agent.at) > ACTIVE_MS || !Number.isFinite(Date.parse(agent.at))) delete agents[thread];
        else report.waiting++;
        continue;
      }
      Object.assign(st, found);
      agent.path = found.path;
      agents[thread] = { ...known, ...found };   // located once; its cursor starts at 0 until a send lands
    }
    const info = await stat(st.file).catch(() => null);
    if (!info || st.offset >= info.size) continue;
    visited++;
    const child = `${parent}/agent-${agent.call}`;
    try {
      const step = await readChild(agent, st, child, ctx, { lines, events: budget });
      lines -= Math.max(1, step.lines);
      if (step.events.length) report.sent += await send(request, child, step.events);
      budget -= step.events.length;
      Object.assign(st, { offset: step.offset, line: step.line });
      agents[thread] = { ...st, path: agent.path };   // only after the send landed
      // A subagent spawned by this one is mirrored flat under the root, keyed by its own spawn call.
      for (const [id, spawn] of Object.entries(merge({}, step.spawns))) agents[id] ??= spawn;
      report.agents++;
    } catch (error) {
      report.error = error.status ? `Codex subagent upload refused (${error.status}); its cursor is retained` : 'a Codex subagent rollout could not be mirrored; its cursor is retained';
      if (error.status) break;
    }
  }
  await saveJson(statePath, { agents: merge(agents, []) });
  return report;
}
