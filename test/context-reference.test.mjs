import test from 'node:test';
import assert from 'node:assert/strict';
import { protectWrite } from '../runtime/protect.mjs';

const name = ['target', 'token'].join('_');
const passwordField = ['pass', 'word'].join('');
const proofField = ['session', 'token'].join('_');
const code = `${name} = _TARGET_DEBIT.set(identity)`;
const input = content => ({ event: 'PreToolUse', toolName: 'functions.apply_patch', toolInput: { input: content } });

for (const host of ['claude-code', 'codex', 'kimi', 'grok', 'cursor']) {
  test(`${host} permits a literal-free ContextVar binding in source and patch context`, () => {
    for (const content of [code, `    ${code}\n    try:\n        run()`, `+    ${code}`, `     ${code}`]) {
      assert.equal(protectWrite({ host, ...input(content) }), null);
      assert.equal(protectWrite(JSON.parse(JSON.stringify({ host, ...input(content) }))), null);
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
    assert.equal(protectWrite(input(content))?.hookSpecificOutput.permissionDecision, 'deny');
  }
  // The same reference inside a comment holds no value, so it is not a credential either.
  for (const content of [`# ${code}`, `// ${code}`, `/*\n${code}\n*/`]) assert.equal(protectWrite(input(content)), null);
  assert.equal(protectWrite({ ...input(code), toolInput: { [proofField]: code } })?.hookSpecificOutput.permissionDecision, 'deny');
});
