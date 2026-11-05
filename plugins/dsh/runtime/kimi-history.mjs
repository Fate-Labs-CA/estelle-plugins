// Current Kimi wire 1.5 reader. The source contracts are pinned in docs/research/kimi-current-capture.md.
import { open } from 'node:fs/promises';
import { getTranscriptPath } from '../adapters/kimi.mjs';
import { cap, sanitize } from './redact.mjs';

export const KIMI_HISTORY_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024,
  records: 100_000, branches: 256, parts: 1_000, calls: 1_000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = value => typeof value?.type === 'string' ? value.type.replace(/^human\./, '') : '';
const timeOf = value => Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const string = value => typeof value === 'string' ? value : '';

function visibleMessage(value) {
  if (!object(value) || !['user', 'assistant', 'tool'].includes(value.role)) return null;
  const content = typeof value.content === 'string' ? [{ type: 'text', text: value.content }] : value.content;
  if (!Array.isArray(content) || content.length > KIMI_HISTORY_LIMITS.parts) return null;
  const parts = [];
  let incomplete = false;
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: cap(part.text) });
      if (Array.from(part.text).length > 20_000) incomplete = true;
    }
    if (['image_url', 'image', 'audio_url', 'video_url'].includes(part?.type)) {
      parts.push({ type: 'text', text: '[media attachment; bytes and URL omitted]' });
    }
    // Do not recover or persist encrypted, hidden, or recorded reasoning through this reader.
    if (!['text', 'think', 'image_url', 'image', 'audio_url', 'video_url'].includes(part?.type)) incomplete = true;
  }
  const calls = value.toolCalls ?? [];
  if (!Array.isArray(calls) || calls.length > KIMI_HISTORY_LIMITS.calls) return null;
  return { message: { role: value.role, content: parts,
    ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}),
    ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {}),
    ...(value.role === 'assistant' ? { toolCalls: sanitize(calls) } : {}),
  }, incomplete };
}

/** Normalize a single actual journal record without inventing its timestamp, session, or identity. */
export function normalizeKimiRecord(record) {
  if (!object(record) || !timeOf(record.time)) return null;
  const type = typeOf(record);
  if (['agent.turn.ended', 'turn.ended'].includes(type)) return { type: 'turn.ended', time: record.time };
  if (!['agent.message.appended', 'context.append_message'].includes(type)) return null;
  const wrapper = record.message;
  const raw = object(wrapper?.message) ? wrapper.message : wrapper;
  const visible = visibleMessage(raw);
  if (!visible) return null;
  const { message } = visible;
  // System injections and generated summaries are not things the person typed.
  const source = wrapper?.meta?.source;
  const origin = raw?.origin?.kind ?? wrapper?.meta?.origin?.kind;
  if (message.role === 'user' && ((source && source !== 'input') || (origin && origin !== 'user'))) return null;
  return { type: 'context.append_message', time: record.time, message,
    ...(visible.incomplete ? { capture_incomplete: true } : {}) };
}

function switchEdge(record, line) {
  if (typeOf(record) !== 'agent.switched') return null;
  if (typeof record.branch !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(record.branch)) throw new Error('invalid_branch');
  if (!object(record.base) || typeof record.base.branch !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(record.base.branch) || !Number.isSafeInteger(record.base.line) ||
      record.base.line < 0 || record.base.line >= line) throw new Error('invalid_branch_base');
  return { branch: record.branch, line, base: record.base };
}

/** Select the same branch ancestry as Kimi's wire activeChain, iteratively and with a fixed bound. */
export function activeKimiRecords(records) {
  if (!Array.isArray(records) || records.length > KIMI_HISTORY_LIMITS.records) throw new Error('record_bound');
  const segments = new Map();
  let branch = 'main';
  let from = 1;
  let base;
  for (const [index, record] of records.entries()) {
    const line = index + 1;
    const edge = switchEdge(record, line);
    if (!edge) continue;
    segments.set(branch, { from, to: line, base });
    if (segments.has(edge.branch) || segments.size >= KIMI_HISTORY_LIMITS.branches) throw new Error('branch_bound_or_duplicate');
    branch = edge.branch; from = line + 1; base = edge.base;
  }
  segments.set(branch, { from, to: records.length, base });
  const chain = [];
  const visited = new Set();
  let ceiling = records.length;
  for (let depth = 0; depth < KIMI_HISTORY_LIMITS.branches; depth++) {
    if (visited.has(branch)) throw new Error('branch_cycle');
    const segment = segments.get(branch);
    if (!segment || ceiling > segment.to || ceiling < segment.from - 1) throw new Error('unknown_branch_base');
    visited.add(branch); chain.push({ from: segment.from, to: ceiling });
    if (!segment.base) break;
    ceiling = segment.base.line; branch = segment.base.branch;
  }
  if (chain.length >= KIMI_HISTORY_LIMITS.branches) throw new Error('branch_bound');
  return chain.reverse().flatMap(segment => records.slice(segment.from - 1, segment.to)
    .filter(record => typeOf(record) !== 'agent.switched'));
}

