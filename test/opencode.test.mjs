import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/opencode.mjs';
import { createHooks, estelleConfig } from '../adapters/opencode-plugin.mjs';
import { linesFor, mirrorPath, spawningCall, syncMirror } from '../adapters/opencode-mirror.mjs';
import { readAgents, readCommands } from '../adapters/host-bridge.mjs';
import { handleHook } from '../runtime/hooks.mjs';
import { streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import pluginModule from '../adapters/opencode-plugin.mjs';

const root = resolve(import.meta.dirname, '..');
const CWD = '/tmp/opencode-project';
const envelope = (event, extra = {}) => ({ hook_event_name: event, session_id: 'ses_abc123', cwd: CWD, ...extra });

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-opencode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('maps every OpenCode hook the plugin sends onto one Estelle event', () => {
  const expected = { 'session.created': 'SessionStart', 'session.seen': 'SessionStart', 'chat.message': 'UserPromptSubmit',
    'tool.execute.before': 'PreToolUse', 'tool.execute.after': 'PostToolUse', 'session.idle': 'Stop',
    'experimental.session.compacting': 'PreCompact', 'session.deleted': 'SessionEnd' };
  assert.deepEqual([...HOOK_EVENTS].sort(), Object.keys(expected).sort());
  for (const [native, event] of Object.entries(expected)) {
    const tool = ['PreToolUse', 'PostToolUse'].includes(event) ? { tool_name: 'bash' } : {};
    const result = normalize(envelope(native, tool));
    assert.equal(result.event, event);
    assert.equal(result.host, 'opencode');
    assert.equal(result.agentId, null);
  }
});

test('a child session starts as a subagent and never pulls the main conversation’s mail', () => {
  const start = normalize(envelope('session.created', { parent_session_id: 'ses_parent' }));
  assert.equal(start.event, 'SubagentStart');
  assert.equal(start.agentId, 'ses_abc123');
  assert.equal(normalize(envelope('tool.execute.after', { tool_name: 'bash', parent_session_id: 'ses_parent' })).agentId, 'ses_abc123');
});

test('OpenCode file tools get the same write warning names as every other host', () => {
  for (const [native, shared] of [['write', 'Write'], ['edit', 'Edit'], ['multiedit', 'MultiEdit'], ['patch', 'apply_patch'], ['bash', 'bash']]) {
    assert.equal(normalize(envelope('tool.execute.before', { tool_name: native, tool_input: {} })).toolName, shared);
  }
});

test('rejects malformed envelopes instead of guessing', () => {
  for (const value of [null, [], envelope('session.compacted'), envelope('chat.message', { session_id: 'bad id' }),
    envelope('chat.message', { cwd: 'relative' }), envelope('tool.execute.after'), envelope('chat.message', { prompt: 3 }),
    envelope('session.created', { parent_session_id: 'bad parent' })]) {
    assert.throws(() => normalize(value), TypeError);
  }
});

test('context goes to the start, the prompt and the tool result, and nowhere else', () => {
  for (const event of ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse']) {
    assert.deepEqual(formatContext('recall', event), { additionalContext: 'recall' });
  }
  for (const event of ['PreToolUse', 'Stop', 'PreCompact', 'SessionEnd']) assert.equal(formatContext('recall', event), null);
  assert.equal(formatContext('  ', 'UserPromptSubmit'), null);
});

test('the config hook adds Estelle without replacing what the person configured', async () => {
  const commands = await readCommands(root);
  const agents = await readAgents(root);
  assert.deepEqual(commands.map(item => item.name), ['cloud', 'code', 'handoff', 'monitor', 'resume', 'review', 'rooms']);
  assert.deepEqual(agents.map(item => item.name), ['estelle-grounder', 'estelle-historian', 'estelle-repair', 'estelle-reviewer']);
  const keyed = estelleConfig({}, { commands, agents, root, env: { ESTELLE_API_KEY: 'est_fixture' } });
  assert.deepEqual(keyed.mcp.Estelle, { type: 'remote', url: 'https://api.fatelabs.ca/mcp', enabled: true,
    headers: { Authorization: 'Bearer est_fixture' } });
  // No key: no header, so OpenCode's own MCP OAuth can sign in.
  assert.deepEqual(estelleConfig({}, { commands, agents, root, env: {} }).mcp.Estelle,
    { type: 'remote', url: 'https://api.fatelabs.ca/mcp', enabled: true });
  assert.equal(Object.keys(keyed.command).length, 7);
  const cloud = keyed.command['estelle:cloud'];
  assert.match(cloud.template, /\$ARGUMENTS/);
  assert.ok(cloud.template.includes(`node "${join(root, 'runtime', 'cli.mjs')}" move cloud`), 'the runner path is exact');
  assert.doesNotMatch(cloud.template, /<Estelle cli\.mjs>/);
  assert.equal(keyed.agent['estelle-reviewer'].mode, 'subagent');
  assert.deepEqual(keyed.instructions, [join(root, 'instructions.md')]);
  assert.deepEqual(keyed.skills.paths, [join(root, 'skills')]);
  const own = { mcp: { Estelle: { type: 'local', command: ['mine'] } }, command: { 'estelle:review': { template: 'mine' } },
    agent: { 'estelle-repair': { prompt: 'mine' } }, instructions: ['AGENTS.md'], skills: { paths: ['x'] } };
  const merged = estelleConfig(own, { commands, agents, root, env: {} });
  assert.deepEqual(merged.mcp.Estelle, own.mcp.Estelle);
  assert.equal(merged.command['estelle:review'].template, 'mine');
  assert.equal(merged.agent['estelle-repair'].prompt, 'mine');
  assert.deepEqual(merged.instructions, ['AGENTS.md', join(root, 'instructions.md')]);
  assert.deepEqual(merged.skills.paths, ['x', join(root, 'skills')]);
});

test('the module has the shape OpenCode 1.19 loads: a default { id, server }', () => {
  assert.equal(pluginModule.id, 'estelle');
  assert.equal(typeof pluginModule.server, 'function');
});

function recorder(answers = {}) {
  const calls = [];
  return { calls, run: async (host, payload) => {
    calls.push({ host, payload });
    return answers[payload.hook_event_name] ?? null;
  } };
}

test('wired hooks place start text, recall, mail and a write warning where OpenCode shows them', async t => {
  const stateDir = await scratch(t);
  const { calls, run } = recorder({ 'session.created': { additionalContext: 'START and identity' },
    'chat.message': { additionalContext: 'recalled decision' }, 'tool.execute.before': { warning: 'Estelle warning: key' },
    'tool.execute.after': { additionalContext: '[ESTELLE SESSION MAIL] hello' } });
  const hooks = createHooks({ directory: CWD, stateDir, run, messagesOf: async () => [] });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_abc123' } } } });
  const system = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_abc123' }, system);
  assert.deepEqual(system.system, ['START and identity']);
  const message = { message: { id: 'msg_01' }, parts: [{ type: 'text', text: 'fix the bug' }] };
  await hooks['chat.message']({ sessionID: 'ses_abc123', model: { modelID: 'm' } }, message);
  assert.equal(message.parts.length, 2);
  assert.deepEqual(message.parts[1], { id: 'prt_01estelle', sessionID: 'ses_abc123', messageID: 'msg_01', type: 'text',
    text: 'recalled decision', synthetic: true });
  await hooks['tool.execute.before']({ tool: 'write', sessionID: 'ses_abc123', callID: 'c1' }, { args: { filePath: 'a', content: 'x' } });
  const result = { title: '', output: 'wrote a', metadata: {} };
  await hooks['tool.execute.after']({ tool: 'write', sessionID: 'ses_abc123', callID: 'c1', args: {} }, result);
  assert.equal(result.output, 'wrote a\n\nEstelle warning: key\n\n[ESTELLE SESSION MAIL] hello');
  const prompt = calls.find(call => call.payload.hook_event_name === 'chat.message').payload;
  assert.equal(prompt.prompt, 'fix the bug');
  assert.equal(prompt.transcript_path, mirrorPath(stateDir, 'ses_abc123'));
  // SessionStart ran once even though three hooks asked for it.
  assert.equal(calls.filter(call => ['session.created', 'session.seen'].includes(call.payload.hook_event_name)).length, 1);
  // Unwired: the same events with an empty runner change nothing.
  const quiet = createHooks({ directory: CWD, stateDir, run: async () => null, messagesOf: async () => [] });
  const untouched = { message: { id: 'msg_02' }, parts: [{ type: 'text', text: 'x' }] };
  await quiet['chat.message']({ sessionID: 'ses_zzz' }, untouched);
  assert.equal(untouched.parts.length, 1);
});

test('a resumed session the plugin never saw created still starts once', async t => {
  const { calls, run } = recorder();
  const hooks = createHooks({ directory: CWD, stateDir: await scratch(t), run, messagesOf: async () => [] });
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_old' }, { system: [] });
  await hooks['chat.message']({ sessionID: 'ses_old' }, { message: { id: 'msg_1' }, parts: [] });
  assert.deepEqual(calls.map(call => call.payload.hook_event_name), ['session.seen', 'chat.message']);
});

const finished = [
  { info: { id: 'msg_u', role: 'user', time: { created: Date.parse('2026-11-18T10:00:00Z') } },
    parts: [{ id: 'prt_u1', type: 'text', text: 'find the bug' }, { id: 'prt_u2', type: 'text', text: 'recall', synthetic: true }] },
  { info: { id: 'msg_a', role: 'assistant', modelID: 'grok', tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } },
    time: { created: Date.parse('2026-11-18T10:00:01Z'), completed: Date.parse('2026-11-18T10:00:05Z') } },
  parts: [{ id: 'prt_a1', type: 'reasoning', text: 'thinking' },
    { id: 'prt_a2', type: 'tool', tool: 'Estelle_estelle_grep', callID: 'call_1',
      state: { status: 'completed', input: { pattern: 'x' }, output: 'one match', time: { start: Date.parse('2026-11-18T10:00:02Z'), end: Date.parse('2026-11-18T10:00:03Z') } } },
    { id: 'prt_a3', type: 'text', text: 'Found it.' }] },
];

