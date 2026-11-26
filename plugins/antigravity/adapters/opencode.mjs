// OpenCode's native plugin hooks (@opencode-ai/plugin 1.19.6 `Hooks`, and bus events through its `event` hook), as
// adapters/opencode-plugin.mjs names them in the envelope. `session.seen` is ours: the first time the plugin meets a
// session it did not see created (a resumed one, or one created before the plugin loaded).
import { envelopeAdapter } from './plugin-envelope.mjs';

export const { HOOK_EVENTS, normalize, formatContext } = envelopeAdapter({
  host: 'opencode',
  events: Object.freeze({
    'session.created': 'SessionStart', 'session.seen': 'SessionStart', 'chat.message': 'UserPromptSubmit',
    'tool.execute.before': 'PreToolUse', 'tool.execute.after': 'PostToolUse', 'session.idle': 'Stop',
    // ours: a CHILD session going idle (the task call it ran for is finished). The parent's idle stays `session.idle`.
    'subagent.idle': 'SubagentStop',
    'experimental.session.compacting': 'PreCompact', 'session.deleted': 'SessionEnd',
  }),
  // OpenCode's built-in file tools: write {filePath, content}, edit {filePath, oldString, newString}, apply_patch {patchText}.
  tools: Object.freeze({ write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', patch: 'apply_patch', apply_patch: 'apply_patch' }),
});
