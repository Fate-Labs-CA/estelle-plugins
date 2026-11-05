// Bounded conversation checkpoint client, ported from the public CLI contract.
import { open } from 'node:fs/promises';
import { redact, sanitize } from './redact.mjs';
import { cloudExecutionIdentity } from './identity.mjs';
import { safeSession, grokContentText } from './stream.mjs';
import { readKimiHistory } from './kimi-history.mjs';

export const CHECKPOINT_LIMITS = Object.freeze({
  tailBytes: 32 * 1024 * 1024, headBytes: 64 * 1024,
  records: 100_000, messages: 400, chars: 4_000, blocks: 1_000,
});
const HOSTS = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex', kimi: 'kimi-code', 'kimi-code': 'kimi-code',
  grok: 'grok', cursor: 'cursor', dsh: 'deepseek-harness', 'deepseek-harness': 'deepseek-harness' };
const INJECTED = ['<environment_context', '<user_instructions', '# AGENTS.md instructions', '<skill', '<system-reminder', '<task-notification', '<command-', '<local-command', '<turn_aborted'];
const string = value => typeof value === 'string' ? value : '';
const shortened = text => Array.from(redact(text)).slice(0, CHECKPOINT_LIMITS.chars).join('');

async function readPart(file, start, bytes) {
  const buffer = Buffer.alloc(bytes);
  let used = 0;
  const maxReads = 1024;
  for (let attempt = 0; attempt < maxReads && used < bytes; attempt++) {
    const { bytesRead } = await file.read(buffer, used, bytes - used, start + used);
    if (!bytesRead) break;
    used += bytesRead;
  }
  return buffer.subarray(0, used);
}

async function transcriptWindows(path) {
  const file = await open(path, 'r');
  try {
    const bytes = (await file.stat()).size;
    if (bytes <= CHECKPOINT_LIMITS.tailBytes) {
      const buffer = await readPart(file, 0, bytes);
      return { windows: [buffer], bytes, read: buffer.length, partial: buffer.length < bytes };
    }
    const head = await readPart(file, 0, CHECKPOINT_LIMITS.headBytes);
    const tailStart = Math.max(head.length, bytes - CHECKPOINT_LIMITS.tailBytes);
    const tail = await readPart(file, tailStart, bytes - tailStart);
    const first = tail.indexOf(10);
    return { windows: [head.subarray(0, head.lastIndexOf(10) + 1), first < 0 ? Buffer.alloc(0) : tail.subarray(first + 1)],
      bytes, read: head.length + tail.length, partial: true };
  } finally { await file.close(); }
}

function blockText(block) {
  if (['text', 'input_text', 'output_text'].includes(block?.type)) return string(block.text);
  if (['image', 'input_image', 'image_url'].includes(block?.type)) return '[image attached; image bytes omitted]';
  if (block?.type === 'tool_use') return `[tool: ${string(block.name) || '?'}]`;
  return ''; // Tool output, encrypted content, and reasoning do not belong in conversation checkpoints.
}

function messageOf(record, host, subagent) {
  if (!record || typeof record !== 'object') return null;
  if (host === 'claude-code') {
    if (!['user', 'assistant'].includes(record.type) || record.isMeta || record.isCompactSummary || (record.isSidechain && !subagent)) return null;
    return { role: record.type, ...record.message };
  }
  if (host === 'codex') {
    const item = record.type === 'response_item' ? record.payload : record;
    return item?.type === 'message' && ['user', 'assistant'].includes(item.role) ? item : null;
  }
  if (host === 'cursor') {
    // Cursor lines: {"role":"user"|"assistant","message":{"content":[...]}}; role-less control lines carry no conversation.
    return ['user', 'assistant'].includes(record.role) ? { role: record.role, content: record.message?.content ?? record.content } : null;
  }
  if (host === 'deepseek-harness') {
    // The JSONL adapters/dsh-plugin.mjs writes from session/event. Only the person's own messages are "user":
    // dsh also sends its runtime context and skill catalog as user-role messages with another source.
    if (record.type === 'user/message') return record.data?.source?.kind === 'user' ? { role: 'user', content: record.data.content } : null;
    return record.type === 'assistant/message' ? { role: 'assistant', content: record.data?.message?.content } : null;
  }
  if (host === 'grok') {
    // Inferred dialect (not verified against a live session): ACP update lines become one message fragment
    // per chunk; chat-history lines carry role/content directly. Tool output lines are not conversation.
    const update = record.params?.update ?? record.update ?? (typeof record.sessionUpdate === 'string' ? record : null);
    if (update && typeof update === 'object') {
      const kind = update.sessionUpdate;
      if (kind === 'user_message_chunk') return { role: 'user', content: grokContentText(update.content), chunk: true };
      if (kind === 'agent_message_chunk') return { role: 'assistant', content: grokContentText(update.content), chunk: true };
      return null;
    }
    return ['user', 'assistant'].includes(record.role) ? { role: record.role, content: record.content } : null;
  }
  return record.type === 'context.append_message' && ['user', 'assistant'].includes(record.message?.role) ? record.message : null;
}

