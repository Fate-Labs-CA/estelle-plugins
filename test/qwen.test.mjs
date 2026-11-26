import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/qwen.mjs';
import { mapQwen, streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import { handleHook } from '../runtime/hooks.mjs';

const root = resolve(import.meta.dirname, '..');
// Real Qwen Code 0.28.0 chat recordings (local paths replaced): one plain turn with a tool call, one whose prompt
// carried a UserPromptSubmit hook's context as an extra part.
const FIXTURE = join(root, 'test', 'fixtures', 'qwen', 'session-0.28.0.jsonl');
const WITH_RECALL = join(root, 'test', 'fixtures', 'qwen', 'session-with-recall-0.28.0.jsonl');
const SESSION = 'a31c60da-f701-4ae8-af4b-0f30d30ca772';
const payload = (event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd: '/tmp/qwen-project',
  transcript_path: FIXTURE, ...extra });
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-qwen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Qwen Code hook payloads normalize under the qwen-code host, and file tools get the write check', () => {
  for (const event of HOOK_EVENTS) {
    const tool = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) ? { tool_name: 'read_file', tool_input: {} } : {};
    assert.equal(normalize(payload(event, tool)).host, 'qwen-code');
  }
  assert.equal(normalize(payload('PreToolUse', { tool_name: 'write_file', tool_input: {} })).toolName, 'Write');
  assert.equal(normalize(payload('PreToolUse', { tool_name: 'edit', tool_input: {} })).toolName, 'Edit');
  assert.equal(normalize(payload('UserPromptSubmit', { prompt: 'hi' })).prompt, 'hi');
  for (const bad of [payload('Nope'), payload('PreToolUse'), { ...payload('Stop'), session_id: '' }, []]) {
    assert.throws(() => normalize(bad), TypeError);
  }
  assert.deepEqual(formatContext('x', 'UserPromptSubmit'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' } });
  assert.equal(formatContext('x', 'Stop'), null);
  assert.equal(formatContext('  ', 'SessionStart'), null);
});

test('a real Qwen Code chat recording becomes the person, the tool call, its result and the reply', async () => {
  const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const events = lines.flatMap(line => mapQwen(line, 0, {}));
  assert.deepEqual(events.map(event => event.kind),
    ['customer_message', 'lifecycle', 'tool_call', 'tool_result', 'agent_message']);
  assert.equal(events[0].payload.text, 'read the readme');
  assert.equal(events[2].payload.tool, 'read_file');
  assert.equal(events[3].payload.output, 'hello\n');
  assert.equal(events[4].author.id, 'qwen-code');
  assert.equal(events[4].payload.usage.model, 'mock-model');
  // System records (telemetry, memory catalog) carry no conversation.
  assert.ok(lines.filter(line => line.type === 'system').length > 5);
});

test('the hook context Qwen Code appends to a prompt is not captured as the person\'s words', async () => {
  const lines = (await readFile(WITH_RECALL, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const prompt = lines.find(line => line.type === 'user');
  assert.ok(prompt.message.parts.some(part => part.text.startsWith('<qwen:user-prompt-submit-context>')), 'fixture carries the hook part');
  const said = lines.flatMap(line => mapQwen(line, 0, {})).filter(event => event.kind === 'customer_message');
  assert.deepEqual(said.map(event => event.payload.text), ['read the readme']);
  const { messages } = await readTranscriptMessages({ path: WITH_RECALL, host: 'qwen-code' });
  assert.equal(messages[0].content, 'read the readme');
});

test('the real stream and checkpoint read a Qwen Code session under its own timeline', async t => {
  const stateDir = await scratch(t);
  const calls = [];
  const request = async (route, body) => { calls.push({ route, body }); return {}; };
  const stream = await streamSession({ payload: payload('Stop'), host: 'qwen-code', repo: 'fixture/qwen', stateDir, request });
  assert.equal(stream.transcript_format, 'qwen-chat-recording');
  assert.equal(stream.session_id, `qwen-code-${SESSION}`);
  const sent = calls.filter(call => call.route === '/session/events').flatMap(call => call.body.events);
  assert.ok(sent.some(event => event.kind === 'tool_call'));
  const { messages, client } = await readTranscriptMessages({ path: FIXTURE, host: 'qwen-code' });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(client.name, 'qwen-code');
});

test('the real hook runner answers a Qwen Code prompt with recall in Qwen Code\'s own output shape', async t => {
  const directory = await scratch(t);
  const repo = join(directory, 'repo');
  for (const args of [['init', '-q', repo], ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fixture/qwen-hooks.git']]) {
    assert.equal(spawnSync('git', args, { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0);
  }
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior !== undefined) process.env.ESTELLE_REPO = prior; });
  const bodies = [];
  const output = await handleHook({ host: 'qwen-code', stateDir: join(directory, 'state'),
    payload: { ...payload('UserPromptSubmit', { prompt: 'what did we decide?' }), cwd: repo },
    request: async (route, body) => { bodies.push({ route, body }); return route === '/search' ? { recall: 'we chose JSON mode' } : {}; } });
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'we chose JSON mode' } });
  const search = bodies.find(call => call.route === '/search');
  assert.equal(search?.body.host, 'qwen-code');
  assert.equal(search?.body.timeline_session, `qwen-code-${SESSION}`);
});

test('the Qwen Code extension: OAuth-ready MCP, hooks on the path Qwen Code fills in, Markdown commands', async () => {
  const manifest = await json('plugins/qwen/qwen-extension.json');
  // URL only: Qwen Code signs in with OAuth from /mcp. A pinned header would disable that.
  assert.deepEqual(manifest.mcpServers, { Estelle: { httpUrl: 'https://api.fatelabs.ca/mcp' } });
  assert.equal(manifest.contextFileName, 'instructions.md');
  const hooks = (await json('plugins/qwen/hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const rows of Object.values(hooks)) {
    // Qwen Code substitutes only ${CLAUDE_PLUGIN_ROOT} in an extension's hooks (core/src/extension/variables.ts).
    assert.equal(rows[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs" hook qwen-code');
  }
  const commands = await readdir(join(root, 'plugins', 'qwen', 'commands', 'estelle'));
  assert.equal(commands.length, (await readdir(join(root, 'commands'))).length);
  for (const file of commands) {
    const text = await readFile(join(root, 'plugins', 'qwen', 'commands', 'estelle', file), 'utf8');
    assert.match(text, /^---\ndescription: .+\n---\n/);
    assert.doesNotMatch(text, /\$ARGUMENTS|<Estelle cli\.mjs>/);
    if (!/^log(?:in|out)\.md$/.test(file)) assert.match(text, /\{\{args\}\}/);
  }
  await readFile(join(root, 'plugins', 'qwen', 'runtime', 'cli.mjs'));
  await readFile(join(root, 'plugins', 'qwen', 'skills', 'estelle', 'SKILL.md'));
});
