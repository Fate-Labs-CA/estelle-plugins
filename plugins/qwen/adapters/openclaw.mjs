// OpenClaw's typed plugin hooks (docs/plugins/hooks in openclaw 2026.11.10), as adapters/openclaw-plugin.mjs names them in
// the envelope. OpenClaw runs plugins in its own process, so the plugin hands each event to the shared runner.
import { envelopeAdapter } from './plugin-envelope.mjs';

export const { HOOK_EVENTS, normalize, formatContext } = envelopeAdapter({
  host: 'openclaw',
  events: Object.freeze({
    session_start: 'SessionStart', before_prompt_build: 'UserPromptSubmit', before_tool_call: 'PreToolUse',
    after_tool_call: 'PostToolUse', agent_end: 'Stop', before_compaction: 'PreCompact', session_end: 'SessionEnd',
  }),
  // OpenClaw's file-writing tools: write {path, content}, edit {path, ...} and apply_patch {input}; names are the host's own.
  tools: Object.freeze({ write: 'Write', edit: 'Edit', apply_patch: 'apply_patch' }),
});
