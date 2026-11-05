import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, formatContext, defaultOutput } from '../adapters/cursor.mjs';
import { handleHook } from '../runtime/hooks.mjs';
import { timelineIdentity } from '../runtime/identity.mjs';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const fixture = event => ({ hook_event_name: event, conversation_id: 'conv-123', generation_id: 'turn-1',
  workspace_roots: [root], transcript_path: '/not-a-verified-cursor-transcript', model: 'claude',
  user_email: 'untrusted@example.test' });

const gitKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function fixtureGit(workspace, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of gitKeys) delete env[key];
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workspace, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 100_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Functional hooks need a recognized repository, independent of the package's
// checkout remote (Estelle CI deliberately removes it after its fetch).
async function functionalFixture(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'estelle-cursor-workspace-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const previous = ['ESTELLE_REPO', 'ESTELLE_EXECUTION_SESSION_ID'].map(key => [key, process.env[key]]);
  for (const [key] of previous) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const args of [['init', '-q', '-b', 'main'],
    ['remote', 'add', 'origin', 'https://github.com/fixture/cursor-hooks.git']]) {
    fixtureGit(workspace, args);
  }
  return event => ({ ...fixture(event), workspace_roots: [workspace] });
}

test('Cursor fixture ignores inherited Git routing without mutating the parent or another repository', async t => {
  const foreign = await realpath(await mkdtemp(join(tmpdir(), 'estelle-cursor-foreign-')));
  t.after(() => rm(foreign, { recursive: true, force: true }));
  fixtureGit(foreign, ['init', '-q', '-b', 'main']);
  const paths = [join(foreign, '.git', 'config'), join(foreign, '.git', 'index'), join(foreign, 'sentinel.txt')];
  await writeFile(paths[1], 'owned index sentinel');
  await writeFile(paths[2], 'owned worktree sentinel');
  const before = await Promise.all(paths.map(path => readFile(path)));
  const previous = gitKeys.map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const routed = [join(foreign, '.git'), foreign, paths[1], join(foreign, '.git'),
    join(foreign, '.git', 'objects'), join(foreign, '.git', 'objects'), 'fixture', foreign];
  gitKeys.forEach((key, index) => { process.env[key] = routed[index]; });
  const scopedFixture = await functionalFixture(t);
  assert.deepEqual(gitKeys.map(key => process.env[key]), routed);
  const after = await Promise.all(paths.map(path => readFile(path)));
  assert.deepEqual(after, before, 'foreign config/index/workfile must remain unchanged');
  const workspace = scopedFixture('sessionStart').workspace_roots[0];
  assert.equal(fixtureGit(workspace, ['remote', 'get-url', 'origin']), 'https://github.com/fixture/cursor-hooks.git');
});

test('workspace fixture resolves native paths rather than treating file URL pathnames as drive paths', () => {
  assert.equal(root, resolve(fileURLToPath(new URL('..', import.meta.url))));
  const windowsUrl = new URL('file:///D:/a/estelle-plugins/estelle-plugins');
  const native = fileURLToPath(windowsUrl, { windows: true });
  assert.equal(native, 'D:\\a\\estelle-plugins\\estelle-plugins');
  assert.notEqual(win32.normalize(windowsUrl.pathname), native);
});

test('Cursor uses native stable identity, matching start/end aliases and explicit workspace selection', () => {
  const normalized = normalize({ ...fixture('sessionStart'), session_id: 'conv-123' });
  assert.equal(normalized.sessionId, 'conv-123');
  assert.equal(normalized.cwd, root);
  assert.equal(normalized.turnId, 'turn-1');
  assert.equal(timelineIdentity('cursor', normalized.sessionId), 'cursor-conv-123');
  assert.equal(normalized.owner, undefined);
  assert.throws(() => normalize({ ...fixture('sessionStart'), session_id: 'different' }), /identity/);
  assert.throws(() => normalize({ ...fixture('sessionStart'), workspace_roots: [root, '/tmp'] }), /workspace/);
  assert.throws(() => normalize({ ...fixture('stop'), workspace_roots: [] }), /workspace/);
  assert.throws(() => normalize({ ...fixture('stop'), workspace_roots: ['relative'] }), /workspace/);
  assert.equal(normalize({ ...fixture('postToolUse'), cwd: tmpdir(), tool_name: 'Read', tool_input: {}, tool_output: '{}' }).cwd, tmpdir());
});

