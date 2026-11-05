import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutatingTool, writeWarning } from '../runtime/write-warning.mjs';

const root = resolve(import.meta.dirname, '..');
const KEY = ['gh', 'p_'].join('') + 'a'.repeat(30);
const write = (content, extra = {}) => ({ host: 'codex', event: 'PreToolUse', toolName: 'Write', toolInput: { file_path: 'src/app.py', content, ...extra } });

test('an exact key shape names the file and the kind, says rotate it, and never repeats the value', () => {
  const found = writeWarning(write(`key = "${KEY}"`));
  assert.equal(found.file, 'src/app.py');
  assert.equal(found.kind, 'github token');
  assert.match(found.warning, /src\/app\.py/);
  assert.match(found.warning, /github token/);
  assert.match(found.warning, /Rotate it if it's real/);
  assert.match(found.warning, /not blocked/);
  assert(!JSON.stringify(found).includes(KEY));
});

test('the file comes from each tool shape, and a key in the path itself does not reach the message', () => {
  const patch = `*** Begin Patch\n*** Update File: lib/a.py\n+k = "${KEY}"\n*** End Patch`;
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'functions.apply_patch', toolInput: { input: patch } }).file, 'lib/a.py');
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'Edit', toolInput: { filePath: 'b.ts', new_string: KEY } }).file, 'b.ts');
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'Write', toolInput: { content: KEY } }).file, 'this file');
  assert(!writeWarning(write(KEY, { file_path: `notes/${KEY}.txt` })).warning.includes(KEY));
});

test('what no longer gets a word: a name with a value behind it, and anything that is not an exact vendor shape', () => {
  const word = ['to', 'ken'].join(''), pw = ['pass', 'word'].join('');
  for (const content of [`${pw} = "hunter2hunter2"`, `session_${word} = "${'d8'.repeat(32)}"`, `${word.toUpperCase()}=abcdefghijklmnop`,
    `url = "https://user:hunter2hunter2@host.example"`, `Authorization: Bearer ${'Ab1'.repeat(14)}`]) {
    assert.equal(writeWarning(write(content)), null, content);
  }
});

test('removing a key says nothing, and an unchanged patch line says nothing', () => {
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'Edit', toolInput: { file_path: 'a', old_string: KEY, new_string: 'x' } }), null);
  const patch = `*** Begin Patch\n*** Update File: a\n-k = "${KEY}"\n k = "${KEY}"\n+k = 1\n*** End Patch`;
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'apply_patch', toolInput: { input: patch } }), null);
});

test('a documentation example, an all-x key and a bare PEM marker say nothing; a PEM with a body does', () => {
  const marker = `-----BEGIN ${['PRIVATE', 'KEY'].join(' ')}-----`;
  for (const content of [`k = "${['AK', 'IA'].join('')}IOSFODNN7EXAMPLE"`, `k = "${['gh', 'p_'].join('')}${'x'.repeat(36)}"`, `const m = "${marker}";`]) {
    assert.equal(writeWarning(write(content)), null, content);
  }
  assert.equal(writeWarning(write(`${marker}\nQUJDREVGR0hJSktMTU5PUA==\n`)).kind, 'private key');
});

test('a key used as an object key is seen, and reads and passive events are not writes', () => {
  assert.equal(writeWarning({ event: 'PreToolUse', toolName: 'Write', toolInput: { [KEY]: 1 } }).kind, 'github token');
  assert(mutatingTool('functions.apply_patch') && !mutatingTool('Read'));
  for (const input of [null, undefined, [], {}, { event: 'PostToolUse', toolName: 'Write', toolInput: { content: KEY } },
    { event: 'PreToolUse', toolName: 'Read', toolInput: { content: KEY } }]) assert.equal(writeWarning(input), null);
});

test('an input beyond the traversal bound is explicitly unscanned rather than clear', () => {
  assert.deepEqual(writeWarning({ event: 'PreToolUse', toolName: 'Write', toolInput: Array.from({ length: 10_001 }, () => 'ordinary') }), { unscanned: true });
});

