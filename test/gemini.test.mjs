import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/gemini.mjs';
import { mapGemini, streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import { handleHook } from '../runtime/hooks.mjs';

const root = resolve(import.meta.dirname, '..');
// A Gemini CLI chat recording in the format ChatRecordingService writes (read from @google/gemini-cli 0.71.1): a metadata line,
// messages re-appended as they change (the tool call executing, then done; the reply, then its token counts), an `info` message,
// `$set` updates, and a prompt that carries a hook's context as its own `<hook_context>` part. Not from a signed-in session.
const FIXTURE = join(root, 'test', 'fixtures', 'gemini', 'session-0.71.1.jsonl');
const SESSION = '7d3f9a2e-5b1c-4e8a-9c64-0f2b6a1d8e35';
const payload = (event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd: '/tmp/gemini-project',
  transcript_path: FIXTURE, timestamp: '2026-11-25T10:00:00.000Z', ...extra });
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const records = async () => (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-gemini-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Gemini CLI hook events are renamed to the runtime\'s, and its file tools get the write check', () => {
  assert.deepEqual(HOOK_EVENTS, ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'PreCompress', 'SessionEnd']);
  const renamed = { SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
    AfterAgent: 'Stop', PreCompress: 'PreCompact', SessionEnd: 'SessionEnd' };
  for (const event of HOOK_EVENTS) {
    const tool = ['BeforeTool', 'AfterTool'].includes(event) ? { tool_name: 'read_file', tool_input: {} } : {};
    const n = normalize(payload(event, tool));
    assert.equal(n.host, 'gemini-cli');
    assert.equal(n.event, renamed[event]);
  }
  assert.equal(normalize(payload('BeforeTool', { tool_name: 'write_file', tool_input: {} })).toolName, 'Write');
  assert.equal(normalize(payload('BeforeTool', { tool_name: 'replace', tool_input: {} })).toolName, 'Edit');
  assert.equal(normalize(payload('BeforeAgent', { prompt: 'hi' })).prompt, 'hi');
  assert.equal(normalize(payload('SessionStart', { transcript_path: '' })).transcriptPath, null);
  for (const bad of [payload('Notification'), payload('BeforeTool'), { ...payload('AfterAgent'), session_id: '' }, []]) {
    assert.throws(() => normalize(bad), TypeError);
  }
});

test('context goes where Gemini CLI takes it: start, prompt and tool result, in its own event names', () => {
  assert.deepEqual(formatContext('x', 'UserPromptSubmit'), { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'x' } });
  assert.deepEqual(formatContext('x', 'SessionStart'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' } });
  assert.equal(formatContext('x', 'PostToolUse').hookSpecificOutput.hookEventName, 'AfterTool');
  // BeforeTool's output can only rewrite tool_input and AfterAgent's can only deny: neither may carry context.
  assert.equal(formatContext('x', 'PreToolUse'), null);
  assert.equal(formatContext('x', 'Stop'), null);
  assert.equal(formatContext('  ', 'SessionStart'), null);
});

test('a Gemini CLI chat recording becomes the person, the thought, the tool call once, its result and the reply', async () => {
  const lines = await records();
  const events = lines.flatMap(line => mapGemini(line, 0, {}));
  const kinds = new Set(events.map(event => event.kind));
  assert.deepEqual([...kinds].sort(), ['agent_message', 'customer_message', 'lifecycle', 'thinking', 'tool_call', 'tool_result']);
  const said = events.filter(event => event.kind === 'customer_message');
  // The hook's own context part is not the person's words.
  assert.deepEqual(said.map(event => event.payload.text), ['read the readme']);
  // A message appended twice carries the same event keys, so the server replays it once.
  const keys = events.map(event => event.event_id);
  const call = events.filter(event => event.kind === 'tool_call');
  assert.equal(call.length, 2, 'the executing and the finished append');
  assert.equal(call[0].event_id, call[1].event_id);
  assert.equal(call[0].payload.tool, 'read_file');
  const result = events.filter(event => event.kind === 'tool_result');
  assert.equal(result.length, 1, 'a call still executing has no result yet');
  assert.equal(result[0].payload.output, 'hello\n');
  assert.equal(result[0].payload.ok, true);
  const reply = events.filter(event => event.kind === 'agent_message');
  assert.equal(new Set(reply.map(event => event.event_id)).size, 1);
  assert.equal(reply.at(-1).author.id, 'gemini-cli');
  assert.equal(reply.at(-1).payload.usage.model, 'gemini-mock');
  assert.equal(reply.at(-1).payload.usage.input, 100);
  assert.ok(keys.every(key => typeof key === 'string' && key));
  // `info` messages, `$set` and the metadata line are not the conversation.
  assert.ok(lines.some(line => line.type === 'info') && lines.some(line => line.$set));
});

test('a failed Gemini CLI tool call is an error result, not a success', () => {
  const failed = { id: 'g-9', timestamp: '2026-11-25T10:01:00.000Z', type: 'gemini', content: '', toolCalls: [{ id: 'c-1', name: 'run_shell_command',
    args: { command: 'false' }, status: 'error', timestamp: '2026-11-25T10:01:01.000Z',
    result: [{ functionResponse: { id: 'c-1', name: 'run_shell_command', response: { error: 'exit 1' } } }] }] };
  const [result] = mapGemini(failed, 0, {}).filter(event => event.kind === 'tool_result');
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.output, 'exit 1');
});

