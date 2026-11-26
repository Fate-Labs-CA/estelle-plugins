import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/openclaw.mjs';
import { activate, safeId } from '../adapters/openclaw-plugin.mjs';
import { linesFor, mirrorPath, syncMirror } from '../adapters/openclaw-mirror.mjs';
import { handleHook } from '../runtime/hooks.mjs';
import { MAILBOX_HOSTS } from '../runtime/mailbox.mjs';
import { timelineIdentity } from '../runtime/identity.mjs';
import { streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';

const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const MAIL = '[ESTELLE SESSION MAIL] from claude-code-x: the build is green';

async function repoFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'estelle-host-mail-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'https://github.com/fixture/host-mail.git']]) {
    const done = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
  }
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior === undefined) delete process.env.ESTELLE_REPO; else process.env.ESTELLE_REPO = prior; });
  return { directory, repo, stateDir: join(directory, 'state') };
}

function mailSpy(recall = '') {
  const calls = [];
  return { calls, request: async (route, body) => {
    calls.push({ route, body });
    if (route === '/search') return { recall };
    if (route === '/session/mail') return body.action === 'deliver' && body.boundary === 'tool' ? { context: MAIL } : {};
    return {};
  } };
}
const mailCalls = spy => spy.calls.filter(call => call.route === '/session/mail');

test('the hosts whose hooks can place text at a tool boundary pull mail there, and the others do not', () => {
  assert.deepEqual([...MAILBOX_HOSTS].sort(), ['claude-code', 'codex', 'cursor', 'openclaw', 'opencode', 'pi', 'qwen-code']);
  for (const host of ['grok', 'kimi', 'hermes', 'dsh']) assert.equal(MAILBOX_HOSTS.has(host), false, `${host} has no documented place for it`);
});

test('Qwen Code receives mail as PostToolUse additionalContext, and Grok pulls none', async t => {
  const f = await repoFixture(t);
  const spy = mailSpy();
  const output = await handleHook({ host: 'qwen-code', stateDir: f.stateDir, request: spy.request,
    payload: { hook_event_name: 'PostToolUse', session_id: 'qwen-1', cwd: f.repo, tool_name: 'read_file', tool_input: {}, tool_response: {} } });
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /the build is green/);
  // Qwen is also a supervised host now (feat/parity-hooks), so the same boundary asks for subagent news before mail.
  assert.deepEqual(mailCalls(spy).map(call => call.body).filter(body => body.action === 'deliver'),
    [{ action: 'deliver', session_id: timelineIdentity('qwen-code', 'qwen-1'), boundary: 'tool' }]);
  // Control: an unwired host's identical event asks the server for nothing.
  const grok = mailSpy();
  await handleHook({ host: 'grok', stateDir: f.stateDir, request: grok.request, payload: { hookEventName: 'PostToolUse', sessionId: 'grok-1',
    cwd: f.repo, toolName: 'Read', toolInput: {}, toolResult: {} } });
  assert.equal(mailCalls(grok).length, 0);
});

test('Cursor receives mail at postToolUse, together with the recall already queued for that turn', async t => {
  const f = await repoFixture(t);
  const base = event => ({ hook_event_name: event, conversation_id: 'conv-mail', generation_id: 'turn-1', workspace_roots: [f.repo],
    transcript_path: join(f.directory, 'none.jsonl') });
  const tool = { tool_name: 'Read', tool_input: { path: 'a' }, tool_output: '{}' };
  const withRecall = mailSpy('the decision from last week');
  await handleHook({ host: 'cursor', stateDir: f.stateDir, request: withRecall.request, payload: { ...base('beforeSubmitPrompt'), prompt: 'fix the parser' } });
  const both = await handleHook({ host: 'cursor', stateDir: f.stateDir, request: withRecall.request, payload: { ...base('postToolUse'), ...tool } });
  assert.match(both.additional_context, /the decision from last week/);
  assert.match(both.additional_context, /the build is green/, 'mail pulled beside queued recall must not be dropped');
});

