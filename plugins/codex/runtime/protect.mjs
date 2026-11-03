import { isSensitiveField, redact } from './redact.mjs';

const FILE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace']);
export const toolBaseName = name => typeof name === 'string' ? name.split(/[.:]/).at(-1) : '';
export const mutatingTool = name => FILE_WRITES.has(toolBaseName(name));

// Privacy redaction deliberately hides more than a write should refuse. These source forms
// reference values at runtime; they contain no literal credential. Never waive the remaining text.
const MEMBER = /[A-Z_$][\w$]*(?:(?:\.[A-Z_$][\w$]*)|(?:\[\\*["'][A-Z_][A-Z0-9_]*\\*["']\]))+/.source;
const LABEL = /(["'`]?\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*["'`]?\s*[:=]\s*)/.source;
const CALL = String.raw`[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)*\(\s*${MEMBER}\s*\)`;
const CONTEXT_SET = String.raw`_[A-Z][A-Z0-9_]{0,126}\.set\(\s*[a-z_][a-z0-9_]{0,127}\s*\)`;
const REFERENCE = new RegExp(`${LABEL}((${CONTEXT_SET})|${MEMBER}|${CALL})` + /(?=\s|[,;)}\]]|$)/.source, 'gi');
const EMPTY_PEM = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----((?:\s|\\+[rn])*)(?:-----END \1-----)?/g;
const SOURCE_END = /^(?:\\*["'`]|\/[gimsuy]*)(?:\s|\\+[rn])*(?:[,;)}\]]|$)/;

function advanceSource(text, offset, state) {
  for (; state.scanned < offset; state.scanned++) {
    const char = text[state.scanned];
    if (state.blockComment) {
      if (char === '*' && text[state.scanned + 1] === '/') { state.blockComment = false; state.scanned++; }
      continue;
    }
    if (state.comment) { if (char === '\n') state.comment = false; continue; }
    if (state.escaped) { state.escaped = false; continue; }
    if (state.quote && char === '\\') { state.escaped = true; continue; }
    if (state.quote) { if (char === state.quote) state.quote = ''; continue; }
    if ('"\'`'.includes(char)) { state.quote = char; continue; }
    // A slash may introduce a regex or comment. Conservatively stop recognizing source
    // references on that line rather than interpreting data inside either as executable code.
    if (char === '/' && text[state.scanned + 1] === '*') { state.blockComment = true; state.scanned++; continue; }
    if (char === '#' || char === '/') { state.comment = true; continue; }
    if (char === '(') {
      if (state.calls.length >= 64 || state.overflow) { state.overflow++; continue; }
      const before = text.slice(Math.max(0, state.scanned - 256), state.scanned);
      state.calls.push(/[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)*\s*$/i.test(before));
    } else if (char === ')') {
      if (state.overflow) state.overflow--;
      else state.calls.pop();
    }
  }
}

function sourceReferences(text) {
  const state = { scanned: 0, quote: '', escaped: false, comment: false, blockComment: false, calls: [], overflow: 0 };
  return text.replace(REFERENCE, (whole, label, reference, contextSet, offset) => {
    advanceSource(text, offset, state);
    const declared = /\b(?:const|let|var)\s+$/.test(text.slice(0, offset));
    const environment = /^(?:process\.env|os\.environ)(?:\.|\[)/.test(reference);
    const callback = reference.includes('(') && !state.overflow && state.calls.at(-1) === true
      && /[,(\{]\s*$/.test(text.slice(Math.max(0, offset - 64), offset))
      && /^\s*[,)}\]]/.test(text.slice(offset + whole.length));
    // A Python ContextVar token is an opaque reset handle, not a credential literal.
    // Recognize only a complete bare assignment to this bounded, literal-free form.
    const line = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
    const contextHandle = /^_[A-Z][A-Z0-9_]{0,126}\.set\(\s*[a-z_][a-z0-9_]{0,127}\s*\)$/.test(reference)
      && /^[a-z_][a-z0-9_]*\s*=\s*$/.test(label) && /^[+ -]?[\t ]*$/.test(line)
      && /^[\t ]*(?:#[^\r\n]*)?(?:\r?\n|$)/.test(text.slice(offset + whole.length));
    const executable = contextSet ? contextHandle : declared || environment || callback;
    return !state.quote && !state.comment && !state.blockComment && executable
      && redact(reference) === reference ? `${label}0` : whole;
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