test('the real stream and checkpoint read a Gemini CLI session under its own timeline', async t => {
  const stateDir = await scratch(t);
  const calls = [];
  const request = async (route, body) => { calls.push({ route, body }); return {}; };
  const stream = await streamSession({ payload: payload('Stop'), host: 'gemini-cli', repo: 'fixture/gemini', stateDir, request });
  assert.equal(stream.transcript_format, 'gemini-chat-recording');
  assert.equal(stream.session_id, `gemini-cli-${SESSION}`);
  const sent = calls.filter(call => call.route === '/session/events').flatMap(call => call.body.events);
  assert.ok(sent.some(event => event.kind === 'tool_call'));
  assert.ok(sent.some(event => event.kind === 'customer_message' && event.payload.text === 'read the readme'));
  const { messages, client } = await readTranscriptMessages({ path: FIXTURE, host: 'gemini-cli' });
  // One message per id, in its final form: the re-appended reply is not said twice, and the tool-call-only message says nothing.
  assert.deepEqual(messages.map(message => [message.role, message.content]),
    [['user', 'read the readme'], ['assistant', 'The readme says hello.']]);
  assert.equal(client.name, 'gemini-cli');
});

test('a transcript read for a host that repeats ids does not drop Claude Code messages that share one', async t => {
  const directory = await scratch(t);
  const path = join(directory, 'claude.jsonl');
  const line = (type, id, text) => JSON.stringify({ type, uuid: text, timestamp: '2026-11-25T10:00:00.000Z', message: { id, role: type, content: text } });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, [line('user', 'a', 'one'), line('assistant', 'same', 'two'), line('assistant', 'same', 'three')].join('\n') + '\n');
  const { messages } = await readTranscriptMessages({ path, host: 'claude-code' });
  assert.deepEqual(messages.map(message => message.content), ['one', 'two', 'three']);
});

