import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/pi.mjs';
import estelle, { activate, completer, DIRECT_TOOLS, estelleServer } from '../adapters/pi-extension.mjs';
import { readCommands } from '../adapters/host-bridge.mjs';
import { mapPi, streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import { handleHook } from '../runtime/hooks.mjs';

const root = resolve(import.meta.dirname, '..');
const CWD = '/tmp/pi-project';
const SESSION = '01a1f138-98c2-7430-a93a-461d7b38e39e';
const envelope = (event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd: CWD, ...extra });

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-pi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('maps every Pi event the extension sends onto one Estelle event', () => {
  const expected = { session_start: 'SessionStart', before_agent_start: 'UserPromptSubmit', tool_call: 'PreToolUse',
    tool_result: 'PostToolUse', agent_settled: 'Stop', session_before_compact: 'PreCompact', session_shutdown: 'SessionEnd' };
  assert.deepEqual([...HOOK_EVENTS].sort(), Object.keys(expected).sort());
  for (const [native, event] of Object.entries(expected)) {
    const result = normalize(envelope(native, ['PreToolUse', 'PostToolUse'].includes(event) ? { tool_name: 'read' } : {}));
    assert.equal(result.event, event);
    assert.equal(result.host, 'pi');
  }
  assert.equal(normalize(envelope('tool_call', { tool_name: 'write' })).toolName, 'Write');
  assert.equal(normalize(envelope('tool_call', { tool_name: 'edit' })).toolName, 'Edit');
  for (const bad of [envelope('input'), envelope('tool_call'), envelope('session_start', { session_id: '../x' })]) {
    assert.throws(() => normalize(bad), TypeError);
  }
  assert.deepEqual(formatContext('x', 'UserPromptSubmit'), { additionalContext: 'x' });
  assert.equal(formatContext('x', 'Stop'), null);
});

test('the MCP server entry signs in with the environment key, or leaves Pi’s OAuth free to', () => {
  const keyed = estelleServer({ ESTELLE_API_KEY: 'est_fixture' });
  assert.equal(keyed.url, 'https://api.fatelabs.ca/mcp');
  assert.deepEqual(keyed.headers, { Authorization: 'Bearer est_fixture' });
  assert.equal(keyed.exposure, 'deferred');
  assert.equal(keyed.toolExposure.estelle_resume, 'direct');
  assert.equal(Object.hasOwn(keyed.toolExposure, 'review'), false, 'review stays deferred: its root oneOf breaks some providers');
  assert.ok(DIRECT_TOOLS.includes('estelle_grep') && DIRECT_TOOLS.includes('verify'));
  assert.equal(Object.hasOwn(estelleServer({}), 'headers'), false);
  assert.equal(Object.hasOwn(estelleServer({ ESTELLE_API_KEY: 'a\nb' }), 'headers'), false);
});

function fakePi() {
  const handlers = new Map();
  const pi = { servers: [], sent: [],
    registerMcpServer: (name, config) => pi.servers.push({ name, config }),
    registerCommand: () => { throw new Error('commands are input transforms, not registered commands'); },
    sendUserMessage: text => pi.sent.push(text),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
  const emit = async (event, payload, ctx) => {
    let last;
    for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
    return last;
  };
  return { pi, handlers, emit };
}

const ctx = (extra = {}) => ({ cwd: CWD, hasUI: false, sessionManager: { getSessionId: () => SESSION, getSessionFile: () => '/tmp/s.jsonl' }, ...extra });

test('the extension registers Estelle and places start text, recall, mail and a write warning', async () => {
  const { pi, handlers, emit } = fakePi();
  const calls = [];
  const answers = { session_start: { additionalContext: 'START and identity' }, before_agent_start: { additionalContext: 'recalled decision' },
    tool_call: { warning: 'Estelle warning: key' }, tool_result: { additionalContext: '[ESTELLE SESSION MAIL] hello' } };
  const run = async (host, payload) => { calls.push({ host, payload }); return answers[payload.hook_event_name] ?? null; };
  await activate(pi, { env: { ESTELLE_API_KEY: 'est_fixture' }, run, instructions: 'GUIDE', commands: await readCommands(root) });
  assert.deepEqual(pi.servers.map(server => server.name), ['Estelle']);
  assert.deepEqual([...handlers.keys()].sort(), ['agent_settled', 'before_agent_start', 'input', 'session_before_compact',
    'session_shutdown', 'session_start', 'tool_call', 'tool_result']);
  await emit('session_start', { reason: 'startup' }, ctx());
  const sections = {};
  const answer = await emit('before_agent_start', { messageType: 'user', prompt: 'fix it', systemPromptOptions: { sections } }, ctx());
  assert.deepEqual(sections, { estelle: 'GUIDE', estelle_session: 'START and identity' });
  assert.deepEqual(answer, { message: { customType: 'estelle-recall', content: 'recalled decision', display: false } });
  assert.equal(await emit('tool_call', { toolName: 'write', toolCallId: 't1', input: { path: 'a', content: 'x' } }, ctx()), undefined,
    'a warning never blocks');
  const result = await emit('tool_result', { toolName: 'write', toolCallId: 't1', input: {}, content: [{ type: 'text', text: 'ok' }] }, ctx());
  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }, { type: 'text', text: 'Estelle warning: key\n\n[ESTELLE SESSION MAIL] hello' }]);
  await emit('agent_settled', { aborted: false }, ctx());
  const sent = calls.map(call => call.payload);
  assert.ok(sent.every(payload => payload.session_id === SESSION && payload.transcript_path === '/tmp/s.jsonl'));
  assert.equal(sent.find(payload => payload.hook_event_name === 'before_agent_start').prompt, 'fix it');
  assert.deepEqual(sent.map(payload => payload.hook_event_name),
    ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'agent_settled']);
  // A run Pi started from an extension message is not the person's prompt: no recall request for it.
  assert.equal(await emit('before_agent_start', { messageType: 'custom', systemPromptOptions: { sections: {} } }, ctx()), undefined);
  assert.equal(calls.length, 5);
});

