import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { textHasCredential } from '../runtime/credential.mjs';
import { firstFinding, writeWarning } from '../runtime/write-warning.mjs';
import { VENDOR_PATTERNS } from '../runtime/redact.mjs';
import { ORDINARY_ROWS, TRUE_ROWS, evaluate, synthetic } from './fixtures/credential-table.mjs';

const root = resolve(import.meta.dirname, '..');
const word = ['to', 'ken'].join('');
const flagged = call => firstFinding(call.toolInput, textHasCredential);
const write = content => ({ toolName: 'Write', toolInput: { content } });

test('every true credential is flagged and every ordinary form passes', () => {
  assert(TRUE_ROWS.length >= 40 && ORDINARY_ROWS.length >= 40, 'the table shrank');
  const { missed, blocked } = evaluate(flagged);
  assert.deepEqual(missed, [], 'credentials that got through');
  assert.deepEqual(blocked, [], 'ordinary code that was refused');
});

test('the vendor list is complete: each shape redaction knows is one the scan flags', () => {
  assert.equal(VENDOR_PATTERNS.length, 12, 'a vendor shape was added or removed; add its row to the table');
  const covered = TRUE_ROWS.map(([, call]) => JSON.stringify(call.toolInput));
  for (const [pattern, label] of VENDOR_PATTERNS) {
    assert(covered.some(text => text.search(pattern) >= 0), `no table row exercises ${label}`);
  }
});

test('generated secrets of realistic shapes are flagged at every strength, with no seed-dependent misses', () => {
  const ROUNDS = 300;
  const shapes = [length => synthetic(length, length), length => synthetic(length + 1000, length, '0123456789abcdef')];
  for (let i = 0; i < ROUNDS; i++) {
    const length = 32 + (i % 32);
    for (const make of shapes) {
      const value = make(length + i);
      for (const label of [`session_${word}`, `next_${word}`, `${word}_id`, `auth_${word}s`]) {
        assert(flagged(write(`${label} = "${value}"`)), `${label} let a ${length}-char value through`);
      }
    }
  }
});

test('adversarial input stays inside the hook budget', () => {
  const HOOK_TIMEOUT_MS = 20_000;
  const MAX_INPUT = 2_000_000;
  for (const text of [`${word}=x `.repeat(MAX_INPUT / 8), 'a'.repeat(MAX_INPUT), `${word} = "`.repeat(MAX_INPUT / 9), `${word.toUpperCase()}=x `.repeat(MAX_INPUT / 8)]) {
    const started = Date.now();
    flagged(write(text));
    writeWarning({ event: 'PreToolUse', ...write(text) });
    assert(Date.now() - started < HOOK_TIMEOUT_MS / 2, `took ${Date.now() - started}ms`);
  }
});