test('the mirror writes each finished part once, skips synthetic text, and marks the turn end', async t => {
  const path = join(await scratch(t), 'transcripts', 'opencode-ses_m.jsonl');
  const written = new Set();
  assert.equal(await syncMirror({ messages: finished, path, written, idle: true }), 6);
  assert.equal(await syncMirror({ messages: finished, path, written: new Set(), idle: true }), 0, 'reseeded from the file');
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.uuid), ['prt_u1', 'prt_a1', 'prt_a2:call', 'prt_a2:result', 'prt_a3', 'msg_a:turn-end']);
  assert.equal(lines[1].message.usage.input_tokens, 10);
  // An unfinished assistant message is not written yet.
  assert.deepEqual(linesFor({ info: { id: 'm', role: 'assistant', time: { created: 1 } }, parts: [{ id: 'p', type: 'text', text: 'partial' }] }), []);
});

test('the mirror streams as OpenCode’s own harness and checkpoints its conversation', async t => {
  const stateDir = await scratch(t);
  const path = mirrorPath(stateDir, 'ses_m');
  await syncMirror({ messages: finished, path, written: new Set(), idle: true });
  const sent = [];
  const request = async (route, body) => { sent.push({ route, body }); return {}; };
  const result = await streamSession({ payload: { session_id: 'ses_m', cwd: CWD, transcript_path: path, hook_event_name: 'Stop' },
    host: 'opencode', repo: 'fixture/repo', stateDir, request });
  assert.equal(result.session_id, 'opencode-ses_m');
  assert.equal(result.transcript_format, 'opencode-plugin-mirror');
  const events = sent.flatMap(call => call.body.events);
  assert.ok(events.some(item => item.kind === 'customer_message' && item.payload.text === 'find the bug'));
  assert.ok(events.some(item => item.kind === 'tool_call' && item.author.id === 'opencode'));
  assert.ok(events.some(item => item.kind === 'agent_message' && item.author.id === 'opencode'));
  assert.ok(!events.some(item => item.payload?.text === 'recall'), 'synthetic recall is not the person’s words');
  const checkpoint = await readTranscriptMessages({ path, host: 'opencode' });
  assert.deepEqual(checkpoint.messages.map(message => [message.role, message.content]),
    [['user', 'find the bug'], ['assistant', '[tool: Estelle_estelle_grep]'], ['assistant', 'Found it.']]);
  assert.equal(checkpoint.client.name, 'opencode');
});