function contextOf(record, host, context) {
  const meta = host === 'codex' && record.type === 'session_meta' ? record.payload : record;
  for (const [key, value] of Object.entries({ cwd: meta?.cwd, branch: meta?.gitBranch ?? meta?.git?.branch,
    client_version: meta?.version ?? meta?.cli_version, model: record.message?.model, entrypoint: meta?.entrypoint })) {
    if (context[key] === undefined && typeof value === 'string' && value) context[key] = shortened(value);
  }
}

function checkpointText(message, counters) {
  const blocks = message.content;
  if (Array.isArray(blocks) && blocks.length > CHECKPOINT_LIMITS.blocks) counters.blocks_truncated++;
  const text = (typeof blocks === 'string' ? blocks : Array.isArray(blocks)
    ? blocks.slice(0, CHECKPOINT_LIMITS.blocks).map(blockText).filter(Boolean).join('\n') : '');
  // ACP chunk fragments split mid-word; trimming each fragment would corrupt the merged turn.
  if (!text.trim() || (message.role === 'user' && INJECTED.some(prefix => text.trim().startsWith(prefix)))) return null;
  const clean = redact(message.chunk ? text : text.trim());
  if (Array.from(clean).length > CHECKPOINT_LIMITS.chars) counters.messages_truncated++;
  return { role: message.role, content: shortened(clean), ...(message.chunk ? { chunk: true } : {}) };
}

/** ACP chunk updates split one host message over many lines; merge consecutive same-role fragments. */
function mergeChunks(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged.at(-1);
    const fits = last && Array.from(last.content).length + Array.from(message.content).length <= CHECKPOINT_LIMITS.chars;
    if (fits && last.role === message.role && (last.chunk || message.chunk)) last.content += message.content;
    else merged.push(message);
    delete merged.at(-1).chunk;
  }
  return merged;
}

function parseWindow(buffer, host, subagent, messages, counters, context) {
  let end = buffer.lastIndexOf(10);
  if (end < buffer.length - 1) counters.partial_last_line = true;
  for (; end >= 0 && counters.lines < CHECKPOINT_LIMITS.records;) {
    const start = end === 0 ? 0 : buffer.lastIndexOf(10, end - 1) + 1;
    const text = buffer.subarray(start, end).toString('utf8').trim();
    end = start - 1;
    if (!text) continue;
    counters.lines++;
    let record;
    try { record = JSON.parse(text); } catch { counters.invalid_lines++; continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) { counters.unknown_lines++; continue; }
    contextOf(record, host, context);
    const message = messageOf(record, host, subagent);
    if (!message) { counters.unknown_lines++; continue; }
    counters.recognized_lines++;
    const kept = checkpointText(message, counters);
    if (!kept) continue;
    if (messages.length < CHECKPOINT_LIMITS.messages) messages.push(kept);
    else counters.turns_dropped++;
  }
  if (end >= 0) counters.record_limit_reached = true;
}

