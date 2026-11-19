// `/estelle:resume` with no argument used to expand to "Call estelle_resume for ." Hosts substitute $ARGUMENTS
// literally (Claude Code natively, our Pi and dsh adapters with replaceAll), so a template only reads right with
// an empty argument if it never puts $ARGUMENTS mid-sentence. Every shared command is checked both ways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const commands = async () => Promise.all((await readdir(join(root, 'commands'))).sort()
  .map(async name => [name, await readFile(join(root, 'commands', name), 'utf8')]));

test('every shared command reads as plain sentences when $ARGUMENTS is empty', async () => {
  const rows = await commands();
  assert(rows.length >= 7, 'the command set shrank; this check would pass over nothing');
  for (const [name, text] of rows) {
    assert(text.includes('$ARGUMENTS'), `${name} takes no argument; this check covers nothing in it`);
    const empty = text.replaceAll('$ARGUMENTS', '');
    assert.doesNotMatch(empty, /\s[.,]|\b(?:for|to|Review)\s*$/m, `${name} reads wrong with no argument:\n${empty}`);
    const uses = text.split('\n').filter(line => line.includes('$ARGUMENTS'));
    // After a label (`Target: $ARGUMENTS`) or alone on a line (heredoc data), never inside a sentence.
    assert(uses.every(line => /(?:: |^)\$ARGUMENTS$/.test(line)), `${name} uses $ARGUMENTS mid-sentence: ${uses.join(' | ')}`);
  }
});

test('the resume command names what a blank argument means', async () => {
  const text = await readFile(join(root, 'commands', 'resume.md'), 'utf8');
  assert.match(text.replaceAll('$ARGUMENTS', ''), /^Call estelle_resume\. /m);
  assert.match(text, /Requested work \(blank means the most recent\): \$ARGUMENTS/);
});