test('an unwired runner leaves Pi’s prompt, tool results and sections as they were', async () => {
  const { pi, emit } = fakePi();
  await activate(pi, { env: {}, run: async () => null, instructions: 'GUIDE', commands: [] });
  await emit('session_start', {}, ctx());
  const sections = {};
  assert.equal(await emit('before_agent_start', { messageType: 'user', prompt: 'p', systemPromptOptions: { sections } }, ctx()), undefined);
  assert.deepEqual(sections, { estelle: 'GUIDE' });
  assert.equal(await emit('tool_result', { toolName: 'read', toolCallId: 't', content: [] }, ctx()), undefined);
});

test('/estelle:<name> becomes the shared command’s prompt; other input passes through', async () => {
  const { pi, emit } = fakePi();
  await activate(pi, { env: {}, run: async () => null, instructions: '', commands: await readCommands(root) });
  const resume = await emit('input', { text: '/estelle:resume the auth work', source: 'interactive' }, ctx());
  assert.equal(resume.action, 'transform');
  assert.match(resume.text, /^Call estelle_resume for the auth work\./);
  const cloud = await emit('input', { text: '/estelle:cloud fix the flaky test', source: 'interactive' }, ctx());
  assert.ok(cloud.text.includes(`node "${join(root, 'runtime', 'cli.mjs')}" move cloud`));
  assert.ok(cloud.text.includes('fix the flaky test'));
  assert.deepEqual(await emit('input', { text: '/estelle:nope x' }, ctx()), { action: 'continue' });
  assert.deepEqual(await emit('input', { text: 'please /estelle:resume' }, ctx()), { action: 'continue' });
});

test('autocomplete offers the Estelle commands and hands everything else to Pi', async () => {
  const commands = new Map((await readCommands(root)).map(item => [item.name, item]));
  const fallback = { triggerCharacters: ['@'], getSuggestions: async () => 'pi-own', applyCompletion: () => 'applied' };
  const provider = completer(fallback, commands);
  const offered = await provider.getSuggestions(['/estelle:r'], 0, 10, {});
  assert.deepEqual(offered.items.map(item => item.value), ['/estelle:review', '/estelle:resume', '/estelle:rooms'].sort());
  assert.equal(await provider.getSuggestions(['hello'], 0, 5, {}), 'pi-own');
  assert.equal(provider.applyCompletion(), 'applied');
  assert.deepEqual(provider.triggerCharacters, ['@']);
});

test('the default export is the factory Pi loads', () => assert.equal(typeof estelle, 'function'));

