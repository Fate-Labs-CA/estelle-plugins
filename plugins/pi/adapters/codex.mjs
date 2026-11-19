// Native Codex hook contract: https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/hooks
export const HOOK_EVENTS = Object.freeze([
  'PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);
const CONTEXT_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart',
]);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const REQUIRED = Object.freeze({
  PreModelRequest: ['model', 'turn_id'],
  PostModelRequest: ['model', 'turn_id', 'status', 'error', 'token_usage'],
  PreToolUse: ['model', 'turn_id', 'permission_mode', 'tool_name', 'tool_input', 'tool_use_id'],
  PermissionRequest: ['model', 'turn_id', 'permission_mode', 'tool_name', 'tool_input'],
  PostToolUse: ['model', 'turn_id', 'permission_mode', 'tool_name', 'tool_input', 'tool_use_id', 'tool_response'],
  PreCompact: ['model', 'turn_id', 'trigger'],
  PostCompact: ['model', 'turn_id', 'trigger'],
  SessionStart: ['model', 'permission_mode', 'source'],
  SessionEnd: ['reason'],
  UserPromptSubmit: ['model', 'turn_id', 'permission_mode', 'prompt'],
  SubagentStart: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type'],
  SubagentStop: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type',
    'agent_transcript_path', 'last_assistant_message', 'stop_hook_active'],
  Stop: ['model', 'turn_id', 'permission_mode', 'last_assistant_message', 'stop_hook_active'],
  Interrupt: ['model', 'turn_id', 'permission_mode'],
});
const STRING_FIELDS = ['model', 'turn_id', 'permission_mode', 'tool_name', 'tool_use_id',
  'trigger', 'source', 'reason', 'prompt', 'agent_id', 'agent_type', 'last_assistant_message', 'status'];
const nullableString = (value, name) => {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${name} must be a string or null`);
};

/** Validate host identity and preserve wire fields without inventing transcript or turn IDs. */
export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Codex hook input must be an object');
  const event = payload.hook_event_name;
  if (!HOOK_EVENTS.includes(event)) throw new TypeError('Unsupported Codex hook_event_name');
  for (const key of ['session_id', 'cwd']) {
    if (typeof payload[key] !== 'string' || !payload[key]) throw new TypeError(`Codex ${key} is required`);
  }
  for (const key of ['transcript_path', ...REQUIRED[event]]) {
    if (!Object.hasOwn(payload, key)) throw new TypeError(`Codex ${key} is required for ${event}`);
  }
  for (const key of STRING_FIELDS) {
    if (Object.hasOwn(payload, key) && typeof payload[key] !== 'string') throw new TypeError(`Codex ${key} must be a string`);
  }
  nullableString(payload.transcript_path, 'transcript_path');
  if (Object.hasOwn(payload, 'agent_transcript_path')) nullableString(payload.agent_transcript_path, 'agent_transcript_path');
  if (Object.hasOwn(payload, 'error')) nullableString(payload.error, 'error');
  if (Object.hasOwn(payload, 'stop_hook_active') && typeof payload.stop_hook_active !== 'boolean') throw new TypeError('Codex stop_hook_active must be boolean');
  if (payload.permission_mode !== undefined && !PERMISSION_MODES.has(payload.permission_mode)) throw new TypeError('Unsupported Codex permission_mode');
  if (payload.trigger !== undefined && !['manual', 'auto'].includes(payload.trigger)) throw new TypeError('Unsupported Codex compact trigger');
  if (payload.source !== undefined && !['startup', 'resume', 'clear', 'compact', 'fork'].includes(payload.source)) throw new TypeError('Unsupported Codex session source');
  if (event === 'PostModelRequest' && !['completed', 'failed', 'cancelled'].includes(payload.status)) throw new TypeError('Unsupported Codex model request status');
  return normalizedFields(payload, event);
}

function normalizedFields(payload, event) {
  return {
    host: 'codex', event, sessionId: payload.session_id, turnId: payload.turn_id ?? null,
    transcriptPath: payload.transcript_path, cwd: payload.cwd, prompt: payload.prompt ?? null,
    toolName: payload.tool_name ?? null, toolInput: payload.tool_input ?? null,
    toolResponse: payload.tool_response ?? null, toolUseId: payload.tool_use_id ?? null,
    agentId: payload.agent_id ?? null, agentType: payload.agent_type ?? null,
    agentTranscriptPath: payload.agent_transcript_path ?? null,
    lastAssistantMessage: payload.last_assistant_message ?? null,
    source: payload.source ?? null, trigger: payload.trigger ?? null,
    permissionMode: payload.permission_mode ?? null, model: payload.model ?? null, raw: payload,
  };
}

/** Only native context-bearing hooks may inject. Model-request hooks are observers. */
export function formatContext(text, event, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Codex hook context must be text');
  if (!HOOK_EVENTS.includes(event)) throw new TypeError('Unsupported Codex context event');
  const replacement = Object.hasOwn(options, 'updatedMCPToolOutput');
  if (replacement && event !== 'PostToolUse') throw new TypeError('updatedMCPToolOutput requires PostToolUse');
  if (!CONTEXT_EVENTS.has(event) || (!text.trim() && !replacement)) return null;
  return { hookSpecificOutput: {
    hookEventName: event,
    ...(text.trim() ? { additionalContext: text } : {}),
    ...(replacement ? { updatedMCPToolOutput: options.updatedMCPToolOutput } : {}),
  } };
}