test('⛔ no code in the runtime or adapters can tell a host to stop an edit', async () => {
  for (const directory of ['runtime', 'adapters']) {
    for (const file of await readdir(join(root, directory))) {
      if (!file.endsWith('.mjs')) continue;
      const text = await readFile(join(root, directory, file), 'utf8');
      assert.doesNotMatch(text, /permissionDecision|permission: *'deny'|kind: *'deny'|["']deny["']/, `${directory}/${file}`);
    }
  }
});

const HOSTS = [
  ['claude-code', { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'owned-test' }, 'tool_input',
    out => [out.systemMessage, out.hookSpecificOutput.additionalContext]],
  ['codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: 'owned-test', transcript_path: null, model: 'fixture', turn_id: 'turn', permission_mode: 'default', tool_use_id: 'call' }, 'tool_input',
    out => [out.systemMessage, out.hookSpecificOutput.additionalContext]],
  ['kimi', { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'owned-test' }, 'tool_input', () => []],
  ['grok', { hookEventName: 'PreToolUse', toolName: 'write_file', sessionId: 'owned-test' }, 'toolInput', out => [out.hookSpecificOutput.additionalContext]],
  ['cursor', { hook_event_name: 'preToolUse', tool_name: 'Write', conversation_id: 'owned-test' }, 'tool_input', out => [out.user_message, out.agent_message]],
  ['dsh', { hook_event_name: 'PreToolUse', tool_name: 'write', session_id: 'owned-test' }, 'tool_input', out => [out.warning]],
];

for (const [host, extra, inputKey, shown] of HOSTS) {
  test(`${host}: the real runner lets the edit through, warns where this host shows it, and stays quiet on ordinary code`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'estelle-warn-runner-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const run = content => spawnSync(process.execPath, [join(root, 'runtime', 'cli.mjs'), 'hook', host], {
      input: JSON.stringify({ ...extra, cwd: home, [inputKey]: { file_path: 'src/app.py', content } }), encoding: 'utf8', timeout: 10_000,
      maxBuffer: 100_000, env: { PATH: process.env.PATH, HOME: home, ESTELLE_PLUGIN_DATA: join(home, 'state') }, cwd: home });
    const warned = run(`k = "${KEY}"`);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /src\/app\.py.*github token.*Rotate it if it's real/s);
    assert(!warned.stdout.includes(KEY) && !warned.stderr.includes(KEY), 'the value is never repeated');
    assert(!warned.stdout.includes('deny'), warned.stdout);
    if (host === 'cursor') assert.equal(JSON.parse(warned.stdout).permission, 'allow');
    const output = warned.stdout.trim() ? JSON.parse(warned.stdout) : {};
    for (const words of shown(output)) assert.match(words, /Rotate it if it's real/);
    const ordinary = run('const value = 42;');
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.doesNotMatch(`${ordinary.stdout}${ordinary.stderr}`, /Rotate it/);
    assert(!ordinary.stdout.includes('deny'));
  });
}

test('the real Codex runner makes no network call to warn, and stays silent on malformed input', async t => {
  const home = await mkdtemp(join(tmpdir(), 'estelle-warn-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const counter = join(home, 'calls.json'), guard = join(home, 'network-guard.mjs');
  await writeFile(guard, `import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    let calls=0; const deny=()=>{calls++;throw new Error('test_network_denied')};
    http.request=deny;https.request=deny;net.Socket.prototype.connect=deny;dns.lookup=deny;
    syncBuiltinESMExports(); process.on('exit',()=>fs.writeFileSync(${JSON.stringify(counter)},JSON.stringify(calls)));`);
  const base = { session_id: 'owned-test', cwd: home, transcript_path: null, model: 'fixture', turn_id: 'turn',
    permission_mode: 'default', tool_use_id: 'call', tool_name: 'Write' };
  for (const [event, input, words] of [['PostToolUse', { content: 'ordinary' }, false], ['PreToolUse', { content: `k = "${KEY}"` }, true], ['UnknownEvent', {}, false]]) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url)), 'hook', 'codex'], {
      input: JSON.stringify({ ...base, hook_event_name: event, tool_input: input, tool_response: {} }), encoding: 'utf8', timeout: 3000, maxBuffer: 100_000,
      env: { PATH: process.env.PATH, HOME: home, ESTELLE_PLUGIN_DATA: join(home, 'state') }, cwd: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(counter, 'utf8')), 0);
    assert.equal(/Rotate it/.test(result.stdout), words);
  }
});