// Each edit weakens one clause of the contract. A mutant that survives means that clause has no test,
// and the anchor assertion keeps this list from going quiet when the source is reworded.
const WEAKENINGS = [
  ['runtime/credential.mjs', 'for (const [pattern, label] of VENDOR_PATTERNS) {', 'for (const [pattern, label] of []) {', 'vendor shapes ignored'],
  ['runtime/credential.mjs', "if (at < 0) return 'none';", "return 'none';", 'names never count'],
  ['runtime/credential.mjs', "if (strength === 'weak') return isOpaque(body);", "if (strength !== 'none') return isOpaque(body);", 'human passwords need to look random'],
  ['runtime/credential.mjs', 'if (isRepeatedMask(body)) return true;', 'return true;', 'everything is a placeholder'],
  ['runtime/credential.mjs', 'return !isProse(body) && !ENV_NAME.test(body);', 'return false;', 'strong literals pass'],
  ['runtime/credential.mjs', 'const isTemplate = body => STORE_LOCATOR', 'const isTemplate = body => true || STORE_LOCATOR', 'everything is a template'],
  ['runtime/credential.mjs', 'if (isOpaque(body) && !isTemplate(body)', 'if (false && !isTemplate(body)', 'references excuse what follows them'],
  ['runtime/credential.mjs', "if (operatorText !== '=') return false;", 'return false;', 'env file lines not recognised'],
  ['runtime/credential.mjs', 'if (!typed) return false;', 'return false;', 'annotated assignment skipped'],
  ['runtime/credential.mjs', 'for (const match of text.matchAll(URL_USERINFO)) if (urlPasswordIsReal(match[1])) return true;', '', 'url passwords ignored'],
  ['runtime/credential.mjs', '&& !labelQuoted && isLoneYamlWord(text, labelStart, value)', '&& false', 'lone yaml words pass'],
  ['runtime/credential.mjs', ' && !isOpaque(value.body) && !/(?:\\D*\\d){3}/.test(value.body)) {', ') {', 'a capitalised value reads as a type'],
  ['runtime/credential.mjs', 'return direct || expressionHoldsOpaqueLiteral(text, assignedStart);', 'return direct;', 'annotated expressions unchecked'],
  ['runtime/credential.mjs', 'return !rest || SOURCE_END.test(rest) ? \'\' : whole;', "return '';", 'pem bodies removed before scanning'],
  ['runtime/credential.mjs', 'for (const match of text.matchAll(BEARER)) {', 'for (const match of []) {', 'bearer values ignored'],
  ['runtime/credential.mjs', 'return COUNT_LIKE_NEIGHBOURS.has(before) ? \'weak\' : \'strong\';', "return 'weak';", 'every singular name is weak'],
  ['runtime/credential.mjs', "return authPrefix ? 'strong' : 'weak';", "return 'none';", 'plural names never count'],
  ['runtime/credential.mjs', "if (isOpaque(body)) return !isTemplate(body)", "if (false) return !isTemplate(body)", 'bare opaque values pass'],
  ['runtime/credential.mjs', "if (REGEX_LITERAL.test(body) || isSnakeIdentifier(body)) return false;", "if (REGEX_LITERAL.test(body) || true) return false;", 'any bare value reads as an identifier'],
  ['runtime/credential.mjs', "if (segments.length < 2 || !segments.some(segment => /^[a-z]{3,}$/.test(segment))) return false;", '', 'an identifier needs no real word'],
  ['runtime/credential.mjs', "return segments.every(segment => segment.replace(/\\D/g, '').length <= MIN_OPAQUE_DIGITS);", 'return true;', 'a digit-heavy segment reads as a word'],
  ['runtime/credential.mjs', "const REGEX_LITERAL = /^\\/(?=[^/]*[|^$*+?\\\\])[^/\\n]+\\/[dgimsuvy]*$/;", 'const REGEX_LITERAL = /^\\//;', 'anything after a slash reads as a regex'],
  ['runtime/credential.mjs', "if (REGEX_LITERAL.test(body) || isSnakeIdentifier(body)) return false;", "if (body.startsWith('/') || isSnakeIdentifier(body)) return false;", 'a slash alone reads as a regex'],
  ['runtime/write-warning.mjs', 'if (found) return found;\n    } else', '} else', 'string values unchecked'],
  ['runtime/write-warning.mjs', 'if (found) return found;\n        pending', 'pending', 'object keys unchecked'],
  ['runtime/write-warning.mjs', "/^(?:\\+|\\*\\*\\* (?:Add|Update|Move|Delete))/", '/^$/', 'added patch lines dropped'],
  ['runtime/write-warning.mjs', "new Set(['old_string', 'old_str', 'oldText', 'old_text'])", "new Set(['old_string', 'new_string', 'edits', 'content', 'command'])", 'written fields skipped'],
];

