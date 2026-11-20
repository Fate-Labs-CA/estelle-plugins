import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFile(resolve(root, file), 'utf8');
const hosts = ['claude', 'codex', 'cursor', 'grok', 'kimi'];

test('authored instructions use actual review and source evidence without obsolete tool commentary', async () => {
  for (const file of ['instructions.md', 'skills/estelle/SKILL.md', 'runtime/write-warning.mjs']) {
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
    for (const file of ['instructions.md', 'skills/estelle/SKILL.md', 'runtime/write-warning.mjs']) {
      assert.equal(await read(`plugins/${host}/${file}`), await read(file), `${host}/${file}`);
    }
  }
  const cursor = await read('plugins/cursor/rules/estelle.mdc');
  assert(cursor.endsWith(await read('instructions.md')));
  assert.doesNotMatch(cursor, /\bgate\b/i);
});

test('one intent map reaches every host from intent-map.md, and a hand edit to the region is refused', async () => {
  const map = await read('intent-map.md');
  for (const word of ['`estelle_move`', 'mode: "cloud"', 'mode: "handoff"', '`estelle_docs`', '`estelle_qa`',
    '`session_message`', '`estelle_room`', '`estelle_improve`', '`scan`', 'before saying you don\'t know']) {
    assert(map.includes(word), word);
  }
  const allHosts = ['claude', 'codex', 'cursor', 'dsh', 'grok', 'kimi', 'opencode', 'pi', 'qwen', 'hermes', 'openclaw', 'fx'];
  for (const file of ['instructions.md', 'skills/estelle/SKILL.md']) {
    assert.equal((await read(file)).split(map).length, 2, `${file} carries the map exactly once`);
    for (const host of allHosts) assert((await read(`plugins/${host}/${file}`)).includes(map), `${host}/${file}`);
  }
  assert((await read('plugins/cursor/rules/estelle.mdc')).includes(map));
});
