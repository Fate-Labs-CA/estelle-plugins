import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatContext, HOOK_EVENTS, normalize } from '../adapters/dsh.mjs';
import { applyEstelle } from '../adapters/dsh-host.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import { handleHook } from '../runtime/hooks.mjs';
import { timelineIdentity } from '../runtime/identity.mjs';
import { mapDsh } from '../runtime/stream.mjs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { headlessArguments, READY, runSession, WORKING } from '../runtime/dsh-session.mjs';
import { TELEMETRY_OFF, TELEMETRY_ROWS, telemetryCheck, telemetryViolations } from '../runtime/dsh-telemetry.mjs';

const root = resolve(import.meta.dirname, '..');
const payload = (event, extra = {}) => ({ hook_event_name: event, session_id: 'session-1', cwd: '/tmp/project', ...extra });
const GHP = 'ghp_' + 'a'.repeat(30);

test('normalizes the envelope the plugin writes and refuses a malformed one', () => {
  for (const event of HOOK_EVENTS) {
    const extra = ['PreToolUse', 'PostToolUse'].includes(event) ? { tool_name: 'bash' } : {};
    assert.equal(normalize(payload(event, extra)).event, event);
  }
  for (const bad of [null, [], {}, payload('Nope'), payload('Stop', { session_id: 'a b' }), payload('Stop', { cwd: 'relative' }),
    payload('PreToolUse'), payload('Stop', { prompt: 1 })]) assert.throws(() => normalize(bad), TypeError);
});

test('maps dsh file tools onto the names the write check reads, and parses raw model arguments', () => {
  const edit = normalize(payload('PreToolUse', { tool_name: 'edit', tool_input: '{"file_path":"a","new_string":"b"}' }));
  assert.equal(edit.toolName, 'Edit');
  assert.deepEqual(edit.toolInput, { file_path: 'a', new_string: 'b' });
  assert.equal(normalize(payload('PreToolUse', { tool_name: 'write', tool_input: {} })).toolName, 'Write');
  assert.equal(normalize(payload('PreToolUse', { tool_name: 'apply_patch', tool_input: {} })).toolName, 'apply_patch');
  assert.deepEqual(normalize(payload('PreToolUse', { tool_name: 'bash', tool_input: 'not json' })).toolInput, { arguments: 'not json' });
});

test('offers context only where the plugin can place it in front of the model', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit']) assert.deepEqual(formatContext('hello', event), { context: 'hello' });
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) assert.equal(formatContext('hello', event), null);
  assert.equal(formatContext('  ', 'SessionStart'), null);
});

test('the timeline identity is the name the server knows the host by', () => {
  assert.equal(timelineIdentity('dsh', 'session-1', {}), 'deepseek-harness-session-1');
});