test('the real hook runner answers a Gemini CLI prompt with recall in Gemini CLI\'s own output shape', async t => {
  const directory = await scratch(t);
  const repo = join(directory, 'repo');
  for (const args of [['init', '-q', repo], ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fixture/gemini-hooks.git']]) {
    assert.equal(spawnSync('git', args, { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0);
  }
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior !== undefined) process.env.ESTELLE_REPO = prior; });
  const bodies = [];
  const request = async (route, body) => { bodies.push({ route, body }); return route === '/search' ? { recall: 'we chose JSON mode' } : {}; };
  const output = await handleHook({ host: 'gemini-cli', stateDir: join(directory, 'state'),
    payload: { ...payload('BeforeAgent', { prompt: 'what did we decide?' }), cwd: repo }, request });
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'we chose JSON mode' } });
  const search = bodies.find(call => call.route === '/search');
  assert.equal(search?.body.host, 'gemini-cli');
  assert.equal(search?.body.timeline_session, `gemini-cli-${SESSION}`);
  const start = await handleHook({ host: 'gemini-cli', stateDir: join(directory, 'state'),
    payload: { ...payload('SessionStart', { source: 'startup' }), cwd: repo }, request });
  assert.match(start.hookSpecificOutput.additionalContext, /estelle_resume/);
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('a key written by write_file is warned about on BeforeTool, in systemMessage, and the write is never blocked', async t => {
  const directory = await scratch(t);
  const key = `sk_live_${'a1B2c3D4e5F6g7H8i9J0k1L2'}`;
  const out = await handleHook({ host: 'gemini-cli', stateDir: join(directory, 'state'), request: async () => ({}),
    payload: payload('BeforeTool', { tool_name: 'write_file', tool_input: { file_path: 'config.js', content: `const k = "${key}";` } }) });
  assert.ok(out?.systemMessage, JSON.stringify(out));
  assert.ok(!JSON.stringify(out).includes(key), 'names the kind of key, never the value');
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput, undefined, 'BeforeTool output cannot carry context to the model');
});

test('the Gemini CLI extension: OAuth-ready MCP, hooks on the variables Gemini CLI fills in, TOML commands and agents', async () => {
  const manifest = await json('plugins/gemini/gemini-extension.json');
  // URL only: Gemini CLI signs in with OAuth (`/mcp auth Estelle`). A pinned header would disable that.
  assert.deepEqual(manifest.mcpServers, { Estelle: { httpUrl: 'https://api.fatelabs.ca/mcp' } });
  assert.equal(manifest.contextFileName, 'instructions.md');
  assert.equal(manifest.name, 'estelle');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false, 'hooks live in hooks/hooks.json, not the manifest');
  const hooks = (await json('plugins/gemini/hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [...HOOK_EVENTS].sort());
  for (const [event, rows] of Object.entries(hooks)) {
    const hook = rows[0].hooks[0];
    // Gemini CLI fills in only ${extensionPath}, ${workspacePath} and ${/} in an extension's hooks.
    assert.equal(hook.command, 'node "${extensionPath}${/}runtime${/}cli.mjs" hook gemini-cli');
    assert.equal(hook.type, 'command');
    // Milliseconds: a bare 20 would kill every hook after 20 ms.
    assert.equal(hook.timeout, event === 'SessionEnd' ? 3000 : 20000);
  }
  assert.equal(hooks.BeforeTool[0].matcher, 'write_file|replace');
  const commands = await readdir(join(root, 'plugins', 'gemini', 'commands', 'estelle'));
  assert.deepEqual(commands.map(file => file.replace('.toml', '')).sort(), (await readdir(join(root, 'commands'))).map(file => file.replace('.md', '')).sort());
  for (const file of commands) {
    const text = await readFile(join(root, 'plugins', 'gemini', 'commands', 'estelle', file), 'utf8');
    assert.match(text, /^description = ".+"\nprompt = '''\n/);
    assert.doesNotMatch(text, /\$ARGUMENTS|<Estelle cli\.mjs>/);
    const source = await readFile(join(root, 'commands', file.replace('.toml', '.md')), 'utf8');
    if (source.includes('$ARGUMENTS')) assert.match(text, /\{\{args\}\}/);
  }
  for (const file of await readdir(join(root, 'plugins', 'gemini', 'agents'))) {
    const text = await readFile(join(root, 'plugins', 'gemini', 'agents', file), 'utf8');
    assert.match(text, /^---\nname: estelle-[a-z]+\ndescription: .+\ntools:\n(  - [a-z_A-Z]+\n)+---\n/);
    assert.doesNotMatch(text, /mcp__|\n  - (Read|Grep|Glob|Bash)\n/, 'Gemini CLI tool names only');
  }
  await readFile(join(root, 'plugins', 'gemini', 'runtime', 'cli.mjs'));
  await readFile(join(root, 'plugins', 'gemini', 'skills', 'estelle', 'SKILL.md'));
});
