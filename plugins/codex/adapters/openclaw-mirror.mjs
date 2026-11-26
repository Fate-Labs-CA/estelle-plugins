// OpenClaw keeps sessions in its own store and names no transcript file to a plugin, so Estelle's plugin writes one:
// at agent_end it appends the run's messages it has not written yet, in Claude Code's line shape, which
// runtime/stream.mjs and runtime/checkpoint.mjs already read (as for OpenCode and Hermes). Append-only: the stream's cursor
// is a byte offset into this file.
// ⚠ The message shape is read from OpenClaw's docs ("event.messages: the run's messages"), which name no fields. This reads
// both shapes seen in agent hosts: `content` as text or as blocks, with `toolCall`/`tool_use` blocks and `toolResult`/`tool`
// roles. Anything else is skipped, not guessed; capture is marked unverified until a live run shows the real shape.
import { appendFile, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const MAX_MESSAGES = 2_000;
const MAX_BLOCKS = 200;
const MAX_CHARS = 100_000;
const SEED_BYTES = 8_000_000;
const SESSION_FILE = /^[A-Za-z0-9_-]{1,200}$/;

export const mirrorPath = (stateDir, sessionId) => {
  if (!SESSION_FILE.test(sessionId)) throw new Error('session_missing');
  return join(stateDir, 'transcripts', `openclaw-${sessionId}.jsonl`);
};

const text = value => (typeof value === 'string' ? value : '');
const iso = value => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const blocksOf = content => (typeof content === 'string' ? [{ type: 'text', text: content }]
  : Array.isArray(content) ? content.slice(0, MAX_BLOCKS) : []);
const line = (type, uuid, timestamp, content) => ({ type, uuid, timestamp, message: { role: type, content } });
const digest = (sessionId, index, message, part) => `openclaw-${sessionId}-${index}-${createHash('sha1')
  .update(JSON.stringify(message)).digest('hex').slice(0, 12)}${part}`;

/** The lines one OpenClaw message contributes. Pure: `(sessionId, index, message, fallbackAt)` in, lines out. */
export function linesFor(sessionId, index, message, fallbackAt) {
  if (!message || typeof message !== 'object') return [];
  const at = iso(message.timestamp ?? message.createdAt ?? message.time) ?? fallbackAt;
  const id = (part = '') => text(message.id) ? `openclaw-${sessionId}-${message.id}${part}` : digest(sessionId, index, message, part);
  const role = message.role;
  if (role === 'user') {
    const body = blocksOf(message.content).filter(block => block?.type === 'text' && text(block.text).trim())
      .map(block => ({ type: 'text', text: text(block.text).slice(0, MAX_CHARS) }));
    return body.length ? [line('user', id(), at, body)] : [];
  }
  if (role === 'toolResult' || role === 'tool') {
    const output = blocksOf(message.content).map(block => text(block?.text)).filter(Boolean).join('\n').slice(0, MAX_CHARS);
    return [line('user', id(':result'), at, [{ type: 'tool_result', tool_use_id: text(message.toolCallId ?? message.tool_call_id),
      is_error: message.isError === true, content: output }])];
  }
  if (role !== 'assistant') return [];
  const out = [];
  const body = blocksOf(message.content).filter(block => block?.type === 'text' && text(block.text).trim())
    .map(block => ({ type: 'text', text: text(block.text).slice(0, MAX_CHARS) }));
  if (body.length) out.push(line('assistant', id(), at, body));
  let position = 0;
  for (const block of blocksOf(message.content)) {
    if (!['toolCall', 'tool_use'].includes(block?.type) || !text(block.name)) continue;
    const input = block.arguments ?? block.input ?? {};
    out.push(line('assistant', id(`:call${position++}`), at, [{ type: 'tool_use', id: text(block.id), name: block.name,
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : { arguments: input } }]));
  }
  return out;
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
    for (const row of buffer.toString('utf8').split('\n')) {
      try { const uuid = JSON.parse(row).uuid; if (typeof uuid === 'string') ids.add(uuid); } catch { /* a partial first line */ }
    }
  } finally { await handle.close(); }
  return ids;
}

/** Append what is new for this session; `written` is the caller's per-session set, seeded from the file once.
 *  `done` marks the end of a turn. Returns the number of lines appended. */
export async function syncMirror({ sessionId, messages, path, written, done = false, now = new Date() }) {
  if (!written.seeded) {
    for (const id of await seed(path)) written.add(id);
    written.seeded = true;
  }
  const fresh = [];
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  const stamp = now.toISOString();
  for (const [index, message] of list.entries()) for (const item of linesFor(sessionId, index, message, stamp)) {
    if (!written.has(item.uuid)) { written.add(item.uuid); fresh.push(item); }
  }
  if (done && fresh.length) {
    const end = `openclaw-${sessionId}-turn-${fresh.at(-1).uuid}`;
    written.add(end);
    fresh.push({ type: 'system', subtype: 'turn_duration', uuid: end, timestamp: stamp });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, fresh.length ? fresh.map(item => JSON.stringify(item)).join('\n') + '\n' : '', { mode: 0o600 });
  return fresh.length;
}