test('the real hook runner gives an OpenCode session its identity and mail at start', async t => {
  const stateDir = await scratch(t);
  const calls = [];
  const request = async (route, body) => {
    calls.push({ route, body });
    if (route !== '/session/mail') return {};
    return { context: body.action === 'identity' ? '[ESTELLE] id opencode-ses_abc123' : '[ESTELLE SESSION MAIL] waiting' };
  };
  const output = await handleHook({ host: 'opencode', payload: envelope('session.created'), stateDir, request });
  assert.match(output.additionalContext, /call estelle_resume before planning/);
  assert.match(output.additionalContext, /cloud session .* is estelle_move/);
  assert.match(output.additionalContext, /ask estelle_docs before saying you don't know/);
  assert.match(output.additionalContext, /\[ESTELLE\] id opencode-ses_abc123/);
  assert.match(output.additionalContext, /waiting/);
  const mail = calls.filter(call => call.route === '/session/mail');
  assert.deepEqual(mail.map(call => call.body.action).sort(), ['deliver', 'identity']);
  assert.ok(mail.every(call => call.body.session_id === 'opencode-ses_abc123'));
});

test('the write warning reaches the plugin as words and never as a block', async t => {
  const stateDir = await scratch(t);
  const key = ['sk', 'ant', 'api03', 'A'.repeat(93)].join('-') + 'AA';
  const output = await handleHook({ host: 'opencode', stateDir, request: async () => ({}),
    payload: envelope('tool.execute.before', { tool_name: 'write', tool_input: { filePath: 'config.js', content: `const k = "${key}"` } }) });
  assert.match(output?.warning ?? '', /config\.js now holds what looks like a real/);
  assert.equal(Object.hasOwn(output, 'permission'), false);
});

test('the person’s message is in the mirror at once, and dispose saves a turn that never reached idle', async t => {
  const stateDir = await scratch(t);
  const { calls, run } = recorder();
  const hooks = createHooks({ directory: CWD, stateDir, run, messagesOf: async () => [] });
  await hooks['chat.message']({ sessionID: 'ses_run' }, { message: { id: 'msg_1', time: { created: Date.parse('2026-11-18T10:00:00Z') } },
    parts: [{ id: 'prt_1', type: 'text', text: 'grep for sandbox' }] });
  const path = mirrorPath(stateDir, 'ses_run');
  assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line).uuid), ['prt_1']);
  await hooks.dispose();
  assert.deepEqual(calls.map(call => call.payload.hook_event_name), ['session.seen', 'chat.message', 'session.idle']);
  await hooks.dispose();
  assert.equal(calls.length, 3, 'a saved turn is not saved twice');
  // A session that reached idle is not stopped again at dispose.
  await hooks['chat.message']({ sessionID: 'ses_run' }, { message: { id: 'msg_2' }, parts: [] });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_run' } } });
  await hooks.dispose();
  assert.deepEqual(calls.slice(3).map(call => call.payload.hook_event_name), ['chat.message', 'session.idle']);
});

