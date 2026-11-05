// What a file write may not contain. One owner, separate from privacy redaction on purpose.
//
// redact.mjs hides too much by design: over-hiding a log line costs nothing. A write refusal stops
// someone's work, so it needs evidence of a VALUE. A NAME that merely sounds secret is not evidence,
// and ML code is full of them. This file answers one question: is a credential literal being written?
import { VENDOR_PATTERNS } from './redact.mjs';

const MIN_LITERAL = 8;
const MIN_OPAQUE = 20;
const MIN_HEX = 32;
const MIN_OPAQUE_SEGMENT = 16;
const MIN_OPAQUE_DIGITS = 2;
const MIN_ENTROPY_LENGTH = 24;
const MIN_ENTROPY_BITS = 4.2;
const MAX_ENTROPY_SEPARATORS = 2;
const MAX_VALUE_SCAN = 4096;
const MAX_EXPRESSION_SCAN = 512;
const MAX_LINE_LOOKBACK = 64;
const MAX_LABEL_PART = 128;
const MAX_TEMPLATE_REMAINDER = 3;

// A label is found by its credential word; the words around it decide how much evidence it needs.
const LABEL = new RegExp(String.raw`(?<![\w$-])[\w$-]{0,${MAX_LABEL_PART}}`
  + String.raw`(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|private[_-]?key)[\w$-]{0,${MAX_LABEL_PART}}`, 'gi');
const CREDENTIAL_WORD = /(?:secrets?|tokens?|passw(?:or)?d|passphrase|apikey|privatekey)$/;
const COUNT_LIKE_NEIGHBOURS = new Set(['max', 'min', 'num', 'n', 'total', 'input', 'output', 'prompt', 'completion',
  'cached', 'cache', 'reasoning', 'bos', 'eos', 'pad', 'unk', 'sep', 'cls', 'mask', 'start', 'end', 'stop', 'special',
  'next', 'prev', 'previous', 'last', 'first', 'current', 'page', 'continuation', 'lexer', 'parser', 'word', 'char']);
const DESCRIPTOR_ENDINGS = new Set(['env', 'envvar', 'var', 'variable', 'name', 'names', 'url', 'uri', 'endpoint', 'path',
  'file', 'header', 'field', 'param', 'parameter', 'prefix', 'suffix', 'pattern', 'regex', 'type', 'kind', 'count',
  'counts', 'id', 'ids', 'len', 'length', 'limit', 'budget', 'usage', 'size', 'index', 'idx', 'ttl', 'expiry', 'expires',
  'expiration', 'lifetime', 'timeout', 'scope', 'scopes', 'audience', 'issuer', 'provider', 'manager', 'store', 'policy',
  'label', 'description', 'desc', 'help', 'hint', 'placeholder', 'format', 'digest', 'hash', 'hashed', 'version',
  'revision', 'rev', 'schema', 'class']);
const CREDENTIAL_PLURAL_PREFIXES = /^(?:auth|access|refresh|bearer|session|api|id|oauth|csrf|jwt)/;

const PLACEHOLDER_MARKERS = new Set(['test', 'testing', 'tests', 'example', 'examples', 'sample', 'dummy', 'fake', 'mock',
  'placeholder', 'changeme', 'your', 'foo', 'bar', 'baz', 'qux', 'redacted', 'todo', 'fixture', 'stub', 'invalid',
  'notreal', 'nonexistent']);
const PLACEHOLDER_WORDS = new Set([...PLACEHOLDER_MARKERS, 'change', 'me', 'my', 'here', 'insert', 'replace', 'put', 'enter',
  'not', 'a', 'an', 'real', 'secret', 'token', 'key', 'api', 'apikey', 'password', 'pass', 'value', 'string', 'client', 'user',
  'auth', 'access', 'the', 'for', 'only', 'local', 'dev', 'unit', 'wrong', 'bad', 'good', 'correct', 'valid', 'expired',
  'revoked', 'none', 'null']);
const KEYWORD_VALUES = new Set(['required', 'optional', 'redacted', 'disabled', 'enabled', 'hidden', 'masked', 'unknown',
  'provided', 'undefined', 'password', 'username']);