// Shapes copied from a real dsh 0.2.1-rc.5 session log, format v4.
const TIME = 1793866579286;
const lines = {
  person: { type: 'user/message', seq: 8, time: TIME, data: { content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  runtimeContext: { type: 'user/message', seq: 9, time: TIME, data: { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' }, role: 'user', id: 'm2' } },
  assistant: { type: 'assistant/message', seq: 16, time: TIME, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  mcp: { type: 'tool/call', seq: 17, time: TIME, data: { callId: 'c1', name: 'mcp__Estelle__verify', arguments: '{"claim":"x"}' } },
  edit: { type: 'tool/call', seq: 18, time: TIME, data: { callId: 'c2', name: 'edit', arguments: '{"file_path":"a.py","old_string":"x","new_string":"y"}' } },
  result: { type: 'tool/result', seq: 19, time: TIME, data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
  ended: { type: 'turn/end', seq: 23, time: TIME, data: { turn: 1, reason: { kind: 'completed' } } },
  aborted: { type: 'turn/end', seq: 24, time: TIME, data: { turn: 2, reason: { kind: 'aborted' } } },
};

test('captures the person, the agent and its tools, and never dsh\'s own context messages', () => {
  const notes = {};
  const kinds = mapDsh(lines.person, 1, notes).map(event => event.kind);
  assert.deepEqual(kinds, ['customer_message', 'lifecycle']);
  assert.equal(notes.title, 'fix the bug');
  assert.deepEqual(mapDsh(lines.runtimeContext, 2, {}), []);
  assert.equal(mapDsh(lines.assistant, 3, {})[0].kind, 'agent_message');
  const [mcp] = mapDsh(lines.mcp, 4, {});
  assert.equal(mcp.kind, 'tool_call');
  assert.equal(mcp.author.kind, 'estelle');
  const [edit] = mapDsh(lines.edit, 5, {});
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.payload.diff, '-x\n+y');
  assert.equal(mapDsh(lines.result, 6, {})[0].payload.call_id, 'c1');
  assert.equal(mapDsh(lines.ended, 7, {})[0].payload.state, 'waiting_for_review');
  assert.deepEqual(mapDsh(lines.aborted, 8, {}), []);
  assert.equal(mapDsh(lines.person, 1, {})[0].at, new Date(TIME).toISOString());
  for (const bad of [null, {}, { type: 'user/message' }, { type: 'turn/end', time: 'soon', data: {} }]) assert.deepEqual(mapDsh(bad, 9, {}), []);
});

test('a checkpoint keeps only the person and the agent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-dsh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'log.jsonl');
  await writeFile(path, Object.values(lines).map(line => JSON.stringify(line)).join('\n') + '\n');
  const { messages } = await readTranscriptMessages({ path, host: 'deepseek-harness' });
  assert.deepEqual(messages.map(message => [message.role, message.content]), [['user', 'fix the bug'], ['assistant', 'done']]);
});

test('the shared hook runner answers dsh events: recall becomes context, a key in a write warns', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-dsh-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const request = async path => path === '/search' ? { recall: 'earlier decision', degraded: false } : {};
  const start = await handleHook({ host: 'dsh', payload: payload('SessionStart'), stateDir, request });
  assert.match(start.context, /estelle_resume/);
  const warned = await handleHook({ host: 'dsh', stateDir, request, payload: payload('PreToolUse',
    { tool_name: 'write', tool_input: JSON.stringify({ file_path: 'a', content: `const value = "${GHP}"` }) }) });
  assert.match(warned.warning, /github token/);
  assert(!JSON.stringify(warned).includes(GHP));
  const allowed = await handleHook({ host: 'dsh', stateDir, request, payload: payload('PreToolUse',
    { tool_name: 'write', tool_input: JSON.stringify({ file_path: 'a', content: 'const value = 1' }) }) });
  assert.equal(allowed, null);
});

function harness() {
  const listeners = new Map();
  const warnings = [];
  const commands = [];
  const providers = [];
  const sections = [];
  const pending = [];
  const services = { commands: { register: row => commands.push(row) },
    skills: { registerProvider: factory => providers.push(factory()) },
    systemPrompt: { section: row => sections.push(row), getSectionOrder: () => 1 } };
  const ctx = { logger: { warn: text => warnings.push(text) }, effect: () => {}, on: (name, fn) => listeners.set(name, fn),
    inject: (names, fn) => { pending.push(fn(services)); } };
  const create = input => ({ ...input, role: 'user', id: 'generated' });
  return { ctx, create, listeners, warnings, commands, providers, sections, ready: () => Promise.all(pending) };
}

test('registers every command as a prompt the model receives, with the asked text substituted', async () => {
  const h = harness();
  applyEstelle(h.ctx, { createUserMessage: h.create });
  await h.ready();
  assert.deepEqual(h.commands.map(row => row.name).sort(),
    ['cloud', 'code', 'handoff', 'login', 'logout', 'monitor', 'resume', 'review', 'rooms'].map(name => `estelle-${name}`));
  const sent = [];
  const outcome = h.commands.find(row => row.name === 'estelle-resume').handler({ agent: { followup: m => sent.push(m) }, rawInput: ' the billing lane ' });
  assert.deepEqual(outcome, { kind: 'success' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].source.kind, 'user');
  assert.match(sent[0].content[0].text, /estelle_resume for the billing lane\./);
  assert(!sent[0].content[0].text.includes('$ARGUMENTS'));
});

test('offers every shared skill without its private fields, and adds the shared instructions to the prompt', async () => {
  const h = harness();
  applyEstelle(h.ctx, { createUserMessage: h.create });
  await h.ready();
  const [provider] = h.providers;
  const listed = await provider.list();
  assert(listed.some(row => row.name === 'estelle'));
  assert(listed.length >= 20);
  const definition = await provider.get(listed.find(row => row.name === 'estelle'));
  assert.equal(definition.locator, undefined);
  assert.match(definition.content, /^---\n/);
  assert.equal(h.sections[0].text, await readFile(join(root, 'instructions.md'), 'utf8'));
});

test('runs a write check only for tools that can write, and refuses on the hook\'s answer', async t => {
  const data = await mkdtemp(join(tmpdir(), 'estelle-dsh-data-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  process.env.ESTELLE_PLUGIN_DATA = data;
  process.env.ESTELLE_API_URL = 'http://127.0.0.1:9';
  t.after(() => { delete process.env.ESTELLE_PLUGIN_DATA; delete process.env.ESTELLE_API_URL; });
  const h = harness();
  applyEstelle(h.ctx, { createUserMessage: h.create });
  const pre = h.listeners.get('tools/pre-execute');
  const injected = [];
  const agent = { session: { header: { id: 'session-1', cwd: tmpdir() } }, inject: message => injected.push(message) };
  let passed = 0;
  const next = async () => { passed++; return { kind: 'allow' }; };
  assert.deepEqual(await pre({ agent, name: 'bash', arguments: `echo ${GHP}`, callId: 'c' }, next), { kind: 'allow' });
  assert.equal(passed, 1);
  const warned = await pre({ agent, name: 'write', arguments: JSON.stringify({ file_path: 'a', content: `const value = "${GHP}"` }), callId: 'c' }, next);
  assert.deepEqual(warned, { kind: 'allow' }, 'a key in a write warns and the write goes ahead');
  assert.equal(passed, 2);
  assert(h.warnings.some(text => /github token/.test(text) && !text.includes(GHP)));
  assert.equal(injected.length, 1);
  assert(!JSON.stringify(injected).includes(GHP));
  const clean = await pre({ agent, name: 'edit', arguments: JSON.stringify({ file_path: 'a', new_string: 'b' }), callId: 'c' }, next);
  assert.deepEqual(clean, { kind: 'allow' });
  assert.equal(passed, 3);
  assert.equal(injected.length, 1, 'ordinary code says nothing');
});

// The shape of a real `dsh --profile headless --dump-config` (0.2.2-rc.1), telemetry rows only.
const OFF_DUMP = [
  '# == @deepseek-ai/dsh-base', '# patched by: dsh-plugin-estelle',
  '- id: session-log-deepseek', "  name: '@deepseek-ai/dsh-session-log-deepseek'", '  disabled: true',
  '# == @deepseek-ai/dsh-base', '- id: plugin-package-inventory-deepseek', "  name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'", '  disabled: true',
  '- id: session-telemetry-otel', "  name: '@deepseek-ai/dsh-session-telemetry-otel'", '  config:', "    mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'",
  '    exporter:', '      compression: gzip', '  disabled: true', '- id: subprocess', "  name: '@deepseek-ai/dsh-subprocess'", '',
].join('\n');

test('the telemetry check goes red when any telemetry row is on, absent, or the dump is unreadable', () => {
  assert.equal(telemetryCheck(OFF_DUMP), TELEMETRY_OFF);
  for (const id of TELEMETRY_ROWS) {
    const on = OFF_DUMP.replace(new RegExp(`(- id: ${id}\\n(?:(?!- id:).*\\n)*?) {2}disabled: true\\n`), '$1');
    assert.notEqual(on, OFF_DUMP, `${id}: the fixture must change for this to mean anything`);
    assert.deepEqual(telemetryViolations(on), [id]);
    assert.equal(telemetryCheck(on), `DSH-TELEMETRY-ON: ${id}`);
    assert.deepEqual(telemetryViolations(OFF_DUMP.replace(`- id: ${id}\n`, '- id: renamed\n')), [id]);
  }
  // Another row's disabled line must not stand in for this row's.
  const borrowed = OFF_DUMP.replace("  disabled: true\n- id: subprocess", "- id: subprocess\n  disabled: true");
  assert.deepEqual(telemetryViolations(borrowed), ['session-telemetry-otel']);
  for (const unreadable of ['', '   ', null, undefined, 7]) assert.deepEqual(telemetryViolations(unreadable), [...TELEMETRY_ROWS]);
});

test('the web-only telemetry row may be absent, and must be off when present', () => {
  const row = "- id: desktop-product-telemetry\n  name: '@deepseek-ai/dsh-host-product-telemetry-otel'\n";
  assert.equal(telemetryCheck(OFF_DUMP), TELEMETRY_OFF);
  assert.deepEqual(telemetryViolations(OFF_DUMP + row), ['desktop-product-telemetry']);
  assert.equal(telemetryCheck(`${OFF_DUMP}${row}  disabled: true\n`), TELEMETRY_OFF);
});

test('the telemetry command fails closed for a Silo reading the effective config', () => {
  const cli = join(root, 'runtime', 'cli.mjs');
  const off = spawnSync(process.execPath, [cli, 'dsh-telemetry'], { input: OFF_DUMP, encoding: 'utf8' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), TELEMETRY_OFF);
  const on = spawnSync(process.execPath, [cli, 'dsh-telemetry'], { input: 'nothing mounted', encoding: 'utf8' });
  assert.equal(on.status, 1);
  assert.match(on.stdout, /^DSH-TELEMETRY-ON: session-log-deepseek/);
});

test('a cloud pane runs one pasted prompt as one task, continues the session, and keeps telemetry off', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-dsh-pane-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('end', () => {
      runs.push({ command, args, env: options.env, task: Buffer.concat(chunks).toString() });
      child.stdout.end(['{"type":"session","sessionId":"session-9"}', '{"type":"tool_call","tool":"bash"}',
        `{"type":"final","text":"answer ${runs.length}"}`, ''].join('\n'));
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const input = new PassThrough();
  const out = new PassThrough();
  const shown = [];
  out.on('data', chunk => shown.push(chunk.toString()));
  const finished = runSession({ input, out, cwd: directory, env: { ESTELLE_REPO: 'uqeu/estelle-example' }, spawnImpl });
  const settled = () => new Promise(resolve => setTimeout(resolve, 1000));
  input.write('first line\nsecond line\n');
  await settled();
  input.write('next task\n');
  await settled();
  input.end();
  await finished;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].task, 'first line\nsecond line');
  assert.equal(runs[0].command, 'dsh');
  assert(!runs[0].args.includes('--session-id'));
  assert.equal(runs[1].args[runs[1].args.indexOf('--session-id') + 1], 'session-9');
  assert.equal(runs[1].task, 'next task');
  for (const run of runs) {
    assert.equal(run.env.DSH_TELEMETRY_DISABLED, '1');
    assert.equal(run.env.DSH_TELEMETRY_MODE, 'DISABLED');
    assert.deepEqual(run.args.slice(0, 2), ['--profile', 'headless']);
    assert.equal(run.args.at(-1), '-');
  }
  const screen = shown.join('');
  assert(screen.includes(`${WORKING} · bash`));
  // After the last answer the screen holds the answer and the ready marker, and no busy marker the typing layer would read.
  const last = screen.slice(screen.lastIndexOf('\u001b[2J'));
  assert(last.includes('answer 2'));
  assert(last.includes(READY));
  assert(!last.includes(WORKING));
});

test('a failed run says so in the pane and returns to ready', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-dsh-pane-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('finish', () => { child.stdout.end('not json\n'); setImmediate(() => child.emit('close', 1)); });
    child.stdin.resume();
    return child;
  };
  const input = new PassThrough();
  const out = new PassThrough();
  const shown = [];
  out.on('data', chunk => shown.push(chunk.toString()));
  const finished = runSession({ input, out, cwd: directory, env: {}, spawnImpl });
  input.end('do it\n');
  await finished;
  const screen = shown.join('');
  assert.match(screen, /dsh failed: dsh exited 1/);
  assert(screen.trimEnd().endsWith(READY));
  assert.deepEqual(headlessArguments({ sessionId: '', gitDirectory: '' }).includes('--add-dir'), false);
});

test('the bundle declares what dsh reads, and refuses to send a missing key or upload the session log', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'plugins/dsh/package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } });
  assert(manifest.keywords.includes('dsh-plugin'));
  assert.equal(manifest.exports['.'], './adapters/dsh-plugin.mjs');
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-llm'].optional, true);
  await readFile(join(root, 'plugins/dsh', manifest.main));
  const patch = await readFile(join(root, 'plugins/dsh/cordis.patch.yml'), 'utf8');
  assert.equal(telemetryCheck(patch), TELEMETRY_OFF);
  assert.match(patch, /name: dsh-plugin-estelle/);
  assert.match(patch, /disabled: !!js '!process\.env\.ESTELLE_API_KEY'/);
  assert.match(patch, /url: https:\/\/api\.fatelabs\.ca\/mcp/);
  assert(!/estelle_(live|silo)_/.test(patch));
});