// OpenCode's task tool (packages/opencode/src/tool/task.ts, `ctx.metadata`) names the child session it created on its
// own running tool part: `state.metadata.sessionId`, beside `callID`. Shapes from OpenCode's source, not a live session.
const taskPart = (child, status = 'running') => ({ id: 'prt_task', type: 'tool', tool: 'task', callID: 'toolu_task_1',
  state: { status, title: 'Find the flaky test', input: { description: 'Find the flaky test', prompt: 'Look in tests/' },
    metadata: { parentSessionId: 'ses_root', sessionId: child }, time: { start: Date.parse('2026-11-18T10:00:02Z') } } });
const parentMessages = child => [{ info: { id: 'msg_p', role: 'assistant', time: { created: Date.parse('2026-11-18T10:00:01Z') } },
  parts: [taskPart(child)] }];
const childMessages = [
  { info: { id: 'msg_cu', role: 'user', time: { created: Date.parse('2026-11-18T10:00:03Z') } }, parts: [{ id: 'prt_cu', type: 'text', text: 'Look in tests/' }] },
  { info: { id: 'msg_ca', role: 'assistant', time: { created: Date.parse('2026-11-18T10:00:04Z'), completed: Date.parse('2026-11-18T10:00:06Z') } },
    parts: [{ id: 'prt_ct', type: 'tool', tool: 'bash', callID: 'call_c1', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok',
      time: { start: Date.parse('2026-11-18T10:00:04Z'), end: Date.parse('2026-11-18T10:00:05Z') } } },
    { id: 'prt_cx', type: 'text', text: 'It is tests/a.test.js' }] },
];

