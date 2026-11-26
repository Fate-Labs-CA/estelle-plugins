// Gemini CLI command hooks (geminicli.com/docs/hooks/reference; hook runner in @google/gemini-cli 0.71.1, read and run).
// Gemini CLI names its events differently from Claude Code; this adapter renames them to the names the runtime handles.
// Every stdin payload carries session_id, transcript_path (the chat recording's file), cwd, hook_event_name and timestamp.
// Gemini CLI has no subagent hooks, so there is no SubagentStart/SubagentStop and no subagent supervision here.
const EVENTS = Object.freeze({
  SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
  AfterAgent: 'Stop', PreCompress: 'PreCompact', SessionEnd: 'SessionEnd',
});
/** The native events Estelle registers, in hooks/hooks.json. Notification, BeforeModel, AfterModel and BeforeToolSelection carry nothing it uses. */
export const HOOK_EVENTS = Object.freeze(Object.keys(EVENTS));
const NATIVE = Object.freeze(Object.fromEntries(Object.entries(EVENTS).map(([native, estelle]) => [estelle, native])));
// Where Gemini CLI takes a hook's `additionalContext`: SessionStart, BeforeAgent (this turn's prompt) and AfterTool (the tool result).
// BeforeTool's hookSpecificOutput can only rewrite tool_input, so the write warning reaches the person as `systemMessage` instead.
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// Gemini CLI's file tools: write_file {file_path, content} and replace {file_path, old_string, new_string}.
const TOOLS = Object.freeze({ write_file: 'Write', replace: 'Edit' });
const text = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`Gemini CLI ${name} must be text`);
  return value ?? null;
};

export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Gemini CLI hook input must be an object');
  const event = EVENTS[payload.hook_event_name];
  if (!event) throw new TypeError('Unsupported Gemini CLI hook event');
  for (const key of ['session_id', 'cwd']) {
    if (typeof payload[key] !== 'string' || !payload[key]) throw new TypeError(`Gemini CLI ${key} is required`);
  }
  const toolName = text(payload.tool_name, 'tool_name');
  if (TOOL_EVENTS.has(event) && !toolName) throw new TypeError('Gemini CLI tool_name is required for tool events');
  return {
    host: 'gemini-cli', event, sessionId: payload.session_id, cwd: payload.cwd,
    // Empty until the chat recording exists (the first SessionStart): no file is no transcript.
    transcriptPath: text(payload.transcript_path, 'transcript_path') || null,
    prompt: text(payload.prompt, 'prompt'),
    toolName: toolName ? TOOLS[toolName] ?? toolName : null,
    toolInput: payload.tool_input ?? null, toolResponse: payload.tool_response ?? null,
    lastAssistantMessage: text(payload.prompt_response, 'prompt_response'),
    source: text(payload.source, 'source'), raw: payload,
  };
}

export function formatContext(value, event) {
  if (typeof value !== 'string') throw new TypeError('Gemini CLI hook context must be text');
  if (!CONTEXT_EVENTS.has(event) || !value.trim()) return null;
  return { hookSpecificOutput: { hookEventName: NATIVE[event], additionalContext: value } };
}
