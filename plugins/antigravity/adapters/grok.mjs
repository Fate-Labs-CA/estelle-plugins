// Native Grok Build lifecycle envelope; camelCase is authoritative.
export const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionDenied', 'Stop', 'StopFailure', 'StopCancelled', 'Notification',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd',
]);
const EVENT_NAMES = new Map(HOOK_EVENTS.flatMap(event => [
  [event, event], [event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`), event],
]));
EVENT_NAMES.set('SubagentEnd', 'SubagentStop');
EVENT_NAMES.set('subagent_end', 'SubagentStop');
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']);
const own = (value, key) => Object.hasOwn(value, key);
const field = (payload, camel, snake) => own(payload, camel) ? payload[camel] : payload[snake];
const optionalText = (value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`Grok ${name} must be text`);
  return value ?? null;
};

/** CamelCase is authoritative; current Grok adds snake_case compatibility aliases. */
export function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Grok hook input must be an object');
  const event = EVENT_NAMES.get(field(payload, 'hookEventName', 'hook_event_name'));
  if (!event) throw new TypeError('Unsupported Grok hook event');
  const sessionId = field(payload, 'sessionId', 'session_id');
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Grok session identity is required');
  if (typeof payload.cwd !== 'string' || !payload.cwd) throw new TypeError('Grok cwd is required');
  const transcriptPath = optionalText(field(payload, 'transcriptPath', 'transcript_path'), 'transcriptPath');
  const toolName = optionalText(field(payload, 'toolName', 'tool_name'), 'toolName');
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    if (!toolName) throw new TypeError('Grok toolName is required for tool events');
    if (!own(payload, 'toolInput') && !own(payload, 'tool_input')) throw new TypeError('Grok toolInput is required for tool events');
  }
  return {
    host: 'grok', event, sessionId, cwd: payload.cwd, transcriptPath,
    turnId: optionalText(payload.promptId, 'promptId'),
    workspaceRoot: optionalText(payload.workspaceRoot, 'workspaceRoot'),
    timestamp: optionalText(payload.timestamp, 'timestamp'),
    prompt: optionalText(payload.prompt, 'prompt'), toolName,
    toolInput: field(payload, 'toolInput', 'tool_input') ?? null,
    toolResponse: field(payload, 'toolResult', 'tool_response') ?? null,
    toolUseId: optionalText(field(payload, 'toolUseId', 'tool_use_id'), 'toolUseId'),
    agentId: optionalText(payload.subagentId, 'subagentId'),
    agentType: optionalText(payload.subagentType ?? payload.agentType, 'subagentType'),
    lastAssistantMessage: optionalText(payload.lastAssistantMessage, 'lastAssistantMessage'),
    source: optionalText(payload.source, 'source'), trigger: null,
    permissionMode: optionalText(field(payload, 'permissionMode', 'permission_mode'), 'permissionMode'),
    model: optionalText(payload.modelId, 'modelId'), phase: optionalText(payload.phase, 'phase'), raw: payload,
  };
}

/** Passive lifecycle and prompt hooks cannot inject. Stop context may continue the model. */
export function formatContext(text, event, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Grok hook context must be text');
  if (!HOOK_EVENTS.includes(event)) throw new TypeError('Unsupported Grok context event');
  const replacement = own(options, 'updatedMCPToolOutput');
  if (replacement && event !== 'PostToolUse') throw new TypeError('updatedMCPToolOutput requires PostToolUse');
  if (!CONTEXT_EVENTS.has(event) || (!text.trim() && !replacement)) return null;
  return { hookSpecificOutput: {
    ...(text.trim() ? { additionalContext: text } : {}),
    ...(replacement ? { updatedMCPToolOutput: options.updatedMCPToolOutput } : {}),
  } };
}