async function readBounded(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > KIMI_HISTORY_LIMITS.bytes) return { incomplete: true, reason: 'byte_bound', fileBytes: info.size };
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) return { incomplete: true, reason: 'concurrent_growth', fileBytes: info.size };
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.lastIndexOf('\n');
    const lines = text.slice(0, end + 1).split('\n').slice(0, -1);
    if (lines.length > KIMI_HISTORY_LIMITS.records) return { incomplete: true, reason: 'record_bound', fileBytes: info.size };
    return { lines, fileBytes: info.size, incomplete: end + 1 < text.length || bytesRead < info.size };
  } finally { await file.close(); }
}

const OBSERVATION = new Set(['metadata', 'agent.turn.started', 'agent.turn.ended', 'turn.prompt', 'turn.ended',
  'turn.cancel', 'context.undo', 'context.undone', 'agent.switched', 'llm.request', 'llm.response',
  'tools.update_store', 'state.updated', 'agent.state.updated']);

/** Read this registered main agent only. It never scans other sessions, reads blobs, or writes Kimi state. */
export async function readKimiHistory({ sessionId, cwd, home }) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('invalid_session');
  const sourcePath = await getTranscriptPath({ host: 'kimi', sessionId, cwd }, { home });
  if (!sourcePath) return { available: false, coverage: { complete: false, reason: 'registered_wire_unavailable' } };
  const bounded = await readBounded(sourcePath);
  if (!bounded.lines) return { available: false, sourcePath, coverage: { complete: false, ...bounded } };
  const records = [];
  let invalid = 0;
  for (const line of bounded.lines) {
    try { const value = JSON.parse(line); if (!object(value) || typeof value.type !== 'string') invalid++; else records.push(value); }
    catch { invalid++; }
  }
  const metadata = records[0]?.type === 'metadata' ? records[0] : null;
  const version = metadata?.protocol_version ?? '1.4';
  if (typeof version !== 'string' || !/^1\.[0-5]$/.test(version)) {
    return { available: false, sourcePath, coverage: { complete: false, reason: 'unsupported_wire_version' } };
  }
  // Line numbers are part of branch identity; do not project through missing or malformed records.
  if (invalid) return { available: false, sourcePath, coverage: { complete: false, reason: 'invalid_records', invalid } };
  let active;
  try { active = activeKimiRecords(records); }
  catch { return { available: false, sourcePath, coverage: { complete: false, reason: 'invalid_branch_history' } }; }
  const lineOf = new Map(records.map((record, index) => [record, index + 1]));
  const pairedUndo = new Set(records.filter(record => typeOf(record) === 'agent.switched')
    .map(record => record.legacyUndoLine).filter(Number.isSafeInteger));
  if (active.some(record => ['context.apply_compaction', 'context.clear'].includes(typeOf(record)) ||
      (typeOf(record) === 'context.undo' && !pairedUndo.has(lineOf.get(record))))) {
    return { available: false, sourcePath, coverage: { complete: false, reason: 'unsupported_context_mutation' } };
  }
  const normalized = [];
  let unsupported = 0;
  for (const record of active) {
    const item = normalizeKimiRecord(record);
    if (item) { normalized.push(item); if (item.capture_incomplete) unsupported++; }
    else if (!OBSERVATION.has(typeOf(record))) unsupported++;
  }
  const messages = normalized.filter(record => record.type === 'context.append_message' && ['user', 'assistant'].includes(record.message.role))
    .map(record => ({ role: record.message.role, content: record.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }))
    .filter(message => message.content);
  return { available: true, sourcePath, format: `kimi-wire-${version}`, records: normalized, messages,
    coverage: { complete: !bounded.incomplete && unsupported === 0, partialLastLine: bounded.incomplete,
      fileBytes: bounded.fileBytes, recordsRead: records.length, recordsSelected: active.length, unsupported,
      scope: 'registered main-agent visible conversation and tool records; media bytes and reasoning omitted' } };
}