test('a child session is linked to the task call that created it, through the parent’s own tool part', () => {
  assert.deepEqual(spawningCall(parentMessages('ses_child'), 'ses_child'), { call: 'toolu_task_1', title: 'Find the flaky test' });
  assert.equal(spawningCall(parentMessages('ses_other'), 'ses_child'), null);
  assert.equal(spawningCall(null, 'ses_child'), null);
});

test('WIRED: a linked OpenCode child streams under its root as a subagent; UNWIRED: an unlinked one stays its own session', async t => {
  const stateDir = await scratch(t);
  const { calls, run } = recorder();
  const messagesOf = async id => (id === 'ses_root' ? parentMessages('ses_child') : id === 'ses_child' ? childMessages : []);
  const hooks = createHooks({ directory: CWD, stateDir, run, messagesOf });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_root' } } } });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root' } } } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  const idle = calls.find(call => call.payload.hook_event_name === 'session.idle').payload;
  assert.equal(idle.parent_call_id, 'toolu_task_1');
  assert.equal(idle.root_session_id, 'ses_root');
  const sent = [];
  const request = async (route, body) => { sent.push(body); return {}; };
  await streamSession({ payload: { ...idle, hook_event_name: 'Stop' }, host: 'opencode', repo: 'fixture/repo', stateDir, request });
  const child = 'opencode-ses_root/agent-toolu_task_1';
  assert.deepEqual(sent.map(body => body.session_id), [child]);
  const events = sent[0].events;
  assert.deepEqual(events[0].payload, { state: 'running', reason: 'started', title: 'Find the flaky test', repo: 'fixture/repo',
    origin: 'opencode', harness: 'subagent', parent: 'opencode-ses_root', call_id: 'toolu_task_1' });
  assert.equal(events.find(e => e.kind === 'agent_message' && e.payload.brief_to_subagent)?.payload.text, 'Look in tests/');
  assert.equal(events.find(e => e.kind === 'tool_call').author.id, 'subagent');
  assert.ok(!events.some(e => e.kind === 'customer_message'), 'the brief is not the person speaking');
  assert.deepEqual(events.at(-1).payload, { state: 'ended', reason: 'completed' });
  // The parent sends a follow-up to the same child: an explicit reopen, then a second end.
  await syncMirror({ messages: [...childMessages, { info: { id: 'msg_cu2', role: 'user', time: { created: Date.parse('2026-11-18T10:01:00Z') } },
    parts: [{ id: 'prt_cu2', type: 'text', text: 'Now fix it' }] }], path: idle.transcript_path, written: new Set() });
  await streamSession({ payload: { ...idle, hook_event_name: 'UserPromptSubmit' }, host: 'opencode', repo: 'fixture/repo', stateDir, request });
  assert.deepEqual(sent.at(-1).events.at(-1).payload, { state: 'running', reason: 'resumed' });
  // Unwired: the same child without the link is captured as its own session, as before.
  const own = [];
  const plain = { ...idle, parent_call_id: undefined, root_session_id: undefined, session_id: 'ses_child2', transcript_path: mirrorPath(stateDir, 'ses_child2') };
  await syncMirror({ messages: childMessages, path: plain.transcript_path, written: new Set(), idle: true });
  await streamSession({ payload: { ...plain, hook_event_name: 'Stop' }, host: 'opencode', repo: 'fixture/repo', stateDir,
    request: async (route, body) => { own.push(body); return {}; } });
  assert.deepEqual(own.map(body => body.session_id), ['opencode-ses_child2']);
  assert.ok(own[0].events.some(e => e.kind === 'customer_message'));
});
