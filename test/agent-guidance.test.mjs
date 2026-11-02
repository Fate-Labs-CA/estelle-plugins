import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const hosts = ['claude', 'codex', 'cursor', 'grok', 'kimi'];

test('authored instructions use actual review and source evidence without obsolete tool commentary', async () => {
  for (const file of ['instructions.md', 'skills/estelle/SKILL.md', 'runtime/protect.mjs']) {
    const text = await read(file);
    assert.doesNotMatch(text, /\bgate\b/i, file);
  }
  const skill = await read('skills/estelle/SKILL.md');
  for (const tool of ['verify', 'review', 'scan', 'estelle_resume']) assert(skill.includes('`' + tool + '`'));
  assert.match(skill, /user's authorization/);
  assert.match(skill, /copy another session's identity/);
  assert.match(skill, /Never quote tokens/);
  assert.match(skill, /limit on evidence/);
});

test('all native host guidance copies match the authored positive instructions', async () => {
  for (const host of hosts) {
    for (const file of ['instructions.md', 'skills/estelle/SKILL.md', 'runtime/protect.mjs']) {
      assert.equal(await read(`plugins/${host}/${file}`), await read(file), `${host}/${file}`);
    }
  }
  const cursor = await read('plugins/cursor/rules/estelle.mdc');
  assert(cursor.endsWith(await read('instructions.md')));
  assert.doesNotMatch(cursor, /\bgate\b/i);
});
