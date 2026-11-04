import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { protectWrite } from '../runtime/protect.mjs';
import { VENDOR_PATTERNS } from '../runtime/redact.mjs';
import { ORDINARY_ROWS, TRUE_ROWS, evaluate, synthetic } from './fixtures/credential-table.mjs';

const root = resolve(import.meta.dirname, '..');
const word = ['to', 'ken'].join('');
const write = content => ({ host: 'codex', event: 'PreToolUse', toolName: 'Write', toolInput: { content } });
const refused = output => output?.hookSpecificOutput?.permissionDecision === 'deny';

test('every true credential is refused and every ordinary form passes', () => {
  assert(TRUE_ROWS.length >= 40 && ORDINARY_ROWS.length >= 40, 'the table shrank');
  const { missed, blocked } = evaluate(protectWrite);
  assert.deepEqual(missed, [], 'credentials that got through');
  assert.deepEqual(blocked, [], 'ordinary code that was refused');
});

test('a refusal never repeats the value it found', () => {
  for (const [, call] of TRUE_ROWS) {
    const output = JSON.stringify(protectWrite({ host: 'codex', event: 'PreToolUse', ...call }));
    assert(!output.includes(JSON.stringify(call.toolInput)));
    for (const value of Object.values(call.toolInput)) {
      if (typeof value === 'string' && value.length > 16) assert(!output.includes(value));
    }
  }
});

test('the vendor list is complete: each shape redaction knows is one the guard refuses', () => {
  assert.equal(VENDOR_PATTERNS.length, 10, 'a vendor shape was added or removed; add its row to the table');
  const covered = TRUE_ROWS.map(([, call]) => JSON.stringify(call.toolInput));
  for (const [pattern, label] of VENDOR_PATTERNS) {
    assert(covered.some(text => text.search(pattern) >= 0), `no table row exercises ${label}`);
  }
});

test('generated secrets of realistic shapes are refused at every strength, with no seed-dependent misses', () => {
  const ROUNDS = 300;
  const shapes = [length => synthetic(length, length), length => synthetic(length + 1000, length, '0123456789abcdef')];
  for (let i = 0; i < ROUNDS; i++) {
    const length = 32 + (i % 32);
    for (const make of shapes) {
      const value = make(length + i);
      for (const label of [`session_${word}`, `next_${word}`, `${word}_id`, `auth_${word}s`]) {
        assert(refused(protectWrite(write(`${label} = "${value}"`))), `${label} let a ${length}-char value through`);
      }
    }
  }
});

test('adversarial input stays inside the hook budget', () => {
  const HOOK_TIMEOUT_MS = 20_000;
  const MAX_INPUT = 2_000_000;
  for (const text of [`${word}=x `.repeat(MAX_INPUT / 8), 'a'.repeat(MAX_INPUT), `${word} = "`.repeat(MAX_INPUT / 9), `${word.toUpperCase()}=x `.repeat(MAX_INPUT / 8)]) {
    const started = Date.now();
    protectWrite(write(text));
    assert(Date.now() - started < HOOK_TIMEOUT_MS / 2, `took ${Date.now() - started}ms`);
  }
});

