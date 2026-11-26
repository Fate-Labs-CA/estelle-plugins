import path from 'node:path';

// DeepSeek Harness has no hook protocol of its own: a hook is a Cordis listener. adapters/dsh-plugin.mjs is that
// listener and writes this envelope, so every field here is ours and was read from dsh's own events, not guessed.
export const HOOK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
const EVENTS = new Set(HOOK_EVENTS);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// The events whose context dsh-plugin.mjs can place in front of the model: agent.inject and the pre-step decision.
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
// Measured from @deepseek-ai/dsh-tool-fs: lower-case names with Claude-shaped file_path/old_string/new_string fields.
const SHARED_TOOL_NAMES = new Map([['write', 'Write'], ['edit', 'Edit'], ['str_replace_editor', 'Edit']]);
/** The tools worth a process before they run. Anything else cannot write a file, so it gets no write check. */
export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor', 'apply_patch']);

const text = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`dsh ${name} must be text`);
  return value ?? null;
};

function toolArguments(value) {
  if (typeof value !== 'string') return value ?? {};
  // The session log stores arguments as the model's raw JSON text; text that is not JSON is still scanned as text.
  try { return JSON.parse(value); } catch { return { arguments: value }; }
}

export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('dsh hook input must be an object');
  const event = payload.hook_event_name;
  if (!EVENTS.has(event)) throw new TypeError('Unsupported dsh hook event');
  if (typeof payload.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.session_id)) {
    throw new TypeError('Invalid dsh session identity');
  }
  if (typeof payload.cwd !== 'string' || payload.cwd.includes('\0') || !path.isAbsolute(payload.cwd)) {
    throw new TypeError('dsh hook cwd must be an absolute local path');
  }
  const toolName = text(payload.tool_name, 'tool_name');
  if (TOOL_EVENTS.has(event) && !toolName) throw new TypeError('dsh tool_name is required for tool events');
  return {
    host: 'dsh', event, sessionId: payload.session_id, cwd: payload.cwd,
    transcriptPath: text(payload.transcript_path, 'transcript_path'),
    prompt: text(payload.prompt, 'prompt'),
    toolName: toolName ? SHARED_TOOL_NAMES.get(toolName) ?? toolName : null,
    toolInput: toolArguments(payload.tool_input),
    toolCallId: text(payload.tool_use_id, 'tool_use_id'),
    source: text(payload.source, 'source'),
    raw: payload,
  };
}

/** dsh-plugin.mjs reads `context` and turns it into one user-role message with the plugin's own source. */
export function formatContext(value, event) {
  if (typeof value !== 'string') throw new TypeError('dsh hook context must be text');
  return CONTEXT_EVENTS.has(event) && value.trim() ? { context: value } : null;
}
