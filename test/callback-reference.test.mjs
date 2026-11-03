import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { protectWrite } from '../runtime/protect.mjs';

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
      assert.equal(protectWrite({ host, ...input(code) }), null);
      assert.equal(protectWrite(JSON.parse(JSON.stringify({ host, ...input(code) }))), null);
    }
  });
}

test('callback recognition does not waive quoted or bare credential-like data', () => {
  const opaque = 'a8'.repeat(32);
  const vendor = ['gh', 'p_'].join('') + 'q'.repeat(30);
  for (const code of [`const ${passwordField} = "${source}";`, `${tokenField}=${callback}`, source + `; const ${proofField} = "${opaque}";`,
    `replace(intent, ${field}=guard("${vendor}"))`, `# ${source}\n${tokenField}=${callback}`, `// ${source}\n${tokenField}=${callback}`]) {
    assert.equal(protectWrite(input(code))?.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(protectWrite({ ...input(source), toolInput: { [proofField]: source } })?.hookSpecificOutput.permissionDecision, 'deny');
});

test('callback allowance ends at the argument boundary and never enters block comments', () => {
  const opaque = 'c6'.repeat(32);
  for (const code of [`replace(intent, ${field}=${callback} + "${opaque}")`,
    `/*\n${source}\n*/`, `/* comment\n${source}\nmore */`]) {
    assert.equal(protectWrite(input(code))?.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(protectWrite(input(`/* preceding comment */\n${source}`)), null);
});
