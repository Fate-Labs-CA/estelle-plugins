import { isAbsolute } from 'node:path';

// OpenCode and Pi have no command-hook protocol: a hook there is a function inside the host's own process. Estelle's
// in-process plugin for each (adapters/opencode-plugin.mjs, adapters/pi-extension.mjs) writes this one envelope from
// the host's native event and hands it to `runtime/cli.mjs hook <host>`, so every field here is ours.
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// Each plugin places this text with its host's own mechanism: a system-prompt section or a session message at the
// start and at a prompt, and the tool result the model is about to read at a tool boundary.
const CONTEXT_EVENTS = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse']);

const text = (host, value, name) => {
  if (value != null && typeof value !== 'string') throw new TypeError(`${host} ${name} must be text`);
  return value ?? null;
};

/** One adapter per host: `events` maps the host's native event names to Estelle's, `tools` maps file-writing tools
 *  to the names write-warning.mjs knows, so a key written by `write` gets the same warning as one written by `Write`. */
export function envelopeAdapter({ host, events, tools }) {
  const nativeEvents = Object.freeze(Object.keys(events));
  function normalize(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError(`${host} hook input must be an object`);
    let event = events[payload.hook_event_name];
    if (!event) throw new TypeError(`Unsupported ${host} hook event`);
    if (typeof payload.session_id !== 'string' || !SESSION_ID.test(payload.session_id)) {
      throw new TypeError(`Invalid ${host} session identity`);
    }
    if (typeof payload.cwd !== 'string' || payload.cwd.includes('\0') || !isAbsolute(payload.cwd)) {
      throw new TypeError(`${host} hook cwd must be an absolute local path`);
    }
    const parent = text(host, payload.parent_session_id, 'parent_session_id');
    if (parent !== null && !SESSION_ID.test(parent)) throw new TypeError(`Invalid ${host} parent session identity`);
    if (parent && event === 'SessionStart') event = 'SubagentStart';
    const toolName = text(host, payload.tool_name, 'tool_name');
    if (TOOL_EVENTS.has(event) && !toolName) throw new TypeError(`${host} tool_name is required for tool events`);
    return {
      host, event, sessionId: payload.session_id, cwd: payload.cwd,
      transcriptPath: text(host, payload.transcript_path, 'transcript_path'),
      prompt: text(host, payload.prompt, 'prompt'),
      toolName: toolName ? tools[toolName] ?? toolName : null,
      toolInput: payload.tool_input ?? null,
      toolResponse: payload.tool_response ?? null,
      toolUseId: text(host, payload.tool_use_id, 'tool_use_id'),
      // A child session's tool calls are not the main conversation's boundary for its mail (hooks.mjs reads agentId).
      agentId: parent ? payload.session_id : null,
      model: text(host, payload.model, 'model'),
      raw: payload,
    };
  }
  /** The plugin reads `additionalContext` and places it; null where its host has no place for it. */
  function formatContext(value, event) {
    if (typeof value !== 'string') throw new TypeError(`${host} hook context must be text`);
    return CONTEXT_EVENTS.has(event) && value.trim() ? { additionalContext: value } : null;
  }
  return { HOOK_EVENTS: nativeEvents, normalize, formatContext };
}
