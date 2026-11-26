// Hermes Agent's plugin hooks (hermes_cli/plugins.py VALID_HOOKS in hermes-agent 0.19.0), as Estelle's Hermes plugin
// (adapters/hermes_plugin.py) names them in the envelope. Each runs inside Hermes; the plugin hands it to this runner.
import { envelopeAdapter } from './plugin-envelope.mjs';

export const { HOOK_EVENTS, normalize, formatContext } = envelopeAdapter({
  host: 'hermes',
  events: Object.freeze({
    on_session_start: 'SessionStart', pre_llm_call: 'UserPromptSubmit', pre_tool_call: 'PreToolUse',
    post_tool_call: 'PostToolUse', post_llm_call: 'Stop', on_session_finalize: 'SessionEnd',
  }),
  // Hermes's built-in file tools (tools/file_tools.py): write_file {path, content} and patch {path, old_string, new_string}.
  tools: Object.freeze({ write_file: 'Write', patch: 'Edit' }),
});
