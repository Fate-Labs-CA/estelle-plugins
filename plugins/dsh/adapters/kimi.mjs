import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// MoonshotAI/kimi-code a2afdbc7: features/externalHooks/internal/types.ts.
const EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'PermissionResult', 'UserPromptSubmit', 'UserPromptQueued', 'TurnStarted',
  'Stop', 'StopFailure', 'Interrupt', 'SessionStart', 'SessionEnd',
  'SessionHeartbeat', 'SubagentStart', 'SubagentStop', 'TaskStarted',
  'PreCompact', 'PostCompact', 'Notification',
]);
const MAX_PROMPT_PARTS = 256;
const MAX_PROMPT_CHARS = 200_000;
const MAX_INDEX_BYTES = 2_000_000;
const MAX_INDEX_LINES = 10_000;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === 'string' ? value : undefined;
}

function promptText(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    if (value.length > MAX_PROMPT_CHARS) throw new RangeError('Kimi prompt exceeds capture bound');
    return value;
  }
  if (!Array.isArray(value)) throw new TypeError('Kimi prompt must be text or content parts');
  if (value.length > MAX_PROMPT_PARTS) throw new RangeError('Kimi prompt exceeds part bound');
  const text = value.filter(part => record(part) && part.type === 'text')
    .map(part => optionalString(part.text) ?? '').join('\n');
  if (text.length > MAX_PROMPT_CHARS) throw new RangeError('Kimi prompt exceeds capture bound');
  return text;
}

export function normalize(payload) {
  if (!record(payload)) throw new TypeError('Kimi hook payload must be an object');
  const event = payload.hook_event_name;
  if (!EVENTS.has(event)) throw new TypeError('Unsupported Kimi hook event');
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) {
    throw new TypeError('Invalid Kimi session identity');
  }
  const cwd = payload.cwd;
  if (typeof cwd !== 'string' || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new TypeError('Kimi hook cwd must be an absolute local path');
  }
  const input = record(payload.tool_input) ? payload.tool_input : {};
  // Kimi uses path; shared Claude-oriented file handling expects file_path.
  const toolInput = typeof input.path === 'string' ? { ...input, file_path: input.path } : { ...input };
  return {
    host: 'kimi', event, sessionId, cwd,
    toolName: optionalString(payload.tool_name) ?? '',
    toolInput, prompt: promptText(payload.prompt),
    // Kimi does not supply a transcript path. Never trust a made-up input field.
    transcriptPath: undefined,
    title: optionalString(payload.session_title),
    toolCallId: optionalString(payload.tool_call_id),
    toolOutput: optionalString(payload.tool_output),
    agentName: optionalString(payload.agent_name),
    response: optionalString(payload.response),
    source: optionalString(payload.source),
    trigger: optionalString(payload.trigger),
    reason: optionalString(payload.reason),
  };
}

export function formatContext(text, event) {
  if (typeof text !== 'string') throw new TypeError('Kimi hook context must be text');
  // Only this event appends hook stdout to context. Other events cannot inject it.
  if (event !== 'UserPromptSubmit' || text.trim() === '') return null;
  return { message: text };
}

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

async function readIndex(file) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_INDEX_BYTES) return undefined;
    const buffer = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > metadata.size) return undefined; // Registry grew past the measured bound.
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return lines.length > MAX_INDEX_LINES ? undefined : lines;
  } finally {
    await handle.close();
  }
}

async function registryMatch(lines, sessionId, cwd) {
  let match;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!record(entry) || entry.sessionId !== sessionId || entry.workDir !== cwd) continue;
    if (typeof entry.sessionDir !== 'string' || !path.isAbsolute(entry.sessionDir)) continue;
    if (match !== undefined && match !== entry.sessionDir) return undefined;
    match = entry.sessionDir;
  }
  return match;
}

/** Resolve only this session's registered legacy wire file. No history-directory walk. */
export async function getTranscriptPath(normalized, options = {}) {
  if (!record(normalized) || normalized.host !== 'kimi') throw new TypeError('Expected normalized Kimi payload');
  const home = options.home ?? process.env.KIMI_CODE_HOME ?? path.join(homedir(), '.kimi-code');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('Kimi home must be absolute');
  try {
    const root = await realpath(home);
    const index = await realpath(path.join(root, 'session_index.jsonl'));
    if (!within(index, root)) return undefined;
    const lines = await readIndex(index);
    if (lines === undefined) return undefined;
    const directory = await registryMatch(lines, normalized.sessionId, normalized.cwd);
    if (directory === undefined) return undefined;
    const session = await realpath(directory);
    if (!within(session, path.join(root, 'sessions'))) return undefined;
    const wire = await realpath(path.join(session, 'agents', 'main', 'wire.jsonl'));
    if (!within(wire, session) || !(await stat(wire)).isFile()) return undefined;
    return wire;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}
