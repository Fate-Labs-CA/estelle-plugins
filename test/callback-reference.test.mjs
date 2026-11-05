import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textHasCredential } from '../runtime/credential.mjs';
import { firstFinding } from '../runtime/write-warning.mjs';

// The handoff scan's contract (move.mjs). The write hook itself only warns on exact vendor shapes: write-warning.test.mjs.
const flaggedIn = call => firstFinding(call.toolInput, textHasCredential) ? { flagged: true } : null;

const field = ['secret', 'env'].join('_');
const proofField = ['session', 'token'].join('_');
const passwordField = ['pass', 'word'].join('');
const tokenField = ['TO', 'KEN'].join('');
const callback = `guard(intent.${field})`;
const source = `intent = replace(intent, ask=guard(intent.ask), ${field}=${callback})`;
const input = content => ({ event: 'PreToolUse', toolName: 'functions.apply_patch', toolInput: { input: content } });
const observed = readFileSync(new URL('./fixtures/callback-deadline.patch', import.meta.url), 'utf8');

for (const host of ['claude-code', 'codex', 'kimi', 'grok', 'cursor']) {
  test(`${host} permits literal-free keyword callback references`, () => {
    for (const code of [source, `+    ${source}`, `const value = replace(intent, {${field}: ${callback}});`, observed]) {
      assert.equal(flaggedIn({ host, ...input(code) }), null);
      assert.equal(flaggedIn(JSON.parse(JSON.stringify({ host, ...input(code) }))), null);
    }
  });
}

test('callback recognition does not waive quoted or bare credential-like data', () => {
  const opaque = 'a8'.repeat(32);
  const vendor = ['gh', 'p_'].join('') + 'q'.repeat(30);
  for (const code of [`const ${passwordField} = "${source}";`, `${tokenField}=${callback}`, source + `; const ${proofField} = "${opaque}";`,
    `replace(intent, ${field}=guard("${vendor}"))`, `# ${source}\n${tokenField}=${callback}`, `// ${source}\n${tokenField}=${callback}`]) {
    assert.equal(flaggedIn(input(code))?.flagged, true);
  }
});

test('callback allowance ends at the argument boundary and never enters block comments', () => {
  const opaque = 'c6'.repeat(32);
  for (const code of [`replace(intent, ${field}=${callback} + "${opaque}")`,
    `/*\nvalue = replace(intent, ${proofField}="${opaque}")\n*/`]) {
    assert.equal(flaggedIn(input(code))?.flagged, true);
  }
  // A comment can leak a literal (refused above) but a comment holding only a reference leaks nothing.
  for (const code of [`/* preceding comment */\n${source}`, `/*\n${source}\n*/`, `/* comment\n${source}\nmore */`]) {
    assert.equal(flaggedIn(input(code)), null);
  }
});
