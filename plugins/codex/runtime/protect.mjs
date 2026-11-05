import { fieldIsCredential, textHasCredential } from './credential.mjs';

const FILE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace']);
export const toolBaseName = name => typeof name === 'string' ? name.split(/[.:]/).at(-1) : '';
export const mutatingTool = name => FILE_WRITES.has(toolBaseName(name));
/** Hook matcher for hosts that fire PreToolUse on every tool; only these tools can write a file. */
export const FILE_WRITE_MATCHER = `(^|[.:])(${[...FILE_WRITES].join('|')})$`;

// Text being removed is not being written, and refusing it would stop someone deleting a leaked key.
const REMOVED_FIELDS = new Set(['old_string', 'old_str', 'oldText', 'old_text']);
const PATCH_START = /^\s*\*\*\* Begin Patch\b/;
const addedPatchLines = patch => patch.split(/\r?\n/).filter(line => /^(?:\+|\*\*\* (?:Add|Update|Move|Delete))/.test(line)).join('\n');

function credentialIn(value) {
  const pending = [{ value, depth: 0 }];
  const MAX_NODES = 10_000;
  const MAX_DEPTH = 24;
  for (let visited = 0; pending.length && visited < MAX_NODES; visited++) {
    const item = pending.pop();
    if (item.key && fieldIsCredential(item.key, item.value)) return true;
    if (typeof item.value === 'string') {
      const written = PATCH_START.test(item.value) ? addedPatchLines(item.value) : item.value;
      if (textHasCredential(written)) return true;
    } else if (item.value && typeof item.value === 'object' && item.depth < MAX_DEPTH) {
      const entries = Object.entries(item.value).filter(([key]) => !REMOVED_FIELDS.has(key));
      if (entries.length > MAX_NODES - pending.length) return null;
      for (const [key, child] of entries) {
        if (textHasCredential(key)) return true;
        pending.push({ value: child, key, depth: item.depth + 1 });
      }
    } else if (item.value && typeof item.value === 'object') {
      return null;
    }
  }
  if (pending.length) return null;
  return false;
}

/** Refuses a file write only when it contains a credential; see credential.mjs for what that means. */
export function protectWrite(normalized) {
  if (!normalized || normalized.event !== 'PreToolUse' || !mutatingTool(normalized.toolName)) return null;
  const found = credentialIn(normalized.toolInput);
  if (found === null) return { unscanned: true };
  if (!found) return null;
  const reason = 'Estelle found a credential-shaped value in this file edit. Use an environment variable or secret store instead of writing the value into source.';
  return { hookSpecificOutput: {
    ...(normalized.host === 'grok' ? {} : { hookEventName: 'PreToolUse' }),
    permissionDecision: 'deny', permissionDecisionReason: reason,
  } };
}
