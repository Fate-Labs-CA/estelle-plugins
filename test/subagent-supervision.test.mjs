// estelle#2157 in the plugin: the parent is told what its subagents need it to know, and a subagent gets the same Estelle.
// Each test drives the real hook entry point (handleHook) with a recording request and asserts the request bodies and the
// hook's own output, the innermost layers. The server's side (states, dedupe, sweep) is tested in estelle's
// tests/test_subagent_supervision.py through the real store; here the server is a double that answers `lines`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleHook } from '../runtime/hooks.mjs';
import { timelineIdentity } from '../runtime/identity.mjs';
import { SUPERVISE_TIMEOUT_MS, subagentIdentity, subagentTask, superviseAtBoundary } from '../runtime/supervise.mjs';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
const git = (root, args) => assert.equal(spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv, encoding: 'utf8' }).status, 0);
const LINE = 'Estelle: subagent "Review the diff" (toolu_01ab) has been quiet 22 min. You can: read its output, message it (SendMessage), or stop it (TaskStop).';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'estelle-supervise-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/fixture/supervise.git']);
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior === undefined) delete process.env.ESTELLE_REPO; else process.env.ESTELLE_REPO = prior; });
  return { directory, root, stateDir: join(directory, 'state') };
}

/** A server double: `supervise` answers `lines`; `identity` answers a line naming the id it was asked for; `/search` echoes. */
function server({ lines = [], hang = false, fail = false } = {}) {
  const calls = [];
  const request = async (route, body) => {
    calls.push({ route, body });
    if (route === '/session/mail' && body.action === 'supervise') {
      if (hang) return new Promise(() => {});
      if (fail) throw new Error('boom');
      return { lines };
    }
    if (route === '/session/mail' && body.action === 'identity') return { context: `[ESTELLE] This session's id on Estelle is ${body.session_id}. Its session_token is ${'b'.repeat(32)}: x` };
    if (route === '/search') return { recall: `MEMORY for: ${body.query}` };
    return {};
  };
  const asks = () => calls.filter(c => c.route === '/session/mail' && c.body.action === 'supervise').map(c => c.body);
  return { calls, request, asks };
}

const claude = (f, event, extra = {}) => ({ session_id: 'parent-1', cwd: f.root, hook_event_name: event, transcript_path: null, ...extra });
const run = (f, s, event, extra) => handleHook({ host: 'claude-code', payload: claude(f, event, extra), stateDir: f.stateDir, request: s.request });

test('WIRED: at the prompt, a tool call and the Stop the parent asks the server and prints the lines it is given', async t => {
  const f = await fixture(t);
  const s = server({ lines: [LINE] });
  const prompt = await run(f, s, 'UserPromptSubmit', { prompt: 'continue' });
  assert.ok(prompt.hookSpecificOutput.additionalContext.includes(LINE), 'with the recall, at the prompt');
  const tool = await run(f, s, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} });
  assert.ok(tool.hookSpecificOutput.additionalContext.includes(LINE));
  const stop = await run(f, s, 'Stop', { stop_hook_active: false });
  assert.deepEqual(stop, { systemMessage: LINE }, 'a Stop hook cannot add model context: the person sees the line');
  const id = timelineIdentity('claude-code', 'parent-1');
  assert.deepEqual(s.asks().map(a => a.boundary).sort(), ['prompt', 'stop', 'tool']);
  assert.ok(s.asks().every(a => a.session_id === id && a.action === 'supervise'));
});

test('nothing to say prints nothing, and a server that fails or hangs is silent within the bound', async t => {
  const f = await fixture(t);
  const none = await run(f, server({ lines: [] }), 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} });
  assert.equal(none?.hookSpecificOutput?.additionalContext, undefined);
  const g = await fixture(t);
  const failed = await run(g, server({ fail: true }), 'UserPromptSubmit', { prompt: 'x' });
  assert.ok(!JSON.stringify(failed ?? {}).includes('boom'));
  const started = Date.now();
  const h = await fixture(t);
  const out = await superviseAtBoundary({ host: 'claude-code', sessionId: 'parent-1', event: 'Stop' }, h.stateDir, server({ hang: true }).request);
  assert.deepEqual(out, { text: '' });
  assert.ok(Date.now() - started < SUPERVISE_TIMEOUT_MS + 1_500, 'bounded latency: it gave up on its own');
});

test('at most three lines reach the model, and the tool-call ask is throttled per session', async t => {
  const f = await fixture(t);
  const s = server({ lines: ['one', 'two', 'three', 'four', 'five'] });
  const first = await run(f, s, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} });
  assert.match(first.hookSpecificOutput.additionalContext, /one\ntwo\nthree$/m);
  assert.ok(!first.hookSpecificOutput.additionalContext.includes('four'));
  await run(f, s, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {} });
  assert.equal(s.asks().length, 1, 'a second tool call inside the interval asks nothing');
  await run(f, s, 'UserPromptSubmit', { prompt: 'again' });
  assert.equal(s.asks().length, 2, 'a prompt always asks');
});

