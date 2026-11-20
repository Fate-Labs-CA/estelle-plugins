// Cursor native lowerCamel hooks. Transcript dialect is not assumed from its filename.
import { isAbsolute, normalize as pathNormalize } from 'node:path';
const EVENTS = Object.freeze({ sessionStart: 'SessionStart', sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop',
  preCompact: 'PreCompact', stop: 'Stop' });
export const HOOK_EVENTS = Object.freeze(Object.keys(EVENTS));
const CONTEXT_EVENTS = new Set(['SessionStart', 'PostToolUse', 'PostToolUseFailure']);
const optionalText = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`Cursor ${name} must be text`);
  return value ?? null;
};

function workspace(payload) {
  if (typeof payload.cwd === 'string' && isAbsolute(payload.cwd)) return pathNormalize(payload.cwd);
  const roots = payload.workspace_roots;
  if (!Array.isArray(roots) || roots.length !== 1 || typeof roots[0] !== 'string' || !isAbsolute(roots[0])) {
    throw new TypeError('Cursor workspace requires an explicit absolute cwd or one workspace root');
  }
  return pathNormalize(roots[0]);
}

function toolResponse(payload, event) {
  if (event !== 'PostToolUse') return null;
  if (typeof payload.tool_output !== 'string') throw new TypeError('Cursor tool_output must be JSON text');
  try { return JSON.parse(payload.tool_output); }
  catch { throw new TypeError('Cursor tool_output must be valid JSON'); }
}

export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Cursor hook input must be an object');
  const event = EVENTS[payload.hook_event_name];
  if (!event) throw new TypeError('Unsupported Cursor hook event');
  const sessionId = payload.conversation_id;
  if (typeof sessionId !== 'string' || !sessionId || (payload.session_id != null && payload.session_id !== sessionId)) {
    throw new TypeError('Cursor conversation identity is missing or disagrees with session_id');
  }
  const toolName = optionalText(payload.tool_name, 'tool_name');
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) && (!toolName || !Object.hasOwn(payload, 'tool_input'))) {
    throw new TypeError('Cursor tool events require tool_name and tool_input');
  }
  const response = toolResponse(payload, event);
  return { host: 'cursor', event, sessionId, cwd: workspace(payload),
    turnId: optionalText(payload.generation_id, 'generation_id'),
    transcriptPath: optionalText(payload.transcript_path, 'transcript_path'),
    agentTranscriptPath: optionalText(payload.agent_transcript_path, 'agent_transcript_path'),
    prompt: optionalText(payload.prompt, 'prompt'), toolName, toolInput: payload.tool_input ?? null,
    toolResponse: response, toolUseId: optionalText(payload.tool_use_id, 'tool_use_id'),
    model: optionalText(payload.model_id ?? payload.model, 'model'),
    // user_email identifies a Cursor account, never an authenticated Estelle owner.
    raw: { ...payload, tool_response: response && typeof response === 'object'
      ? { ...response, is_error: response.is_error === true || response.isError === true } : response } };
}

/** Only passive additional_context boundaries are used; stop never auto-continues the agent. */
export function formatContext(text, event) {
  if (typeof text !== 'string') throw new TypeError('Cursor hook context must be text');
  return CONTEXT_EVENTS.has(event) && text.trim() ? { additional_context: text } : null;
}

/** Cursor rejects schema-invalid successful permission responses, even for optional hooks. */
export function defaultOutput(nativeEvent) {
  if (nativeEvent === 'beforeSubmitPrompt') return { continue: true };
  if (nativeEvent === 'preToolUse' || nativeEvent === 'subagentStart') return { permission: 'allow' };
  return null;
}
