// Public CLI stream redaction port; see NOTICE for upstream attribution.
export const FIELD_CAP = 20_000;
const MAX_DEPTH = 24;
const MAX_FIELDS = 1_000;
const SENSITIVE_KEY = /(?:secret|token|password|api[_-]?key|private[_-]?key)/i;
export const isSensitiveField = key => SENSITIVE_KEY.test(key);
// Shapes that are a credential whatever surrounds them. Also the list the write hook warns on (credential.mjs).
export const VENDOR_PATTERNS = Object.freeze([
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted stripe key]'],
  [/\bestelle_(?:live|test)_[A-Za-z0-9_-]{8,}/g, '[redacted estelle key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted github token]'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, '[redacted API key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted slack token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted jwt]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[redacted]@'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted aws key]'],
  [/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[redacted google key]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[redacted sendgrid key]'],
]);
const PATTERNS = [
  ...VENDOR_PATTERNS,
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*["']?[^\s"']{8,}/gi, '$1=[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}=*/gi, '$1[redacted]'],
];
// Rooms proofs are opaque HMACs: their field label, not a vendor prefix, identifies them.
// Keep the delimiter so JSON snippets remain parseable after filtering. Bare values require
// 16 characters; a code identifier such as `session_token: undefined` is not a credential.
const LABELED_VALUE = /(["'`]?\b[A-Z0-9_-]{0,128}(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]{0,128}["'`]?\s*[:=]\s*)("(?:\\.|[^"\\\r\n]){8,}"|'(?:\\.|[^'\\\r\n]){8,}'|`[^`\r\n]{8,}`|[A-Za-z0-9._~+\/-]{16,}={0,2})(?=[\s,;)}\]<>]|$)/gi;

function redactLabeledValue(match, label, value) {
  if (/^["'`]?\[redacted/i.test(value)) return match;
  const quoted = ['"', "'", '`'].includes(value[0]);
  if (quoted && value.slice(1, -1).startsWith('${')) return match;
  const delimiter = quoted ? value[0] : '';
  return `${label}${delimiter}[redacted named credential]${delimiter}`;
}

/** Credential-pattern filtering, not a guarantee that arbitrary secrets are recognizable. */
export function redact(text) {
  if (typeof text !== 'string') throw new TypeError('redact expects text');
  // Normalize NULs before matching: removing them afterwards could join two fragments into
  // a recognizable credential only after the redaction pass had already finished.
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text.replaceAll('\0', ''))
    .replace(LABELED_VALUE, redactLabeledValue)
    .replace(/(\bsession[_-]token\s+is\s+)(["'`]?)[a-f0-9]{32,128}\2(?=[\s.,:;)}\]<>]|$)/gi,
      (_, label, quote) => `${label}${quote}[redacted named credential]${quote}`);
}

export function cap(text) {
  const clean = redact(text);
  const chars = Array.from(clean);
  if (chars.length <= FIELD_CAP) return clean;
  return `${chars.slice(0, FIELD_CAP).join('')}\n… [truncated: ${chars.length - FIELD_CAP} more characters not shown]`;
}

/** Bounded walk over JSON input. Redact nested strings and sensitive object values before spooling. */
export function sanitize(value, depth = 0) {
  if (depth >= MAX_DEPTH) return '[truncated: nesting limit]';
  if (typeof value === 'string') return cap(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_FIELDS).map(item => sanitize(item, depth + 1));
    if (value.length > MAX_FIELDS) out.push('[truncated: item limit]');
    return out;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_FIELDS).map(([key, item]) => [
      cap(key), SENSITIVE_KEY.test(key) && item != null ? '[redacted]' : sanitize(item, depth + 1),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}