test('a subagent never asks the question, and the kill switch stops it for the parent too', async t => {
  const f = await fixture(t);
  const s = server({ lines: [LINE] });
  const inChild = await run(f, s, 'PostToolUse', { tool_name: 'Read', tool_input: {}, tool_response: {}, agent_id: 'sub-1' });
  assert.equal(s.asks().length, 0);
  assert.ok(!JSON.stringify(inChild ?? {}).includes(LINE));
  process.env.ESTELLE_SUBAGENT_SUPERVISION = '0';
  t.after(() => { delete process.env.ESTELLE_SUBAGENT_SUPERVISION; });
  const off = await run(f, s, 'UserPromptSubmit', { prompt: 'x' });
  assert.equal(s.asks().length, 0);
  assert.ok(!JSON.stringify(off ?? {}).includes(LINE));
});

test('only Claude Code and Codex ask: a host with no model-context channel at these boundaries is not asked about', async t => {
  const f = await fixture(t);
  const s = server({ lines: [LINE] });
  await handleHook({ host: 'qwen-code', payload: { hook_event_name: 'UserPromptSubmit', session_id: 'q1', cwd: f.root, prompt: 'x' },
    stateDir: f.stateDir, request: s.request });
  assert.ok(s.calls.length > 0, 'control: the hook ran and made requests');
  assert.equal(s.asks().length, 0);
  await run(f, s, 'UserPromptSubmit', { prompt: 'x' });
  assert.equal(s.asks().length, 1, 'control: the same hook on Claude Code does ask');
});

// --- the subagent gets the same Estelle ------------------------------------------------------------------------------

async function childTranscript(f, agent, text) {
  const parent = join(f.directory, 'parent-1.jsonl');
  const dir = join(f.directory, 'parent-1', 'subagents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `agent-${agent}.jsonl`), JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: text } }) + '\n');
  return parent;
}

test('WIRED: SubagentStart gives the subagent the guidance, memory for its own task, and its OWN identity, not its parent\'s', async t => {
  const f = await fixture(t);
  const s = server();
  const transcript = await childTranscript(f, 'abc123', 'Audit the billing module for rounding bugs');
  const out = await run(f, s, 'SubagentStart', { agent_id: 'abc123', agent_type: 'general-purpose', transcript_path: transcript });
  const context = out.hookSpecificOutput.additionalContext;
  const parent = timelineIdentity('claude-code', 'parent-1');
  const own = `${parent}-agent-abc123`;
  assert.equal(subagentIdentity({ host: 'claude-code', sessionId: 'parent-1', agentId: 'abc123' }), own);
  const identity = s.calls.find(c => c.body?.action === 'identity');
  assert.equal(identity.body.session_id, own, 'it asked for its own identity');
  assert.ok(context.includes(`id on Estelle is ${own}`) && !context.includes(`id on Estelle is ${parent}.`), 'and was handed that one');
  const search = s.calls.find(c => c.route === '/search');
  assert.equal(search.body.query, 'Audit the billing module for rounding bugs', 'the task is the memory query');
  assert.equal(search.body.timeline_session, own, 'read as the subagent: it takes none of its parent\'s mail');
  assert.deepEqual(search.body.kinds, ['memory']);
  assert.ok(context.includes('MEMORY for: Audit the billing module'), 'the recall reaches the subagent');
  assert.match(context, /estelle_resume/, 'the start guidance the main agent gets');
  assert.match(context, /You are a subagent/);
  assert.match(context, /never use, ask for or repeat your parent's token/);
});

test('a subagent whose task cannot be read yet still starts with guidance and identity, and says nothing false about memory', async t => {
  const f = await fixture(t);
  const s = server();
  const out = await run(f, s, 'SubagentStart', { agent_id: 'zzz', agent_type: 'general-purpose', transcript_path: join(f.directory, 'none.jsonl') });
  assert.equal(s.calls.filter(c => c.route === '/search').length, 0, 'no task text, no query: nothing is invented');
  assert.match(out.hookSpecificOutput.additionalContext, /You are a subagent/);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('-agent-zzz'));
});

test('the task comes from the hook when it carries one, and a main-agent SessionStart keeps its own identity', async t => {
  const f = await fixture(t);
  assert.equal(await subagentTask({ prompt: 'from the hook', raw: {} }), 'from the hook');
  assert.equal(await subagentTask({ raw: { task: 'raw task' } }), 'raw task');
  assert.equal(await subagentTask({ raw: {}, agentId: 'q', transcriptPath: join(f.directory, 'nope.jsonl') }), '');
  const s = server();
  const out = await run(f, s, 'SessionStart', { source: 'startup' });
  const id = s.calls.find(c => c.body?.action === 'identity').body.session_id;
  assert.equal(id, timelineIdentity('claude-code', 'parent-1'), 'the main agent is not a subagent');
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('You are a subagent'));
});
