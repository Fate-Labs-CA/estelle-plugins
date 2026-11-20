// OpenCode keeps its sessions in its own database and names no transcript file to a plugin, so Estelle's plugin writes
// one: after each turn it reads the session's messages through OpenCode's own client and appends the parts it has not
// written yet, in Claude Code's line shape, which runtime/stream.mjs and runtime/checkpoint.mjs already read.
// Append-only, because the stream's cursor is a byte offset into this file.
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_MESSAGES = 2_000;
const MAX_PARTS = 200;
const SEED_BYTES = 8_000_000;
const SESSION_FILE = /^[A-Za-z0-9_-]{1,200}$/;

export const mirrorPath = (stateDir, sessionID) => {
  if (!SESSION_FILE.test(sessionID)) throw new Error('session_missing');
  return join(stateDir, 'transcripts', `opencode-${sessionID}.jsonl`);
};

const iso = value => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const line = (type, uuid, timestamp, message, extra = {}) => ({ type, uuid, timestamp, message, ...extra });

/** The lines one finished OpenCode message contributes. Pure: `{info, parts}` in, lines out. */
export function linesFor({ info, parts }) {
  if (!info || !['user', 'assistant'].includes(info.role) || !Array.isArray(parts)) return [];
  const at = iso(info.time?.created);
  if (!at) return [];
  const out = [];
  if (info.role === 'user') {
    for (const part of parts.slice(0, MAX_PARTS)) {
      // Synthetic parts are what plugins (Estelle's recall among them) added, not what the person typed.
      if (part?.type === 'text' && !part.synthetic && !part.ignored && part.text?.trim()) {
        out.push(line('user', part.id, at, { role: 'user', content: [{ type: 'text', text: part.text }] }));
      } else if (part?.type === 'file' && /^image\//.test(part.mime ?? '')) {
        out.push(line('user', part.id, at, { role: 'user', content: [{ type: 'image' }] }));
      }
    }
    return out;
  }
  // An assistant message is written once it has finished; a compaction summary is not the conversation.
  if (!info.time?.completed && !info.error) return [];
  const extra = info.summary === true ? { isCompactSummary: true } : {};
  for (const part of parts.slice(0, MAX_PARTS)) {
    const partAt = iso(part?.time?.start) ?? at;
    if (part?.type === 'text' && !part.synthetic && part.text?.trim()) {
      out.push(line('assistant', part.id, partAt, { role: 'assistant', content: [{ type: 'text', text: part.text }] }, extra));
    } else if (part?.type === 'reasoning' && part.text?.trim()) {
      out.push(line('assistant', part.id, partAt, { role: 'assistant', content: [{ type: 'thinking', thinking: part.text }] }, extra));
    } else if (part?.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) {
      const end = iso(part.state.time?.end) ?? partAt;
      out.push(line('assistant', `${part.id}:call`, iso(part.state.time?.start) ?? partAt, { role: 'assistant',
        content: [{ type: 'tool_use', id: part.callID, name: part.tool, input: part.state.input ?? {} }] }, extra));
      out.push(line('user', `${part.id}:result`, end, { role: 'user', content: [{ type: 'tool_result', tool_use_id: part.callID,
        is_error: part.state.status === 'error', content: String(part.state.status === 'error' ? part.state.error ?? '' : part.state.output ?? '') }] }, extra));
    }
  }
  const first = out.find(item => item.type === 'assistant');
  if (first && info.tokens) {
    first.message.model = info.modelID ?? null;
    first.message.usage = { input_tokens: info.tokens.input ?? 0, output_tokens: info.tokens.output ?? 0,
      cache_read_input_tokens: info.tokens.cache?.read ?? 0, cache_creation_input_tokens: info.tokens.cache?.write ?? 0 };
  }
  return out;
}

/** The task call in the spawner's messages that created `child`, with the task's title: OpenCode's task tool records the
 *  child as `state.metadata.sessionId` on its tool part, running or finished (packages/opencode/src/tool/task.ts,
 *  `ctx.metadata`). Null when no part names it yet. Pure: messages in, `{call, title}` out. */
export function spawningCall(messages, child) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  for (const message of list) {
    for (const part of Array.isArray(message?.parts) ? message.parts.slice(0, MAX_PARTS) : []) {
      if (part?.type !== 'tool' || part.state?.metadata?.sessionId !== child || typeof part.callID !== 'string') continue;
      const title = part.state.title ?? part.state.input?.description;
      return { call: part.callID, title: typeof title === 'string' ? title.slice(0, 90) : '' };
    }
  }
  return null;
}

async function seed(path) {
  const ids = new Set();
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return ids; throw error; }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - SEED_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    for (const text of buffer.toString('utf8').split('\n')) {
      try { const uuid = JSON.parse(text).uuid; if (typeof uuid === 'string') ids.add(uuid); } catch { /* a partial first line */ }
    }
  } finally { await handle.close(); }
  return ids;
}

/** Append what is new for this session; `written` is the caller's per-session set, seeded from the file once.
 *  `idle` marks the end of a turn, written once per finished assistant message. Returns the lines appended. */
export async function syncMirror({ messages, path, written, idle = false }) {
  if (!written.seeded) {
    for (const id of await seed(path)) written.add(id);
    written.seeded = true;
  }
  const fresh = [];
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  for (const message of list) for (const item of linesFor(message)) {
    if (!written.has(item.uuid)) { written.add(item.uuid); fresh.push(item); }
  }
  const last = list.findLast(message => message?.info?.role === 'assistant');
  const done = last?.info?.time?.completed;
  if (idle && done && !written.has(`${last.info.id}:turn-end`)) {
    written.add(`${last.info.id}:turn-end`);
    fresh.push({ type: 'system', subtype: 'turn_duration', uuid: `${last.info.id}:turn-end`, timestamp: iso(done) });
  }
  // The file exists from the session's first hook on, so a stream read before the first finished part finds it empty.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, fresh.length ? fresh.map(item => JSON.stringify(item)).join('\n') + '\n' : '', { mode: 0o600 });
  return fresh.length;
}
