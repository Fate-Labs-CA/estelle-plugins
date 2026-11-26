import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, WRITE_TOOL_MATCHER, normalize, formatContext, defaultOutput } from '../adapters/antigravity.mjs';
import { mapAntigravity, streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';
import { handleHook } from '../runtime/hooks.mjs';

const root = resolve(import.meta.dirname, '..');
// A hand-written transcript in the layout third-party write-ups describe. It is NOT a recording of a real Antigravity session.
const FIXTURE = join(root, 'test', 'fixtures', 'antigravity', 'transcript.jsonl');
const SESSION = '5d1c0b58-3a53-4c2e-9d1e-0f4f1c1b7a11';
const payload = (event, extra = {}) => ({ hook_event_name: event, conversationId: SESSION, workspacePaths: ['/tmp/agy-project'],
  transcriptPath: FIXTURE, modelName: 'gemini', lastUserInput: 'read the readme', ...extra });
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-agy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
async function gitRepo(t) {
  const repo = join(await scratch(t), 'repo');
  for (const args of [['init', '-q', repo], ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fixture/agy-hooks.git']]) {
    assert.equal(spawnSync('git', args, { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0);
  }
  const prior = process.env.ESTELLE_REPO;
  delete process.env.ESTELLE_REPO;
  t.after(() => { if (prior !== undefined) process.env.ESTELLE_REPO = prior; });
  return repo;
}

test('Antigravity hook payloads normalize under the antigravity host; PreInvocation is the prompt', () => {
  const tool = { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } };
  for (const event of HOOK_EVENTS) {
    assert.equal(normalize(payload(event, ['PreToolUse', 'PostToolUse'].includes(event) ? tool : {})).host, 'antigravity');
  }
  const prompt = normalize(payload('PreInvocation', { invocationNum: 3 }));
  assert.equal(prompt.event, 'UserPromptSubmit');
  assert.equal(prompt.prompt, 'read the readme');
  assert.equal(prompt.sessionId, SESSION);
  assert.equal(prompt.cwd, '/tmp/agy-project');
  assert.equal(prompt.invocation, 3);
  assert.equal(normalize(payload('PreToolUse', { toolCall: { name: 'write_to_file', args: {} } })).toolName, 'Write');
  assert.equal(normalize(payload('PreToolUse', { toolCall: { name: 'replace_file_content', args: {} } })).toolName, 'Edit');
  assert.equal(normalize(payload('PostToolUse', { ...tool, error: 'boom' })).toolResponse.is_error, true);
  assert.equal(normalize(payload('PostToolUse', tool)).toolResponse, null);
  for (const bad of [payload('Nope'), payload('PreToolUse'), { ...payload('Stop'), conversationId: '' },
    { ...payload('Stop'), workspacePaths: [] }, { ...payload('Stop'), transcriptPath: 4 }, []]) {
    assert.throws(() => normalize(bad), TypeError);
  }
});

test('output shapes follow the documented hook responses', () => {
  assert.deepEqual(formatContext('x', 'UserPromptSubmit'), { injectSteps: [{ systemMessage: { systemMessage: 'x' } }] });
  assert.deepEqual(formatContext('x', 'SessionStart'), { injectSteps: [{ systemMessage: { systemMessage: 'x' } }] });
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) assert.equal(formatContext('x', event), null);
  assert.equal(formatContext('  ', 'SessionStart'), null);
  assert.deepEqual(defaultOutput('PreToolUse'), { decision: 'allow' });
  assert.deepEqual(defaultOutput('Stop'), {});
  assert.equal(defaultOutput('SessionStart'), null);
});

test('a transcript step becomes the person, the tool call, its output and the reply; system steps are skipped', async () => {
  const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const events = lines.flatMap(line => mapAntigravity(line, 0, { observedAt: '2026-11-25T10:00:00Z' }));
  assert.deepEqual(events.map(event => event.kind), ['customer_message', 'lifecycle', 'agent_message', 'tool_call', 'tool_result', 'agent_message']);
  assert.equal(events[0].payload.text, 'read the readme');
  assert.equal(events[3].payload.tool, 'view_file');
  assert.equal(events[4].payload.output, 'hello\n');
  assert.deepEqual(mapAntigravity(lines[1], 0, { observedAt: '2026-11-25T10:00:00Z' }), []);
  assert.deepEqual(mapAntigravity(lines[0], 0, {}), [], 'a step with no time of its own and no capture time is not guessed');
});

test('the real stream and checkpoint read the transcript under the antigravity timeline, marked inferred', async t => {
  const stateDir = await scratch(t);
  const calls = [];
  const stream = await streamSession({ payload: payload('Stop', { session_id: SESSION, cwd: '/tmp/agy-project', transcript_path: FIXTURE }),
    host: 'antigravity', repo: 'fixture/agy', stateDir, request: async (route, body) => { calls.push({ route, body }); return {}; } });
  assert.equal(stream.transcript_format, 'antigravity-transcript-jsonl-inferred');
  assert.equal(stream.current_format_verified, false);
  assert.equal(stream.session_id, `antigravity-${SESSION}`);
  assert.ok(calls.filter(call => call.route === '/session/events').flatMap(call => call.body.events).some(event => event.kind === 'tool_call'));
  const { messages, client } = await readTranscriptMessages({ path: FIXTURE, host: 'antigravity' });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(client.name, 'antigravity');
  assert.equal(client.format_verified, false);
});

test('the real hook runner: recall comes back as injectSteps, and a repeated PreInvocation recalls once', async t => {
  const repo = await gitRepo(t);
  const stateDir = join(await scratch(t), 'state');
  const bodies = [];
  const request = async (route, body) => { bodies.push({ route, body }); return route === '/search' ? { recall: 'we chose JSON mode' } : {}; };
  const input = () => ({ ...payload('PreInvocation', { invocationNum: 1 }), workspacePaths: [repo], lastUserInput: 'what did we decide?' });
  const first = await handleHook({ host: 'antigravity', stateDir, payload: input(), request });
  assert.deepEqual(first, { injectSteps: [{ systemMessage: { systemMessage: 'we chose JSON mode' } }] });
  const search = bodies.find(call => call.route === '/search');
  assert.equal(search?.body.host, 'antigravity');
  assert.equal(search?.body.timeline_session, `antigravity-${SESSION}`);
  const again = await handleHook({ host: 'antigravity', stateDir, payload: input(), request });
  assert.equal(again, null);
  assert.equal(bodies.filter(call => call.route === '/search').length, 1);
  const next = await handleHook({ host: 'antigravity', stateDir, payload: { ...input(), invocationNum: 2, lastUserInput: 'and then?' }, request });
  assert.ok(next.injectSteps);
});

test('the write warning rides a PreToolUse decision that leaves permissions alone, and never blocks', async t => {
  const stateDir = join(await scratch(t), 'state');
  const request = async () => ({});
  const quiet = await handleHook({ host: 'antigravity', stateDir, request,
    payload: payload('PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: '/tmp/agy-project/a.txt', CodeContent: 'hello' } } }) });
  assert.deepEqual(quiet, { decision: 'allow' });
  const key = ['sk', 'live', '51H8aZbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFGH'].join('_');
  const warned = await handleHook({ host: 'antigravity', stateDir, request,
    payload: payload('PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: '/tmp/agy-project/a.txt', CodeContent: key } } }) });
  assert.equal(warned.decision, 'allow');
  assert.match(warned.reason, /^Estelle warning: .*a\.txt/);
  assert.doesNotMatch(JSON.stringify(warned), new RegExp(key));
  assert.deepEqual(await handleHook({ host: 'antigravity', stateDir, request, payload: payload('PostToolUse', { toolCall: { name: 'run_command', args: {} } }) }), {});
  assert.deepEqual(await handleHook({ host: 'antigravity', stateDir, request, payload: payload('Stop', { fullyIdle: true }) }), {});
});

test('hook runner reads the event from the command line, as Antigravity stdin does not name it', async t => {
  const stateDir = await scratch(t);
  const run = spawnSync('node', [join(root, 'plugins', 'antigravity', 'runtime', 'cli.mjs'), 'hook', 'antigravity', 'PostToolUse'], {
    input: JSON.stringify({ conversationId: SESSION, workspacePaths: ['/tmp/agy-project'], toolCall: { name: 'run_command', args: {} } }),
    env: { ...process.env, ESTELLE_PLUGIN_DATA: stateDir, ESTELLE_API_KEY: '', ESTELLE_PLUGIN_UPDATE_CHECK: '0' }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), '{}');
});

test('the Antigravity plugin follows the documented schema: manifest, MCP, hooks, rules, skills, agents', async () => {
  const dir = join(root, 'plugins', 'antigravity');
  const manifest = await json('plugins/antigravity/plugin.json');
  // The published schema sets additionalProperties false, so every key must be a documented field.
  const allowed = new Set(['$schema', 'name', 'displayName', 'version', 'description', 'logo', 'suggestedPrompts', 'skills', 'disabled',
    'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  for (const key of Object.keys(manifest)) assert.ok(allowed.has(key), `undocumented manifest field ${key}`);
  assert.match(manifest.name, /^[a-z][a-z0-9-]*$/);
  assert.ok(manifest.suggestedPrompts.length <= 3);
  assert.match(manifest.homepage, /^https:\/\//);
  // URL only: Antigravity's own OAuth signs in; a headers or oauth entry would replace it.
  assert.deepEqual(await json('plugins/antigravity/mcp_config.json'), { mcpServers: { Estelle: { serverUrl: 'https://api.fatelabs.ca/mcp' } } });
  const hooks = (await json('plugins/antigravity/hooks.json')).estelle;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreInvocation', 'PreToolUse', 'SessionStart', 'Stop']);
  for (const event of ['PreToolUse', 'PostToolUse']) assert.ok(Array.isArray(hooks[event][0].hooks), `${event} takes {matcher, hooks}`);
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) assert.equal(hooks[event][0].type, 'command', `${event} takes a flat handler`);
  assert.equal(hooks.PreToolUse[0].matcher, WRITE_TOOL_MATCHER);
  const commands = [hooks.SessionStart[0], hooks.PreInvocation[0], hooks.Stop[0], hooks.PreToolUse[0].hooks[0], hooks.PostToolUse[0].hooks[0]].map(h => h.command);
  for (const command of commands) assert.match(command, /^node \.\/runtime\/cli\.mjs hook antigravity [A-Za-z]+$/, 'relative path, no PLUGIN_ROOT');
  assert.match(await readFile(join(dir, 'rules', 'AGENTS.md'), 'utf8'), /Estelle/);
  const folders = [...(await readdir(join(dir, 'skills'))).map(name => ['skills', name]), ...(await readdir(join(dir, 'command-skills'))).map(name => ['command-skills', name])];
  assert.equal(folders.length, (await readdir(join(root, 'skills'))).length + (await readdir(join(root, 'commands'))).filter(name => name.endsWith('.md')).length);
  for (const [parent, name] of folders) {
    const text = await readFile(join(dir, parent, name, 'SKILL.md'), 'utf8');
    assert.equal(/^name: (.+)$/m.exec(text)?.[1], name, 'skill folder matches its name');
    assert.ok(name.length <= 64);
    const description = /^description: (.+)$/m.exec(text)?.[1];
    assert.ok(description && description.length <= 1024 + 2);
  }
  assert.deepEqual((await readdir(join(dir, 'command-skills'))).sort(), ['cloud', 'code', 'handoff', 'login', 'logout', 'monitor', 'resume', 'review', 'rooms'].map(n => `estelle-${n}`));
  const agents = await readdir(join(dir, 'agents'));
  assert.equal(agents.length, (await readdir(join(root, 'agents'))).length);
  for (const file of agents) assert.match(await readFile(join(dir, 'agents', file), 'utf8'), /^---\nname: .+\ndescription: ".+"\nmainAgent: false\nsubagent: true\nmodel: inherit\n---\n/);
});