// These restore the old defect. A mutant here means ordinary code would be refused again.
const OVERREACH = [
  ['runtime/credential.mjs', "if (at < 0) return 'none';", "return 'strong';", 'the name alone decides'],
  ['runtime/credential.mjs', "if (DESCRIPTOR_ENDINGS.has(words.at(-1)) && words.length > 1) return 'weak';", '', 'descriptor names treated as secrets'],
  ['runtime/credential.mjs', "return authPrefix ? 'strong' : 'weak';", "return 'strong';", 'plural count names treated as secrets'],
  ['runtime/credential.mjs', 'return COUNT_LIKE_NEIGHBOURS.has(before) ? \'weak\' : \'strong\';', "return 'strong';", 'special marker names treated as secrets'],
  ['runtime/credential.mjs', 'const isTemplate = body => STORE_LOCATOR.test(body) || body.replace(TEMPLATES, \'\').trim().length <= MAX_TEMPLATE_REMAINDER;', 'const isTemplate = body => false;', 'templates treated as values'],
  ['runtime/credential.mjs', 'return marked;', 'return false;', 'placeholders treated as values'],
  ['runtime/credential.mjs', 'if (words.length < 2 ||', 'return false; if (words.length < 2 ||', 'sentences treated as values'],
  ['runtime/credential.mjs', "const reference = STORE_REFERENCE.test(value.body) || /^[$%]/.test(value.body);", 'const reference = false;', 'references treated as values'],
  ['runtime/credential.mjs', 'if (EXACT_VENDOR_EXAMPLES.has(whole)) return false;', '', 'documented examples treated as keys'],
  ['runtime/credential.mjs', 'if (matchAt(CLOSES_OBJECT, text, end.index + end[0].length)) return false;', '', 'an object\'s last property read as yaml'],
  ['runtime/credential.mjs', 'if (!end) return false;', 'if (!end) return true;', 'a value with more after it read as yaml'],
  ['runtime/credential.mjs', '|| !YAML_LINE_START.test(prefix)) return false;', ') return false;', 'a mid-line pair read as yaml'],
  ['runtime/credential.mjs', 'CONTAINS_CREDENTIAL_WORD.test(body) || ', '', 'a value naming a credential read as one'],
  ['runtime/credential.mjs', "if (!/^[a-z]+$/.test(body) || body.length < MIN_LITERAL) return false;", 'if (body.length < MIN_LITERAL) return false;', 'an underscored reference read as a yaml word'],
  ['runtime/credential.mjs', 'return !(isTemplate(value) || isPlaceholder(value) ||', 'return !(isPlaceholder(value) ||', 'url variables read as passwords'],
  ['runtime/credential.mjs', ' || PORT_ONLY.test(value));', ');', 'a port read as a url password'],
  ['runtime/credential.mjs', ' || COMMON_URL_WORDS.test(value)', '', 'a documentation url read as a credential'],
  ['runtime/credential.mjs', "!/^[\\w\\-./:=+~]+$/.test(value)", 'false', 'code fragments read as generated values'],
  ['runtime/credential.mjs', "if (operator[1] === ':' && text[labelStart - 1] === ':') return false;", '', 'resource name segments read as assignments'],
  ['runtime/credential.mjs', "const bare = matchAt(BARE_VALUE, text, start);", "const bare = matchAt(BARE_VALUE, text, start); if (bare) return { quoted: true, body: bare[0], after: start + bare[0].length };", 'any bare word treated as a literal'],
  ['runtime/credential.mjs', "if (REGEX_LITERAL.test(body) || isSnakeIdentifier(body)) return false;", 'if (isSnakeIdentifier(body)) return false;', 'a regex literal read as a value'],
  ['runtime/credential.mjs', "if (REGEX_LITERAL.test(body) || isSnakeIdentifier(body)) return false;", 'if (REGEX_LITERAL.test(body)) return false;', 'an identifier with digits read as a value'],
  ['runtime/credential.mjs', "|| body.length < MIN_LITERAL || /[()[\\]{}.\"'`]/.test(body)) return false;", '|| body.length < MIN_LITERAL) return false;', 'a call or member access read as a value'],
  ['runtime/credential.mjs', "if (segments.length < 2 ||", 'if (segments.length < 99 ||', 'no identifier ever recognised'],
  ['runtime/credential.mjs', "if (!/^[a-z_$][a-z0-9_$]*$/.test(body)) return false;", 'return false;', 'the identifier check is skipped'],
  ['runtime/write-warning.mjs', 'PATCH_START.test(item.value) ? addedPatchLines(item.value) : item.value', 'item.value', 'removed patch lines scanned'],
  ['runtime/write-warning.mjs', '.filter(([key]) => !REMOVED_FIELDS.has(key))', '', 'old_string scanned'],
];

async function mutated(t, file, before, after) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-guard-mutant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'runtime'), join(directory, 'runtime'), { recursive: true });
  await cp(join(root, 'test', 'fixtures', 'credential-table.mjs'), join(directory, 'table.mjs'));
  const source = await readFile(join(root, file), 'utf8');
  assert(source.includes(before), `the mutation anchor is gone from ${file}: ${before}`);
  await writeFile(join(directory, file), source.replace(before, after));
  const script = join(directory, 'check.mjs');
  await writeFile(script, `import { firstFinding } from ${JSON.stringify(pathToFileURL(join(directory, 'runtime', 'write-warning.mjs')).href)};
    import { textHasCredential } from ${JSON.stringify(pathToFileURL(join(directory, 'runtime', 'credential.mjs')).href)};
    import { evaluate } from ${JSON.stringify(pathToFileURL(join(directory, 'table.mjs')).href)};
    console.log(JSON.stringify(evaluate(call => firstFinding(call.toolInput, textHasCredential))));`);
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

for (const [file, before, after, why] of WEAKENINGS) {
  test(`weakening is caught: ${why}`, async t => {
    const { missed } = await mutated(t, file, before, after);
    assert.notDeepEqual(missed, [], `${file} weakened (${why}) and every true row was still refused`);
  });
}

for (const [file, before, after, why] of OVERREACH) {
  test(`overreach is caught: ${why}`, async t => {
    const { blocked } = await mutated(t, file, before, after);
    assert.notDeepEqual(blocked, [], `${file} overreached (${why}) and every ordinary row still passed`);
  });
}

test('the unmutated copy passes the same check, so a mutant failure is the mutation and not the harness', async t => {
  const result = await mutated(t, 'runtime/credential.mjs', 'const MIN_LITERAL = 8;', 'const MIN_LITERAL = 8;');
  assert.deepEqual(result, { missed: [], blocked: [] });
});