const PROSE_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'for', 'to', 'your', 'not', 'missing', 'invalid', 'enter',
  'please', 'must', 'be', 'required', 'provide', 'set', 'no', 'with', 'and', 'or', 'in', 'this', 'that', 'can', 'cannot',
  'failed', 'expired', 'use', 'using', 'used']);
// The two example keys AWS prints in its own documentation; nothing else with this shape is waived.
const EXACT_VENDOR_EXAMPLES = new Set(['AKIA', 'ASIA'].map(prefix => `${prefix}IOSFODNN7EXAMPLE`));
const STORE_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\b|System\.getenv|ENV\[|env\[|Deno\.env|std::env|env::var|secrets\.|vault\.)/;
const TEMPLATES = /\$\{\{[^}]*\}\}|\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|\$[A-Za-z_]\w*|%\([^)]*\)[sd]|%[A-Za-z_]\w*%|%[sd]|\{[A-Za-z_][\w.]*\}|<[^<>\n]*>|\[[A-Za-z_][\w -]*\]/g;
const STORE_LOCATOR = /^(?:op|vault|ssm|secretsmanager|gcp-secret|azure-keyvault|ref\+[a-z]+):|^arn:aws:(?:secretsmanager|ssm):|^ENC\[/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*_?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE)$/;
const EMPTY_PEM = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----((?:\s|\\+[rn])*)(?:-----END \1-----)?/g;
const SOURCE_END = /^(?:\\*["'`]|\/[gimsuy]*)(?:\s|\\+[rn])*(?:[,;)}\]]|$)/;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]{8,}=*)/gi;
const NAMED_HEX = /\bsession[_-]token\s+is\s+["'`]?[a-f0-9]{32,128}/i;
// Any scheme with a userinfo password. The vendor list only knows one database scheme.
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`]{0,128}:([^\s@/'"`]{3,256})@/gi;
const PORT_ONLY = /^\d{1,5}$/;
const COMMON_URL_WORDS = /^(?:password|pass|postgres|secret)$/i;
const YAML_LINE_START = /^[+\- \t]*$/;
const YAML_LINE_END = /[ \t]*(?:#[^\n]*)?(?:\r?\n|$)/y;
const CLOSES_OBJECT = /\s*[}\])]/y;
const CONTAINS_CREDENTIAL_WORD = /secret|token|passw|passphrase|key/;
const QUOTED_VALUE_ON_NEXT_LINE = /\s*/y;
const SAME_LINE_GAP = /[ \t]*/y;
const OPERATOR = /\\*["'`]?\s*(:=|=>|=(?![=~])|:(?!:))/y;
const QUOTE_OPEN = /([frbuFRBU]{0,2})(\\*)(["'`])/y;
const BARE_VALUE = /[^\s,;)}\]"'`]{1,512}/y;
// A type hint can sit between the name and the value, in Python and TypeScript annotations alike.
const TYPE_THEN_ASSIGN = /[A-Za-z_][\w.]*(?:\[[^\]\n]{0,128}\])?(?:\s*\|\s*[A-Za-z_][\w.]*(?:\[[^\]\n]{0,64}\])?){0,4}\??\s*=(?![=~>])[ \t]*/y;
const TYPE_NAME = /^[A-Z][\w.]*(?:\[.*)?$|^(?:str|string|bytes|int|bool|number|any|object|None|null|undefined)(?:\[.*)?\??$/;
const REGEX_LITERAL = /^\/(?=[^/]*[|^$*+?\\])[^/\n]+\/[dgimsuvy]*$/;

const matchAt = (pattern, text, index) => { pattern.lastIndex = index; return pattern.exec(text); };
const wordsOf = label => label.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function joinTwoPartNames(words) {
  const joined = [];
  for (let i = 0; i < words.length; i++) {
    const pair = `${words[i]}${words[i + 1] ?? ''}`;
    if (pair === 'apikey' || pair === 'privatekey') { joined.push(pair); i++; } else joined.push(words[i]);
  }
  return joined;
}

/** 'none' never refuses on its own; 'weak' needs an opaque value; 'strong' refuses any real-looking literal. */
export function labelStrength(label) {
  const words = joinTwoPartNames(wordsOf(label));
  const at = words.findIndex(word => CREDENTIAL_WORD.test(word));
  if (at < 0) return 'none';
  const word = words[at];
  if (DESCRIPTOR_ENDINGS.has(words.at(-1)) && words.length > 1) return 'weak';
  if (!word.endsWith('tokens') && !/token$/.test(word)) return 'strong';
  const before = words[at - 1];
  if (word.endsWith('tokens')) {
    const authPrefix = CREDENTIAL_PLURAL_PREFIXES.test(before ?? '') || CREDENTIAL_PLURAL_PREFIXES.test(word.replace(/tokens$/, ''));
    return authPrefix ? 'strong' : 'weak';
  }
  return COUNT_LIKE_NEIGHBOURS.has(before) ? 'weak' : 'strong';
}

function shannonBits(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Random-looking: the shape of a generated value rather than of a name, path, URL or sentence. */
export function isOpaque(value) {
  if (value.length < MIN_OPAQUE || /:\/\//.test(value) || !/^[\w\-./:=+~]+$/.test(value)) return false;
  const hex = new RegExp(`^[a-fA-F0-9]{${MIN_HEX},}$`);
  if (hex.test(value)) return true;
  const segments = value.split(/[-_./:=+]/);
  for (const segment of segments) {
    if (hex.test(segment)) return true;
    const digits = segment.replace(/\D/g, '').length;
    if (segment.length >= MIN_OPAQUE_SEGMENT && digits >= MIN_OPAQUE_DIGITS && digits < segment.length) return true;
  }
  return value.length >= MIN_ENTROPY_LENGTH && segments.length - 1 <= MAX_ENTROPY_SEPARATORS
    && shannonBits(value) >= MIN_ENTROPY_BITS;
}

const isTemplate = body => STORE_LOCATOR.test(body) || body.replace(TEMPLATES, '').trim().length <= MAX_TEMPLATE_REMAINDER;
const isRepeatedMask = body => /^(.)\1*$/.test(body) && /^[xX*.\-#•]/.test(body);

function isPlaceholder(body) {
  if (isRepeatedMask(body)) return true;
  const words = body.toLowerCase().split(/[^a-z0-9]+/).flatMap(word => word.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)).filter(Boolean);
  if (!words.length) return false;
  let marked = false;
  for (const word of words) {
    if (/^\d{1,4}$/.test(word) || /^x{3,}$/.test(word)) continue;
    const glued = [...PLACEHOLDER_MARKERS].find(marker => word.startsWith(marker) && PLACEHOLDER_WORDS.has(word.slice(marker.length)));
    if (PLACEHOLDER_MARKERS.has(word) || glued) { marked = true; continue; }
    if (!PLACEHOLDER_WORDS.has(word)) return false;
  }
  return marked;
}

function isProse(body) {
  const words = body.trim().split(/\s+/);
  if (words.length < 2 || !words.every(word => /^[A-Za-z][A-Za-z'-]*[.,:;!?)]?$/.test(word))) return false;
  return words.some(word => PROSE_WORDS.has(word.toLowerCase().replace(/[.,:;!?)]$/, '')));
}

/** Does this literal, assigned to a label of this strength, hold a credential? */
function literalIsCredential(body, strength) {
  if (strength === 'none' || isTemplate(body) || isPlaceholder(body)) return false;
  if (strength === 'weak') return isOpaque(body);
  if (body.length < MIN_LITERAL || KEYWORD_VALUES.has(body.toLowerCase())) return false;
  return !isProse(body) && !ENV_NAME.test(body);
}

function closingQuote(text, from, quote, escapes) {
  const end = Math.min(text.length, from + MAX_VALUE_SCAN);
  for (let i = from; i < end; i++) {
    const char = text[i];
    if (char === '\n' && quote !== '`') return i;
    if (char === '\\' && escapes === 0) { i++; continue; }
    if (char !== quote) continue;
    if (escapes === 0) return i;
    let run = 0;
    while (run <= escapes && text[i - run - 1] === '\\') run++;
    if (run >= escapes) return i - escapes;
  }
  return end;
}

function readValue(text, start) {
  const open = matchAt(QUOTE_OPEN, text, start);
  if (open) {
    const from = start + open[0].length;
    const close = closingQuote(text, from, open[3], open[2].length);
    return { quoted: true, body: text.slice(from, close), after: close + open[2].length + 1 };
  }
  const bare = matchAt(BARE_VALUE, text, start);
  return { quoted: false, body: bare ? bare[0] : '', after: start + (bare ? bare[0].length : 0) };
}

/** Walk the rest of one expression: a reference followed by an opaque literal is still a literal. */
function expressionHoldsOpaqueLiteral(text, from) {
  let depth = 0;
  const end = Math.min(text.length, from + MAX_EXPRESSION_SCAN);
  for (let i = from; i < end; i++) {
    const char = text[i];
    if (char === '\n' || (depth === 0 && (char === ',' || char === ';'))) return false;
    if ('([{'.includes(char)) depth++;
    if (')]}'.includes(char) && --depth < 0) return false;
    if (!'"\'`'.includes(char)) continue;
    const close = closingQuote(text, i + 1, char, 0);
    const body = text.slice(i + 1, close);
    if (isOpaque(body) && !isTemplate(body) && !isPlaceholder(body) && !ENV_NAME.test(body)) return true;
    i = close;
  }
  return false;
}

/** An all-caps name assigned with no spaces at the start of a line, or a long command-line flag:
 *  an env file or shell line, where a bare value cannot be a variable. */
function isDeclarationForm(text, label, labelStart, operatorText) {
  if (operatorText !== '=') return false;
  if (label.startsWith('--')) return true;
  if (label !== label.toUpperCase() || !/[A-Z]/.test(label)) return false;
  const prefix = lineBefore(text, labelStart);
  return prefix !== null && /^[+\- \t]*(?:export[ \t]+|set[ \t]+)?$/.test(prefix);
}

/** What precedes a position on its line, or null when that line is longer than the lookback. */
function lineBefore(text, position) {
  const before = text.slice(Math.max(0, position - MAX_LINE_LOOKBACK), position);
  const newline = before.lastIndexOf('\n');
  if (newline < 0 && position > before.length) return null;
  return before.slice(newline + 1);
}

/** A key and one lowercase word alone on a line: YAML's unquoted string. Anything that could be a
 *  variable (punctuation, a trailing comma, the last property of an object) stays a reference. */
function isLoneYamlWord(text, labelStart, value) {
  const { body } = value;
  if (!/^[a-z]+$/.test(body) || body.length < MIN_LITERAL) return false;
  if (KEYWORD_VALUES.has(body) || CONTAINS_CREDENTIAL_WORD.test(body) || isPlaceholder(body)) return false;
  const prefix = lineBefore(text, labelStart);
  if (prefix === null || !YAML_LINE_START.test(prefix)) return false;
  const end = matchAt(YAML_LINE_END, text, value.after);
  if (!end) return false;
  if (matchAt(CLOSES_OBJECT, text, end.index + end[0].length)) return false;
  return true;
}

/** Source, not a value: at least two lowercase words joined by `_`, one of them all letters, none with more than two digits.
 *  This stops catching a human password written bare in that shape, such as `hunter2_summer`. Quoted, or on an env-file line, it is still refused. */
function isSnakeIdentifier(body) {
  if (!/^[a-z_$][a-z0-9_$]*$/.test(body)) return false;
  const segments = body.split('_').filter(Boolean);
  if (segments.length < 2 || !segments.some(segment => /^[a-z]{3,}$/.test(segment))) return false;
  return segments.every(segment => segment.replace(/\D/g, '').length <= MIN_OPAQUE_DIGITS);
}

function bareLiteralIsCredential(body, strength) {
  if (/^\d+$/.test(body)) return strength === 'strong' && body.length >= MIN_LITERAL;
  if (isOpaque(body)) return !isTemplate(body) && !isPlaceholder(body) && !ENV_NAME.test(body);
  if (strength !== 'strong' || body.length < MIN_LITERAL || /[()[\]{}."'`]/.test(body)) return false;
  // A regex with an operator in it describes values. An opaque one between slashes was already refused above.
  if (REGEX_LITERAL.test(body) || isSnakeIdentifier(body)) return false;
  return /\d/.test(body) && /[A-Za-z]/.test(body) && !isPlaceholder(body);
}

function assignmentIsCredential(text, label, labelStart, labelEnd) {
  const strength = labelStrength(label);
  if (strength === 'none') return false;
  const operator = matchAt(OPERATOR, text, labelEnd);
  if (!operator) return false;
  // A segment of a colon-separated path, as in a cloud resource name, is not a name being assigned.
  if (operator[1] === ':' && text[labelStart - 1] === ':') return false;
  const labelQuoted = /["'`]/.test(operator[0]);
  const start = operator.index + operator[0].length;
  const gap = matchAt(labelQuoted ? QUOTED_VALUE_ON_NEXT_LINE : SAME_LINE_GAP, text, start);
  const valueStart = start + gap[0].length;
  const value = readValue(text, valueStart);
  if (value.quoted) return literalIsCredential(value.body, strength) || expressionHoldsOpaqueLiteral(text, value.after);
  if (!value.body) return false;
  if (operator[1] === ':' && TYPE_NAME.test(value.body) && !isOpaque(value.body) && !/(?:\D*\d){3}/.test(value.body)) {
    const typed = matchAt(TYPE_THEN_ASSIGN, text, valueStart);
    if (!typed) return false;
    const assignedStart = valueStart + typed[0].length;
    const assigned = readValue(text, assignedStart);
    const direct = assigned.quoted ? literalIsCredential(assigned.body, strength) : bareLiteralIsCredential(assigned.body, strength);
    return direct || expressionHoldsOpaqueLiteral(text, assignedStart);
  }
  if (operator[1] === ':' && strength === 'strong' && !labelQuoted && isLoneYamlWord(text, labelStart, value)) return true;
  const reference = STORE_REFERENCE.test(value.body) || /^[$%]/.test(value.body);
  if (!reference && strength === 'strong' && gap[0] === '' && isDeclarationForm(text, label, labelStart, operator[0])) {
    return value.body.length >= MIN_LITERAL && !isTemplate(value.body) && !isPlaceholder(value.body);
  }
  if (!reference && bareLiteralIsCredential(value.body, strength)) return true;
  return expressionHoldsOpaqueLiteral(text, valueStart);
}

function urlPasswordIsReal(value) {
  return !(isTemplate(value) || isPlaceholder(value) || COMMON_URL_WORDS.test(value) || PORT_ONLY.test(value));
}

function urlCredential(text) {
  for (const match of text.matchAll(URL_USERINFO)) if (urlPasswordIsReal(match[1])) return true;
  return false;
}

function vendorMatchIsReal(match) {
  const whole = match[0];
  if (EXACT_VENDOR_EXAMPLES.has(whole)) return false;
  if (/^postgres/.test(whole)) return urlPasswordIsReal(whole.slice(whole.lastIndexOf(':') + 1, -1));
  if (whole.startsWith('-----BEGIN')) return true;
  return !/^x{6,}$/i.test(whole.slice(Math.max(whole.lastIndexOf('_'), whole.lastIndexOf('-')) + 1));
}

function vendorCredential(text) {
  for (const [pattern] of VENDOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) if (vendorMatchIsReal(match)) return true;
  }
  return false;
}

function bearerCredential(text) {
  for (const match of text.matchAll(BEARER)) {
    const value = match[1];
    if (STORE_REFERENCE.test(value)) continue;
    if (/\d/.test(value) || isOpaque(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value) && value.length >= MIN_OPAQUE)) return true;
  }
  return false;
}

/** A bare PEM marker is public syntax used by every scanner; a marker with a body is a key. */
function withoutEmptyPem(text) {
  return text.replace(EMPTY_PEM, (whole, _kind, _space, offset) => {
    const rest = text.slice(offset + whole.length);
    return !rest || SOURCE_END.test(rest) ? '' : whole;
  });
}

/** One value written to a named field of a tool's input, outside any source text. */
export function fieldIsCredential(key, value) {
  if (value === null || value === undefined || typeof value === 'object' || typeof value === 'boolean') return false;
  return literalIsCredential(String(value), labelStrength(key));
}

/** Input size is capped at MAX_JSON_BYTES by the hook runner, so each scan below is bounded by it. */
export function textHasCredential(source) {
  const text = withoutEmptyPem(source.replaceAll('\0', ''));
  if (vendorCredential(text) || urlCredential(text) || bearerCredential(text) || NAMED_HEX.test(text)) return true;
  for (const match of text.matchAll(LABEL)) {
    if (assignmentIsCredential(text, match[0], match.index, match.index + match[0].length)) return true;
  }
  return false;
}
