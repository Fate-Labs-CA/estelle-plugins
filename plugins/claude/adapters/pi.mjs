// Pi's extension events (docs/extensions.md in @earendil-works/pi-coding-agent 1.5.2), as adapters/pi-extension.mjs
// names them in the envelope.
import { envelopeAdapter } from './plugin-envelope.mjs';

export const { HOOK_EVENTS, normalize, formatContext } = envelopeAdapter({
  host: 'pi',
  events: Object.freeze({
    session_start: 'SessionStart', before_agent_start: 'UserPromptSubmit', tool_call: 'PreToolUse',
    tool_result: 'PostToolUse', agent_settled: 'Stop', session_before_compact: 'PreCompact', session_shutdown: 'SessionEnd',
  }),
  // Pi's built-in file tools: write {path, content} and edit {path, edits}.
  tools: Object.freeze({ write: 'Write', edit: 'Edit' }),
});