test('OpenClaw hook names map onto one Estelle event each, and context is accepted where the plugin can place it', () => {
  const expected = { session_start: 'SessionStart', before_prompt_build: 'UserPromptSubmit', before_tool_call: 'PreToolUse',
    after_tool_call: 'PostToolUse', agent_end: 'Stop', before_compaction: 'PreCompact', session_end: 'SessionEnd' };
  assert.deepEqual([...HOOK_EVENTS].sort(), Object.keys(expected).sort());
  for (const [native, event] of Object.entries(expected)) {
    const tool = ['PreToolUse', 'PostToolUse'].includes(event) ? { tool_name: 'exec' } : {};
    const n = normalize({ hook_event_name: native, session_id: 'abc', cwd: '/tmp/x', ...tool });
    assert.equal(n.event, event);
    assert.equal(n.host, 'openclaw');
  }
  assert.equal(normalize({ hook_event_name: 'before_tool_call', session_id: 'a', cwd: '/tmp', tool_name: 'write' }).toolName, 'Write');
  assert.deepEqual(formatContext('x', 'PostToolUse'), { additionalContext: 'x' });
  assert.throws(() => normalize({ hook_event_name: 'agent_start', session_id: 'a', cwd: '/tmp' }), TypeError);
  assert.equal(safeId('agent:main:main'), 'agent_main_main');
  assert.equal(safeId('   '), '');
});

function fakeApi() {
  const handlers = new Map();
  return { handlers, logger: { warn: () => {} }, on: (name, fn) => { handlers.set(name, fn); } };
}

test('the OpenClaw plugin registers the hooks and places start text, recall, a write warning and queued mail', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-openclaw-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const answers = { session_start: { additionalContext: 'START and identity' }, before_prompt_build: { additionalContext: 'recalled decision' },
    before_tool_call: { warning: 'Estelle warning: key' }, after_tool_call: { additionalContext: MAIL } };
  const run = async (host, payload) => { calls.push({ host, payload }); return answers[payload.hook_event_name] ?? null; };
  const api = fakeApi();
  assert.equal(activate(api, { run, instructions: 'GUIDE', stateDir, env: {} }), undefined, 'register returns at once');
  assert.deepEqual([...api.handlers.keys()].sort(), ['after_tool_call', 'agent_end', 'before_compaction', 'before_prompt_build',
    'before_tool_call', 'session_end', 'session_start']);
  const ctx = { sessionId: 'sess-1', sessionKey: 'agent:main:main', workspaceDir: '/tmp/claw-project' };
  await api.handlers.get('session_start')({ sessionId: 'sess-1' }, ctx);
  await api.handlers.get('before_tool_call')({ toolName: 'write', params: { path: 'a', content: 'x' }, toolCallId: 'c1' }, ctx);
  await api.handlers.get('after_tool_call')({ toolName: 'write', params: {}, toolCallId: 'c1', result: { content: [{ type: 'text', text: 'wrote a' }] } }, ctx);
  const built = await api.handlers.get('before_prompt_build')({ prompt: 'fix the bug' }, ctx);
  assert.equal(built.prependSystemContext, 'GUIDE\n\nSTART and identity');
  assert.equal(built.prependContext, `Estelle warning: key\n\n${MAIL}\n\nrecalled decision`);
  // Delivered once: the next prompt carries only its own recall.
  const next = await api.handlers.get('before_prompt_build')({ prompt: 'and now' }, ctx);
  assert.equal(next.prependContext, 'recalled decision');
  assert.equal(calls.filter(call => call.payload.hook_event_name === 'session_start').length, 1, 'start ran once for three asks');
  const post = calls.find(call => call.payload.hook_event_name === 'after_tool_call').payload;
  assert.deepEqual([post.session_id, post.cwd, post.tool_response], ['sess-1', '/tmp/claw-project', { output: 'wrote a', is_error: false }]);
  assert.equal(post.transcript_path, mirrorPath(stateDir, 'sess-1'));
  // Unwired: the same events with a silent runner change nothing the model reads.
  const quiet = fakeApi();
  activate(quiet, { run: async () => null, instructions: '', stateDir, env: {} });
  assert.deepEqual(await quiet.handlers.get('before_prompt_build')({ prompt: 'x' }, { sessionId: 's2' }), {});
  // A tool call never blocks or rewrites.
  assert.equal(await api.handlers.get('before_tool_call')({ toolName: 'write', params: {}, toolCallId: 'c2' }, ctx), undefined);
});

