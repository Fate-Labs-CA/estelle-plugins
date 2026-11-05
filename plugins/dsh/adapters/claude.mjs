export function normalize(raw) {
  return {
    host: 'claude-code', event: raw.hook_event_name, sessionId: raw.session_id,
    cwd: raw.cwd, transcriptPath: raw.transcript_path || undefined,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    toolName: raw.tool_name || '', toolInput: raw.tool_input || {},
    toolResponse: raw.tool_response, agentId: raw.agent_id, agentType: raw.agent_type,
    agentTranscriptPath: raw.agent_transcript_path, raw,
  };
}

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'SubagentStart']);
export function formatContext(text, event) {
  if (!text || !CONTEXT_EVENTS.has(event)) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
