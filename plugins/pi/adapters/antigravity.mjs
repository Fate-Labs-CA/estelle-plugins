// Google Antigravity command hooks (https://antigravity.google/docs/hooks, read 2026-11-25). One plugin serves the IDE and
// the `agy` CLI. The payload is camelCase: `conversationId`, `workspacePaths`, `transcriptPath`, `lastUserInput`, and for tool
// events `toolCall: { name, args }`. Antigravity has no prompt-submit, compaction, session-end or subagent event, so those
// parts of Estelle's runtime have no input here (docs/hosts/antigravity.md says so).
export const HOOK_EVENTS = Object.freeze(['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']);
// PreInvocation is the start of an agent run for the person's message: it is Estelle's prompt event. PostInvocation carries
// nothing Estelle needs (Stop ends the run), so it is accepted and ignored.
const EVENTS = Object.freeze({ PreInvocation: 'UserPromptSubmit', PostInvocation: 'PostInvocation' });
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// Antigravity's file-writing tools, as named in the IDE's tool list. The docs name `run_command` and `view_file` only, so
// these three are the unverified part: an unknown name just means the write warning stays quiet.
export const WRITE_TOOLS = Object.freeze({ write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit' });
export const WRITE_TOOL_MATCHER = Object.keys(WRITE_TOOLS).join('|');
const text = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`Antigravity ${name} must be text`);
  return value ?? null;
};

export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Antigravity hook input must be an object');
  // The runner passes the event it was configured for in `hook_event_name`; Antigravity's own stdin has no such field,
  // so cli.mjs reads it from the command line (see runtime/cli.mjs, `hook antigravity <Event>`).
  const native = payload.hook_event_name;
  if (!HOOK_EVENTS.includes(native)) throw new TypeError('Unsupported Antigravity hook event');
  if (typeof payload.conversationId !== 'string' || !payload.conversationId) throw new TypeError('Antigravity conversationId is required');
  const folder = Array.isArray(payload.workspacePaths) ? payload.workspacePaths.find(path => typeof path === 'string' && path) : null;
  if (!folder) throw new TypeError('Antigravity workspacePaths is required');
  const call = payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : {};
  const toolName = text(call.name, 'toolCall.name');
  if (TOOL_EVENTS.has(native) && !toolName) throw new TypeError('Antigravity toolCall.name is required for tool events');
  const failed = typeof payload.error === 'string' && payload.error !== '';
  return {
    host: 'antigravity', event: EVENTS[native] ?? native, sessionId: payload.conversationId, cwd: folder,
    transcriptPath: text(payload.transcriptPath, 'transcriptPath'),
    prompt: text(payload.lastUserInput, 'lastUserInput'),
    toolName: toolName ? WRITE_TOOLS[toolName] ?? toolName : null,
    toolInput: call.args ?? null,
    // Antigravity gives a PostToolUse hook the call and any error, never the output.
    toolResponse: failed ? { is_error: true, error: payload.error } : null,
    invocation: Number.isSafeInteger(payload.invocationNum) ? payload.invocationNum : null,
    fullyIdle: payload.fullyIdle === true, model: text(payload.modelName, 'modelName'), raw: payload,
  };
}

/** `injectSteps` is the one way to put text in front of the model, and only SessionStart and PreInvocation take it. */
export function formatContext(value, event) {
  if (typeof value !== 'string') throw new TypeError('Antigravity hook context must be text');
  if (!['SessionStart', 'UserPromptSubmit'].includes(event) || !value.trim()) return null;
  return { injectSteps: [{ systemMessage: { systemMessage: value } }] };
}

/** PreToolUse must answer with a decision (`allow` leaves Antigravity's own permission flow alone); the others take `{}`. */
export function defaultOutput(nativeEvent) {
  if (nativeEvent === 'PreToolUse') return { decision: 'allow' };
  return ['PostToolUse', 'Stop', 'PostInvocation'].includes(nativeEvent) ? {} : null;
}