test('Cursor parses the documented JSON-string result and preserves the separate child transcript path', () => {
  const n = normalize({ ...fixture('postToolUse'), tool_name: 'Write', tool_input: { file_path: '/tmp/test' },
    tool_output: '{"success":false,"isError":true}' });
  assert.deepEqual(n.toolResponse, { success: false, isError: true });
  assert.equal(n.raw.tool_response.is_error, true);
  assert.throws(() => normalize({ ...fixture('postToolUse'), tool_name: 'Write', tool_input: {}, tool_output: {} }), /JSON/);
  assert.throws(() => normalize({ ...fixture('postToolUse'), tool_name: 'Write', tool_input: {}, tool_output: 'broken' }), /JSON/);
  const child = normalize({ ...fixture('subagentStop'), agent_transcript_path: '/tmp/child', summary: 'summary' });
  assert.equal(child.agentTranscriptPath, '/tmp/child');
  assert.equal(child.transcriptPath, fixture('subagentStop').transcript_path);
  assert.throws(() => normalize(fixture('afterAgentThought')), /Unsupported/);
});

test('Cursor emits context only on the three documented passive boundaries, and permission outputs use native schema', () => {
  for (const event of ['SessionStart', 'PostToolUse', 'PostToolUseFailure']) {
    assert.deepEqual(formatContext('context', event), { additional_context: 'context' });
  }
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd']) {
    assert.equal(formatContext('context', event), null);
  }
  assert.deepEqual(defaultOutput('beforeSubmitPrompt'), { continue: true });
  assert.deepEqual(defaultOutput('preToolUse'), { permission: 'allow' });
  assert.deepEqual(defaultOutput('subagentStart'), { permission: 'allow' });
  assert.equal(defaultOutput('afterAgentThought'), null);
});

test('Cursor queues recall at prompt, emits once after a matching tool, and streams the transcript', async t => {
  const scopedFixture = await functionalFixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-cursor-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transcript = join(stateDir, 'conv-123.jsonl');
  await writeFile(transcript, [
    { role: 'user', message: { content: [{ type: 'text', text: 'Thursday, Oct 1, 2026, 6:00 AM (UTC-4)\nFix the parser' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Looking at it.' }] } },
    { type: 'turn_ended', status: 'success' },
  ].map(JSON.stringify).join('\n') + '\n');
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return { recall: 'remembered context' }; };
  const run = payload => handleHook({ host: 'cursor', payload, stateDir, request });
  assert.deepEqual(await run({ ...scopedFixture('beforeSubmitPrompt'), prompt: 'continue', transcript_path: transcript }), { continue: true });
  const post = { ...scopedFixture('postToolUse'), transcript_path: transcript, tool_name: 'Read', tool_input: {}, tool_output: '{}' };
  assert.deepEqual(await run(post), { additional_context: 'remembered context' });
  assert.equal(await run(post), null);
  assert.equal(calls.filter(call => call.path === '/search').length, 1);
  assert.equal(calls.find(call => call.path === '/search').body.repo, 'fixture/cursor-hooks');
  assert.equal(calls.find(call => call.path === '/search').body.timeline_session, 'cursor-conv-123');
  const streamed = calls.filter(call => call.path === '/session/events');
  assert.ok(streamed.length > 0, 'the transcript write path must actually run for cursor');
  assert.equal(streamed[0].body.session_id, 'cursor-conv-123');
  const events = streamed.flatMap(call => call.body.events);
  assert.ok(events.some(event => event.kind === 'customer_message'));
  assert.ok(events.some(event => event.kind === 'agent_message'));
  assert.ok(events.every(event => !JSON.stringify(event).includes('untrusted@example.test')), 'host identity fields are not conversation');
  const row = JSON.parse(await readFile(join(stateDir, 'status', 'cursor-stream.json'), 'utf8'));
  assert.equal(row.status, 'ok');
});

test('Cursor SessionEnd defers a durable reference and the next drain checkpoints and streams it', async t => {
  const scopedFixture = await functionalFixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-cursor-end-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const transcript = join(stateDir, 'conv-end.jsonl');
  await writeFile(transcript, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'final question' }] } }) + '\n');
  const end = await handleHook({ host: 'cursor', stateDir, request: async () => { throw new Error('must not run at exit'); },
    payload: { ...scopedFixture('sessionEnd'), transcript_path: transcript } });
  assert.equal(end, null, 'exit hooks answer without network or transcript work');
  const { drainOne } = await import('../runtime/hooks.mjs');
  const calls = [];
  await drainOne(stateDir, async (path, body) => { calls.push({ path, body }); return {}; });
  assert.equal(calls.find(call => call.path === '/checkpoint')?.body.session_id, 'conv-123');
  assert.equal(calls.find(call => call.path === '/checkpoint')?.body.client.name, 'cursor');
  assert.equal(calls.find(call => call.path === '/checkpoint')?.body.client.format_verified, false);
  assert.ok(calls.some(call => call.path === '/session/events' && call.body.session_id === 'cursor-conv-123'));
});