// Lines in Pi's own session format (docs/session-format.md v3), as Pi 1.5.2 wrote them in a live run.
const SESSION_LINES = [
  { type: 'session', version: 3, id: SESSION, timestamp: '2026-11-19T00:33:00.611Z', cwd: CWD },
  { type: 'message', id: 'a0', parentId: null, timestamp: '2026-11-19T00:33:01.000Z', message: { role: 'system', content: '', sections: { preamble: 'x' } } },
  { type: 'message', id: 'a1', parentId: 'a0', timestamp: '2026-11-19T00:33:01.500Z', message: { role: 'user', content: [{ type: 'text', text: 'find the README' }], timestamp: 1 } },
  { type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-11-19T00:33:01.600Z', message: { role: 'custom', customType: 'estelle-recall', content: 'recall', display: false, timestamp: 2 } },
  { type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-11-19T00:33:05.000Z', message: { role: 'assistant', model: 'grok-4.3', stopReason: 'toolUse',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    content: [{ type: 'thinking', thinking: 'look' }, { type: 'toolCall', id: 'call_1', name: 'mcp__Estelle__estelle_grep', arguments: { pattern: 'sandbox' } }] } },
  { type: 'message', id: 'a4', parentId: 'a3', timestamp: '2026-11-19T00:33:06.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'mcp__Estelle__estelle_grep',
    content: [{ type: 'text', text: 'README.md:1' }], isError: false } },
  { type: 'message', id: 'a5', parentId: 'a4', timestamp: '2026-11-19T00:33:08.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'It is in README.md.' }] } },
  { type: 'model_change', id: 'a6', parentId: 'a5', timestamp: '2026-11-19T00:33:09.000Z', provider: 'xai', modelId: 'grok-4.3' },
];

test('Pi’s own session lines map to the person, the agent, its tools and the turn end', () => {
  const events = SESSION_LINES.flatMap((line, index) => mapPi(line, index, {}));
  assert.deepEqual(events.map(item => item.kind), ['customer_message', 'lifecycle', 'thinking', 'tool_call', 'tool_result', 'agent_message', 'lifecycle']);
  assert.equal(events[0].payload.text, 'find the README');
  assert.equal(events[3].payload.tool, 'mcp__Estelle__estelle_grep');
  assert.equal(events[3].author.kind, 'estelle');
  assert.equal(events[4].payload.call_id, 'call_1');
  assert.equal(events[2].payload.usage.input, 100);
  assert.equal(events.at(-1).payload.state, 'waiting_for_review');
  assert.ok(!events.some(item => item.payload?.text === 'recall'), 'extension messages are not conversation');
});

test('a Pi session file streams under pi-<id> and checkpoints its conversation', async t => {
  const directory = await scratch(t);
  const path = join(directory, 'session.jsonl');
  await writeFile(path, SESSION_LINES.map(line => JSON.stringify(line)).join('\n') + '\n');
  const sent = [];
  const result = await streamSession({ payload: { session_id: SESSION, cwd: CWD, transcript_path: path, hook_event_name: 'Stop' },
    host: 'pi', repo: 'fixture/repo', stateDir: join(directory, 'state'), request: async (route, body) => { sent.push(body); return {}; } });
  assert.equal(result.session_id, `pi-${SESSION}`);
  assert.equal(result.transcript_format, 'pi-session-v3');
  assert.equal(result.incomplete, false);
  assert.ok(sent.flatMap(body => body.events).some(item => item.kind === 'agent_message' && item.author.id === 'pi'));
  const checkpoint = await readTranscriptMessages({ path, host: 'pi' });
  assert.deepEqual(checkpoint.messages.map(message => [message.role, message.content]),
    [['user', 'find the README'], ['assistant', 'It is in README.md.']]);
  assert.equal(checkpoint.client.cwd, CWD);
  assert.ok((await readFile(path, 'utf8')).length > 0);
});

test('the real hook runner answers a Pi prompt with recall and records it under the pi host', async t => {
  const directory = await scratch(t);
  const repo = join(directory, 'repo');
  for (const args of [['init', '-q', repo], ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fixture/pi-hooks.git']]) {
    assert.equal(spawnSync('git', args, { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0);
  }
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior !== undefined) process.env.ESTELLE_REPO = prior; });
  const stateDir = join(directory, 'state');
  const bodies = [];
  const output = await handleHook({ host: 'pi', stateDir, payload: { ...envelope('before_agent_start', { prompt: 'what did we decide?' }), cwd: repo },
    request: async (route, body) => { bodies.push({ route, body }); return route === '/search' ? { recall: 'we chose JSON mode' } : {}; } });
  assert.deepEqual(output, { additionalContext: 'we chose JSON mode' });
  const search = bodies.find(call => call.route === '/search');
  assert.equal(search?.body.host, 'pi');
  assert.equal(search?.body.repo, 'fixture/pi-hooks');
  assert.equal(search?.body.timeline_session, `pi-${SESSION}`);
});
