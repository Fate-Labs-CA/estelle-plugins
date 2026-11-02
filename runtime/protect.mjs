import { isSensitiveField, redact } from './redact.mjs';

const FILE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace']);
export const toolBaseName = name => typeof name === 'string' ? name.split(/[.:]/).at(-1) : '';
export const mutatingTool = name => FILE_WRITES.has(toolBaseName(name));

// Privacy redaction deliberately hides more than a write should refuse. These source forms
// reference values at runtime; they contain no literal credential. Never waive the remaining text.
const REFERENCE = /(["'`]?\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*["'`]?\s*[:=]\s*)([A-Z_$][\w$]*(?:(?:\.[A-Z_$][\w$]*)|(?:\[\\*["'][A-Z_][A-Z0-9_]*\\*["']\]))+)(?=\s|[,;)}\]]|$)/gi;
const EMPTY_PEM = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----((?:\s|\\+[rn])*)(?:-----END \1-----)?/g;
const SOURCE_END = /^(?:\\*["'`]|\/[gimsuy]*)(?:\s|\\+[rn])*(?:[,;)}\]]|$)/;

function sourceReferences(text) {
  let scanned = 0, quote = '', escaped = false;
  return text.replace(REFERENCE, (whole, label, reference, offset) => {
    for (; scanned < offset; scanned++) {
      const char = text[scanned];
      if (escaped) { escaped = false; continue; }
      if (quote && char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ''; }
      else if ('"\'`'.includes(char)) quote = char;
    }
    const declared = /\b(?:const|let|var)\s+$/.test(text.slice(0, offset));
    const environment = /^(?:process\.env|os\.environ)(?:\.|\[)/.test(reference);
    return !quote && (declared || environment) && redact(reference) === reference ? `${label}0` : whole;
  });
}

function blockingText(source) {
  const references = sourceReferences(source.replaceAll('\0', ''));
  return references.replace(EMPTY_PEM, (whole, _kind, _space, offset) => {
    const rest = references.slice(offset + whole.length);
    return !rest || SOURCE_END.test(rest) ? '' : whole;
  });
}

function credentialIn(value) {
  const pending = [{ value, depth: 0 }];
  const MAX_NODES = 10_000;
  const MAX_DEPTH = 24;
  for (let visited = 0; pending.length && visited < MAX_NODES; visited++) {
    const item = pending.pop();
    if (item.key && isSensitiveField(item.key) && (item.value === null || typeof item.value !== 'object')) {
      const labeled = JSON.stringify({ [item.key]: item.value });
      if (redact(labeled) !== labeled) return true;
    }
    if (typeof item.value === 'string') {
      const text = blockingText(item.value);
      if (redact(text) !== text) return true;
    } else if (item.value && typeof item.value === 'object' && item.depth < MAX_DEPTH) {
      const entries = Object.entries(item.value);
      if (entries.length > MAX_NODES - pending.length) return null;
      for (const [key, child] of entries) {
        if (redact(key) !== key) return true;
        pending.push({ value: child, key, depth: item.depth + 1 });
      }
    } else if (item.value && typeof item.value === 'object') {
      return null;
    }
  }
  if (pending.length) return null;
  return false;
}

/** Local credential-pattern protection; explicit source review and tests are separate. */
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