test('Cursor shows the write warning and allows, and optional failures still allow prompt/tool execution', async t => {
  const scopedFixture = await functionalFixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-cursor-failure-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const run = payload => handleHook({ host: 'cursor', payload, stateDir, request: async () => { throw new Error('offline'); } });
  const edit = { ...scopedFixture('preToolUse'), tool_name: 'Write', tool_input: { content: 'ESTELLE_API_KEY=synthetic-secret-value' } };
  // A named value is not an exact key shape, so nothing is said and nothing is stopped. hooks.test.mjs has Cursor's warning.
  assert.deepEqual(await run(edit), { permission: 'allow' });
  assert.deepEqual(await run({ ...scopedFixture('beforeSubmitPrompt'), prompt: 'continue' }), { continue: true });
  assert.deepEqual(await run({ ...edit, tool_input: { content: 'ordinary text' } }), { permission: 'allow' });
  assert.deepEqual(await run(scopedFixture('subagentStart')), { permission: 'allow' });
  const native = spawnSync(process.execPath, ['runtime/cli.mjs', 'hook', 'cursor'], {
    cwd: root, input: JSON.stringify(scopedFixture('subagentStart')), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ESTELLE_PLUGIN_DATA: stateDir, ESTELLE_API_KEY: '' },
  });
  assert.equal(native.status, 0);
  assert.deepEqual(JSON.parse(native.stdout), { permission: 'allow' });
});

test('an older slow Cursor recall cannot overwrite a newer generation', async t => {
  const scopedFixture = await functionalFixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-cursor-order-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let resolveOld, started;
  const oldStarted = new Promise(resolve => { started = resolve; });
  const oldResponse = new Promise(resolve => { resolveOld = resolve; });
  const request = async (route, body) => {
    if (route !== '/search') return {};
    if (body.query === 'old prompt') { started(); return oldResponse; }
    return { recall: 'new recall' };
  };
  const run = payload => handleHook({ host: 'cursor', payload, stateDir, request });
  const old = run({ ...scopedFixture('beforeSubmitPrompt'), prompt: 'old prompt' });
  await oldStarted;
  await run({ ...scopedFixture('beforeSubmitPrompt'), generation_id: 'turn-2', prompt: 'new prompt' });
  resolveOld({ recall: 'old recall' });
  await old;
  assert.deepEqual(await run({ ...scopedFixture('postToolUse'), generation_id: 'turn-2', tool_name: 'Read',
    tool_input: {}, tool_output: '{}' }), { additional_context: 'new recall' });
});
