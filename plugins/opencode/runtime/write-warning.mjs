import { vendorKindIn } from './credential.mjs';
import { redact } from './redact.mjs';

// ⛔ This never refuses an edit, on any host. The founder's ruling, 2026-11-05: the hook warns. It speaks up only for an exact
// vendor key shape, and it names the file and the kind of key, never the value.
const FILE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace']);
export const toolBaseName = name => typeof name === 'string' ? name.split(/[.:]/).at(-1) : '';
export const mutatingTool = name => FILE_WRITES.has(toolBaseName(name));
/** Hook matcher for hosts that fire PreToolUse on every tool; only these tools can write a file. */
export const FILE_WRITE_MATCHER = `(^|[.:])(${[...FILE_WRITES].join('|')})$`;

// Text being removed is not being written, and warning about it would nag someone deleting a leaked key.
const REMOVED_FIELDS = new Set(['old_string', 'old_str', 'oldText', 'old_text']);
const PATCH_START = /^\s*\*\*\* Begin Patch\b/;
const addedPatchLines = patch => patch.split(/\r?\n/).filter(line => /^(?:\+|\*\*\* (?:Add|Update|Move|Delete))/.test(line)).join('\n');
const FILE_FIELDS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'filename', 'file'];
const PATCH_FILE = /^\*\*\* (?:Add|Update) File: (.+)$/m;
const MAX_FILE_CHARS = 200;

/** The first thing ``find`` reports in what a tool is writing, ``false`` for nothing, ``null`` past the traversal bound. */
export function firstFinding(value, find) {
  const pending = [{ value, depth: 0 }];
  const MAX_NODES = 10_000;
  const MAX_DEPTH = 24;
  for (let visited = 0; pending.length && visited < MAX_NODES; visited++) {
    const item = pending.pop();
    if (typeof item.value === 'string') {
      const found = find(PATCH_START.test(item.value) ? addedPatchLines(item.value) : item.value);
      if (found) return found;
    } else if (item.value && typeof item.value === 'object' && item.depth < MAX_DEPTH) {
      const entries = Object.entries(item.value).filter(([key]) => !REMOVED_FIELDS.has(key));
      if (entries.length > MAX_NODES - pending.length) return null;
      for (const [key, child] of entries) {
        const found = find(key);
        if (found) return found;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else if (item.value && typeof item.value === 'object') {
      return null;
    }
  }
  return pending.length ? null : false;
}

/** Which file this tool is writing, in the words the tool gave. A path can hold a key too, so it goes through redaction. */
function fileNamed(input) {
  let named = '';
  if (input && typeof input === 'object') {
    named = FILE_FIELDS.map(field => input[field]).find(value => typeof value === 'string' && value.trim()) ?? '';
    if (!named) {
      const patch = Object.values(input).find(value => typeof value === 'string' && PATCH_FILE.test(value));
      named = patch ? PATCH_FILE.exec(patch)[1].trim() : '';
    }
  }
  return named ? redact(named).slice(0, MAX_FILE_CHARS) : 'this file';
}

/** ``{warning, kind, file}`` when this write holds an exact vendor key shape, ``{unscanned}`` past the bound, else null. */
export function writeWarning(normalized) {
  if (!normalized || normalized.event !== 'PreToolUse' || !mutatingTool(normalized.toolName)) return null;
  const kind = firstFinding(normalized.toolInput, vendorKindIn);
  if (kind === null) return { unscanned: true };
  if (!kind) return null;
  const file = fileNamed(normalized.toolInput);
  return { kind, file, warning: `Estelle warning: ${file} now holds what looks like a real ${kind}. The edit was not blocked. `
    + "Rotate it if it's real, and keep it in an environment variable or secret store instead." };
}