/** Read the most recent conversation, with a small head window for provenance, and disclose every cap. */
export async function readTranscriptMessages({ path, host, subagent = false }) {
  const harness = HOSTS[host];
  if (!harness) throw new Error('unsupported checkpoint host');
  const bounded = await transcriptWindows(path);
  const messages = [];
  const counters = { lines: 0, recognized_lines: 0, unknown_lines: 0, invalid_lines: 0, turns_dropped: 0,
    messages_truncated: 0, blocks_truncated: 0, record_limit_reached: false, partial_last_line: false };
  const context = {};
  // Reverse order makes message cap retain the most recent turns, while context keeps the latest fact.
  for (const window of bounded.windows.toReversed()) parseWindow(window, harness, subagent, messages, counters, context);
  messages.reverse();
  const legacy = harness === 'kimi-code';
  const inferred = harness === 'grok' || harness === 'cursor';
  if (harness === 'grok') messages.splice(0, messages.length, ...mergeChunks(messages));
  const partial = bounded.partial || legacy || inferred || counters.record_limit_reached || counters.partial_last_line || counters.turns_dropped > 0
    || counters.invalid_lines > 0 || counters.messages_truncated > 0 || counters.blocks_truncated > 0;
  if (partial && messages.length) messages[0].content = shortened(
    '[Estelle: this checkpoint is PARTIAL. Read bounds, omitted records, or text limits apply; this is not the complete session history.]\n' + messages[0].content);
  return { messages, client: { name: harness, ...context, transcript_partial: partial, transcript_bytes: bounded.bytes,
    transcript_read_bytes: bounded.read, ...(legacy ? { transcript_format: 'kimi-legacy-wire', newer_format_verified: false } : {}),
    ...(inferred ? { transcript_format: `${harness}-jsonl-inferred`, format_verified: false,
      capture_note: 'Dialect inferred from third-party observations, not verified against a live host session.' } : {}),
    ...counters } };
}

/** SessionEnd is deliberately delegated to the caller's durable reference queue, without filesystem/network work. */
export async function checkpointSession({ payload, host, repo, stateDir, request }) {
  if (cloudExecutionIdentity()) return { saved: false, unsupported: true,
    reason: 'Cloud transcript checkpoints require a private owner-bound storage door; visible event streaming remains separate.' };
  if (payload.hook_event_name === 'SessionEnd') return { saved: false, deferred: true };
  if (!safeSession(payload.session_id)) throw new Error('invalid host session identity');
  const child = payload.hook_event_name === 'SubagentStop';
  const path = child && string(payload.agent_transcript_path).trim() ? payload.agent_transcript_path : payload.transcript_path;
  if (!string(path).trim()) return { saved: false, reason: 'host did not supply a transcript path' };
  let messages, client;
  if (host === 'kimi' || host === 'kimi-code') {
    const history = await readKimiHistory({ sessionId: payload.session_id, cwd: payload.cwd });
    if (!history.available) return { saved: false, reason: history.coverage.reason, client: history.coverage };
    const selected = history.messages.slice(-CHECKPOINT_LIMITS.messages);
    messages = selected.map(message => ({ ...message, content: shortened(message.content) }));
    const capped = selected.length < history.messages.length || selected.some(message => Array.from(message.content).length > CHECKPOINT_LIMITS.chars);
    client = { name: 'kimi-code', transcript_format: history.format,
      transcript_partial: !history.coverage.complete || capped, capture_coverage: history.coverage };
    if (client.transcript_partial && messages.length) messages[0].content = shortened('[Estelle: this checkpoint is PARTIAL; inspect capture_coverage.]\n' + messages[0].content);
  } else ({ messages, client } = await readTranscriptMessages({ path, host, subagent: child }));
  if (!messages.length) return { saved: false, reason: 'no verified user or assistant messages in transcript', client };
  const id = string(payload.agent_id);
  if (child && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    const kind = string(payload.agent_type).replace(/[\[\]\r\n]/g, ' ').trim() || id;
    for (const message of messages) message.content = shortened(`[subagent: ${kind.slice(0, 100)} ${id}] ${message.content}`);
  }
  const body = { session_id: payload.session_id, messages,
    client: sanitize({ ...client, event: payload.hook_event_name, cwd: client.cwd || payload.cwd || undefined, repo }) };
  await request('/checkpoint', body);
  return { saved: true, messages: messages.length, client: body.client };
}