const MESSAGES = [
  { role: 'user', content: 'why is the build red', timestamp: Date.parse('2026-11-25T10:00:00Z') },
  { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'tc1', name: 'exec', arguments: { cmd: 'ls' } }],
    timestamp: Date.parse('2026-11-25T10:00:01Z') },
  { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'a b' }], timestamp: Date.parse('2026-11-25T10:00:02Z') },
  { role: 'assistant', content: [{ type: 'text', text: 'A missing import.' }], timestamp: Date.parse('2026-11-25T10:00:03Z') },
];

test('the OpenClaw mirror is read by the real stream and checkpoint readers, once, and agent_end writes it', async t => {
  const f = await repoFixture(t);
  const path = mirrorPath(f.stateDir, 'sess-9');
  const written = new Set();
  assert.equal(await syncMirror({ sessionId: 'sess-9', messages: MESSAGES, path, written, done: true }), 6);
  assert.equal(await syncMirror({ sessionId: 'sess-9', messages: MESSAGES, path, written: new Set(), done: true }), 0, 'a restart re-reads the file, not twice');
  assert.deepEqual(linesFor('s', 0, { role: 'system', content: 'x' }, 'now'), [], 'unknown roles are skipped, not guessed');
  const posted = [];
  const request = async (route, body) => { posted.push({ route, body }); return { ok: true, accepted: (body?.events ?? []).length }; };
  const result = await streamSession({ payload: { session_id: 'sess-9', cwd: f.repo, hook_event_name: 'Stop', transcript_path: path },
    host: 'openclaw', repo: 'fixture/host-mail', stateDir: f.stateDir, request });
  assert.equal(result.transcript_format, 'openclaw-plugin-mirror');
  assert.equal(result.current_format_verified, false, 'the message shape is not yet seen live, and says so');
  assert.ok(result.sent >= 4, `sent ${result.sent}`);
  const kinds = posted.flatMap(call => (call.body.events ?? []).map(event => event.kind));
  assert.ok(kinds.includes('customer_message') || kinds.includes('message'), kinds.join());
  assert.ok(kinds.includes('tool_call'));
  const read = await readTranscriptMessages({ path, host: 'openclaw' });
  assert.deepEqual(read.messages.map(message => message.role), ['user', 'assistant', 'assistant', 'assistant']);
  assert.match(JSON.stringify(read.messages), /why is the build red/);
});

test('agent_end appends the run to the mirror and runs the Stop hook with its path', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-openclaw-end-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const api = fakeApi();
  activate(api, { run: async (host, payload) => { calls.push(payload); return null; }, instructions: '', stateDir, env: {} });
  await api.handlers.get('agent_end')({ messages: MESSAGES, success: true }, { sessionId: 'sess-end', workspaceDir: '/tmp/p' });
  const text = await readFile(mirrorPath(stateDir, 'sess-end'), 'utf8');
  assert.equal(text.trim().split('\n').length, 6);
  assert.deepEqual(calls.map(call => call.hook_event_name), ['agent_end']);
  await api.handlers.get('session_end')({ reason: 'new' }, { sessionId: 'sess-end' });
  assert.deepEqual(calls.map(call => call.hook_event_name), ['agent_end', 'session_end']);
});