// Each edit weakens one clause of the contract. A mutant that survives means that clause has no test,
// and the anchor assertion keeps this list from going quiet when the source is reworded.
const WEAKENINGS = [
  ['runtime/credential.mjs', 'for (const [pattern] of VENDOR_PATTERNS) {', 'for (const [pattern] of []) {', 'vendor shapes ignored'],
  ['runtime/credential.mjs', "if (at < 0) return 'none';", "return 'none';", 'names never count'],
  ['runtime/credential.mjs', "if (strength === 'weak') return isOpaque(body);", "if (strength !== 'none') return isOpaque(body);", 'human passwords need to look random'],
  ['runtime/credential.mjs', 'if (isRepeatedMask(body)) return true;', 'return true;', 'everything is a placeholder'],
  ['runtime/credential.mjs', 'return !isProse(body) && !ENV_NAME.test(body);', 'return false;', 'strong literals pass'],
  ['runtime/credential.mjs', 'const isTemplate = body => STORE_LOCATOR', 'const isTemplate = body => true || STORE_LOCATOR', 'everything is a template'],
  ['runtime/credential.mjs', 'if (isOpaque(body) && !isTemplate(body)', 'if (false && !isTemplate(body)', 'references excuse what follows them'],
  ['runtime/credential.mjs', "if (operatorText !== '=') return false;", 'return false;', 'env file lines not recognised'],
  ['runtime/credential.mjs', 'if (!typed) return false;', 'return false;', 'annotated assignment skipped'],
  ['runtime/credential.mjs', 'return !rest || SOURCE_END.test(rest) ? \'\' : whole;', "return '';", 'pem bodies removed before scanning'],
  ['runtime/credential.mjs', 'for (const match of text.matchAll(BEARER)) {', 'for (const match of []) {', 'bearer values ignored'],
  ['runtime/credential.mjs', 'return COUNT_LIKE_NEIGHBOURS.has(before) ? \'weak\' : \'strong\';', "return 'weak';", 'every singular name is weak'],
  ['runtime/credential.mjs', "return authPrefix ? 'strong' : 'weak';", "return 'none';", 'plural names never count'],
  ['runtime/credential.mjs', "if (isOpaque(body)) return !isTemplate(body)", "if (false) return !isTemplate(body)", 'bare opaque values pass'],
  ['runtime/credential.mjs', 'return literalIsCredential(String(value), labelStrength(key));', 'return false;', 'tool input fields unchecked'],
  ['runtime/protect.mjs', 'if (textHasCredential(written)) return true;', '', 'string values unchecked'],
  ['runtime/protect.mjs', 'if (textHasCredential(key)) return true;', '', 'object keys unchecked'],
  ['runtime/protect.mjs', "/^(?:\\+|\\*\\*\\* (?:Add|Update|Move|Delete))/", '/^$/', 'added patch lines dropped'],
  ['runtime/protect.mjs', "new Set(['old_string', 'old_str', 'oldText', 'old_text'])", "new Set(['old_string', 'new_string', 'edits', 'content', 'command'])", 'written fields skipped'],
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
  ['runtime/credential.mjs', "const bare = matchAt(BARE_VALUE, text, start);", "const bare = matchAt(BARE_VALUE, text, start); if (bare) return { quoted: true, body: bare[0], after: start + bare[0].length };", 'any bare word treated as a literal'],
  ['runtime/protect.mjs', 'const written = PATCH_START.test(item.value) ? addedPatchLines(item.value) : item.value;', 'const written = item.value;', 'removed patch lines scanned'],
  ['runtime/protect.mjs', '.filter(([key]) => !REMOVED_FIELDS.has(key))', '', 'old_string scanned'],
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
  await writeFile(script, `import { protectWrite } from ${JSON.stringify(pathToFileURL(join(directory, 'runtime', 'protect.mjs')).href)};
    import { evaluate } from ${JSON.stringify(pathToFileURL(join(directory, 'table.mjs')).href)};
    console.log(JSON.stringify(evaluate(protectWrite)));`);
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

for (const [host, event, extra] of [
  ['claude-code', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'owned-test' }],
  ['codex', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: 'owned-test', transcript_path: null, model: 'fixture', turn_id: 'turn', permission_mode: 'default', tool_use_id: 'call' }],
  ['kimi', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'owned-test' }],
  ['grok', 'PreToolUse', { hookEventName: 'PreToolUse', toolName: 'write_file', sessionId: 'owned-test' }],
  ['cursor', 'preToolUse', { hook_event_name: 'preToolUse', tool_name: 'Write', conversation_id: 'owned-test' }],
]) {
  test(`${host}: the real runner refuses a key and lets a max-tokens lookup through`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'estelle-guard-runner-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const run = content => {
      const key = host === 'grok' ? 'toolInput' : 'tool_input';
      const payload = { ...extra, cwd: home, [key]: { content } };
      const result = spawnSync(process.execPath, [join(root, 'runtime', 'cli.mjs'), 'hook', host], {
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 5_000, maxBuffer: 100_000,
        env: { PATH: process.env.PATH, HOME: home, ESTELLE_PLUGIN_DATA: join(home, 'state') }, cwd: home,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const denied = host === 'cursor' ? JSON.parse(run(`k = "${TRUE_ROWS[0][1].toolInput.content.split('"')[1]}"`)).permission
      : JSON.parse(run(`k = "${TRUE_ROWS[0][1].toolInput.content.split('"')[1]}"`)).hookSpecificOutput.permissionDecision;
    assert.equal(denied, 'deny');
    const ordinary = run(ORDINARY_ROWS[1][1].toolInput.content);
    if (event === 'preToolUse') assert.deepEqual(JSON.parse(ordinary), { permission: 'allow' });
    else assert.equal(ordinary.includes('"deny"'), false, ordinary);
  });
}
