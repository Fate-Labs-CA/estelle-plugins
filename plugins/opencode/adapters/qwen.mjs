// Qwen Code command hooks (packages/core/src/hooks/types.ts in @qwen-code/qwen-code 0.28.0, docs/users/features/hooks.md).
// The stdin payload is Claude Code's shape: session_id, transcript_path, cwd, hook_event_name, plus each event's fields.
export const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd',
]);
// Events whose `hookSpecificOutput.additionalContext` Qwen Code places in front of the model (hooks.md "Output").
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
// Qwen Code's built-in file tools: write_file {file_path, content} and edit {file_path, old_string, new_string}.
const TOOLS = Object.freeze({ write_file: 'Write', edit: 'Edit' });
const text = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`Qwen Code ${name} must be text`);
  return value ?? null;
};

export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Qwen Code hook input must be an object');
  const event = payload.hook_event_name;
  if (!HOOK_EVENTS.includes(event)) throw new TypeError('Unsupported Qwen Code hook event');
  for (const key of ['session_id', 'cwd']) {
    if (typeof payload[key] !== 'string' || !payload[key]) throw new TypeError(`Qwen Code ${key} is required`);
  }
  const toolName = text(payload.tool_name, 'tool_name');
  if (TOOL_EVENTS.has(event) && !toolName) throw new TypeError('Qwen Code tool_name is required for tool events');
  return {
    host: 'qwen-code', event, sessionId: payload.session_id, cwd: payload.cwd,
    transcriptPath: text(payload.transcript_path, 'transcript_path'),
    prompt: text(payload.prompt, 'prompt'),
    toolName: toolName ? TOOLS[toolName] ?? toolName : null,
    toolInput: payload.tool_input ?? null, toolResponse: payload.tool_response ?? null,
    toolUseId: text(payload.tool_use_id, 'tool_use_id'),
    agentId: text(payload.agent_id, 'agent_id'), agentType: text(payload.agent_type, 'agent_type'),
    lastAssistantMessage: text(payload.last_assistant_message, 'last_assistant_message'),
    source: text(payload.source, 'source'), permissionMode: text(payload.permission_mode, 'permission_mode'),
    model: text(payload.model, 'model'), raw: payload,
  };
}

export function formatContext(value, event) {
  if (typeof value !== 'string') throw new TypeError('Qwen Code hook context must be text');
  if (!CONTEXT_EVENTS.has(event) || !value.trim()) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: value } };
}
