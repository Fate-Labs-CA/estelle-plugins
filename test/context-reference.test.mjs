import test from 'node:test';
import assert from 'node:assert/strict';
import { textHasCredential } from '../runtime/credential.mjs';
import { firstFinding } from '../runtime/write-warning.mjs';

// The handoff scan's contract (move.mjs). The write hook itself only warns on exact vendor shapes: write-warning.test.mjs.
const flaggedIn = call => firstFinding(call.toolInput, textHasCredential) ? { flagged: true } : null;

const name = ['target', 'token'].join('_');
const passwordField = ['pass', 'word'].join('');
const proofField = ['session', 'token'].join('_');
const code = `${name} = _TARGET_DEBIT.set(identity)`;
const input = content => ({ event: 'PreToolUse', toolName: 'functions.apply_patch', toolInput: { input: content } });

for (const host of ['claude-code', 'codex', 'kimi', 'grok', 'cursor']) {
  test(`${host} permits a literal-free ContextVar binding in source and patch context`, () => {
    for (const content of [code, `    ${code}\n    try:\n        run()`, `+    ${code}`, `     ${code}`]) {
      assert.equal(flaggedIn({ host, ...input(content) }), null);
      assert.equal(flaggedIn(JSON.parse(JSON.stringify({ host, ...input(content) }))), null);
    }
  });
}

test('ContextVar recognition does not waive credential literals or passive data', () => {
  const opaque = 'b9'.repeat(32);
  const vendor = ['gh', 'p_'].join('') + 'q'.repeat(30);
  for (const content of [`const ${passwordField} = "${code}";`, `# ${proofField} = "${opaque}"`,
    `${name} = _TARGET_DEBIT.set("${opaque}")`, `${name} = _TARGET_DEBIT.set(${vendor})`,
    `${code} + "${opaque}"`, `const ${code} + "${opaque}";`, `${code}\n${proofField} = "${opaque}"`,
    `${name} = _TARGET_DEBIT.set(identity + "${opaque}")`]) {
    assert.equal(flaggedIn(input(content))?.flagged, true);
  }
  // The same reference inside a comment holds no value, so it is not a credential either.
  for (const content of [`# ${code}`, `// ${code}`, `/*\n${code}\n*/`]) assert.equal(flaggedIn(input(content)), null);
});