test('the OpenClaw runner path works end to end: identity is asked for and the mail line reaches the plugin', async t => {
  const f = await repoFixture(t);
  const spy = mailSpy();
  const output = await handleHook({ host: 'openclaw', stateDir: f.stateDir, request: spy.request,
    payload: { hook_event_name: 'session_start', session_id: 'sess-e2e', cwd: f.repo } });
  assert.match(output.additionalContext, /estelle_resume/);
  assert.deepEqual(mailCalls(spy).map(call => call.body.action).sort(), ['deliver', 'identity']);
  assert.ok(mailCalls(spy).every(call => call.body.session_id === 'openclaw-sess-e2e'));
});

test('the native OpenClaw package carries the manifest, the entry, the 26 skills, the 7 commands and the 4 agents as skill roots', async () => {
  const manifest = await json('plugins/openclaw-native/openclaw.plugin.json');
  assert.equal(manifest.id, 'estelle');
  assert.deepEqual(manifest.skills, ['./skills', './command-skills', './agent-skills']);
  assert.deepEqual(manifest.contracts, { conversationAccess: ['read'] });
  assert.deepEqual(manifest.configSchema, { type: 'object', additionalProperties: false });
  const pkg = await json('plugins/openclaw-native/package.json');
  assert.deepEqual(pkg.openclaw.extensions, ['./adapters/openclaw-plugin.mjs']);
  const count = async dir => (await readdir(join(root, 'plugins/openclaw-native', dir))).length;
  assert.deepEqual([await count('skills'), await count('command-skills'), await count('agent-skills')], [26, 7, 4]);
  const skill = await readFile(join(root, 'plugins/openclaw-native/agent-skills/estelle-reviewer/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: estelle-reviewer\ndescription: ".+"\n---\n/);
  assert.doesNotMatch(skill, /^tools:/m, 'the Claude-only tool list is not carried');
  // The existing bundle is untouched: a skills-only Agent Plugins bundle, with no native manifest beside it.
  assert.equal((await json('plugins/openclaw/plugin.json')).name, 'estelle');
  await assert.rejects(readFile(join(root, 'plugins/openclaw/openclaw.plugin.json')), { code: 'ENOENT' });
  // The entry imports under plain Node, the way the OpenClaw gateway loads it.
  const entry = (await import('../plugins/openclaw-native/adapters/openclaw-plugin.mjs')).default;
  assert.deepEqual([entry.id, typeof entry.register, entry.configSchema.safeParse({}).success], ['estelle', 'function', true]);
});

test('fx agent profiles follow fx’s own format: a profile.json with fx tool names, and prompt.md beside it', async () => {
  const names = (await readdir(join(root, 'plugins/fx/agents'))).sort();
  assert.deepEqual(names, ['estelle-grounder', 'estelle-historian', 'estelle-repair', 'estelle-reviewer']);
  const known = new Set(['glob_files', 'grep_files', 'read_file', 'write_file', 'edit_file', 'shell', 'toolbox']);
  for (const name of names) {
    assert.match(name, /^[a-z0-9_-]{1,64}$/, 'fx profile names are lowercase letters, digits, - and _');
    const profile = await json(`plugins/fx/agents/${name}/profile.json`);
    assert.equal(typeof profile.description, 'string', 'a profile without a description does not load');
    assert.ok(profile.description.length > 20);
    assert.ok(profile.tools.length && profile.tools.every(tool => known.has(tool)), JSON.stringify(profile.tools));
    assert.ok(profile.tools.includes('toolbox'), 'fx reaches MCP tools through toolbox');
    assert.deepEqual(profile.mcp_servers, ['Estelle']);
    assert.equal(profile.prompt, 'append');
    assert.equal(Object.hasOwn(profile, 'permission_mode'), false, 'a profile never loosens approval');
    const prompt = await readFile(join(root, `plugins/fx/agents/${name}/prompt.md`), 'utf8');
    assert.ok(prompt.length > 200 && !prompt.startsWith('---'));
  }
  // The grounder only reads: no write tools.
  const grounder = await json('plugins/fx/agents/estelle-grounder/profile.json');
  assert.equal(grounder.tools.some(tool => ['write_file', 'edit_file', 'shell'].includes(tool)), false);
});
