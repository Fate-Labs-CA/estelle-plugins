// Subagent start, stop and agents on every host whose docs name them (parity audit 2026-11-25). Each test reads the
// GENERATED package a user installs, not the source, and the start-then-stop test drives the real hook entry point.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { handleHook } from '../runtime/hooks.mjs';

const root = resolve(import.meta.dirname, '..');
const read = async file => JSON.parse(await readFile(join(root, file), 'utf8'));
const SHARED = ['estelle-grounder.md', 'estelle-historian.md', 'estelle-repair.md', 'estelle-reviewer.md'];

test('the generated hooks.json carries the subagent start event for Cursor, Grok, Kimi and Qwen, and the stop beside it', async () => {
  const cursor = (await read('plugins/cursor/hooks/hooks.json')).hooks;
  assert.ok(cursor.subagentStart && cursor.subagentStop);
  for (const file of ['plugins/grok/hooks/hooks.json', 'plugins/qwen/hooks/hooks.json']) {
    const { hooks } = await read(file);
    assert.ok(hooks.SubagentStart && hooks.SubagentStop, file);
  }
  for (const file of ['plugins/kimi/kimi.plugin.json', 'kimi.plugin.json']) {
    const events = (await read(file)).hooks.map(hook => hook.event);
    assert.ok(events.includes('SubagentStart') && events.includes('SubagentStop'), file);
  }
});

test('WIRED: with the start now delivered, a start then a stop records the child on Qwen (and a lone stop records nothing)', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'estelle-parity-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sent = [];
  const request = async (path, body) => { if (path === '/session/events') sent.push(body); return {}; };
  const base = { session_id: 'parent-q', cwd: '/tmp', transcript_path: null };
  await handleHook({ host: 'qwen-code', stateDir, request, payload: { ...base, hook_event_name: 'SubagentStop', agent_id: 'orphan', last_assistant_message: 'x' } });
  assert.equal(sent.filter(b => b.session_id.includes('agent-orphan')).length, 0, 'unmatched stop: nothing invented');
  await handleHook({ host: 'qwen-code', stateDir, request, payload: { ...base, hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general' } });
  await handleHook({ host: 'qwen-code', stateDir, request, payload: { ...base, hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_type: 'general', last_assistant_message: 'done' } });
  const events = sent.filter(b => b.session_id === 'qwen-code-parent-q/agent-sub-1' || b.session_id.endsWith('/agent-sub-1')).flatMap(b => b.events);
  assert.deepEqual(events.map(e => e.payload.state ?? e.kind), ['running', 'agent_message', 'ended']);
  assert.equal(events[0].payload.harness, 'subagent');
});

test('the four shared agents ship to Cursor, Kimi and Qwen, and the manifests point at them', async () => {
  for (const host of ['cursor', 'kimi', 'qwen']) {
    assert.deepEqual((await readdir(join(root, 'plugins', host, 'agents'))).sort(), SHARED, host);
  }
  for (const file of ['plugins/kimi/kimi.plugin.json', 'kimi.plugin.json']) assert.deepEqual((await read(file)).agents, ['./agents'], file);
  assert.equal((await read('plugins/qwen/qwen-extension.json')).agents, 'agents');
});

test('Qwen agents name Qwen tools: no Claude tool names and no Claude-plugin aliases survive; Kimi keeps the names its docs use', async () => {
  const qwen = await readFile(join(root, 'plugins/qwen/agents/estelle-repair.md'), 'utf8');
  const tools = /^tools: (.+)$/m.exec(qwen)[1].split(', ');
  for (const name of ['read_file', 'write_file', 'edit', 'run_shell_command', 'grep_search', 'glob', 'mcp__Estelle__verify']) assert.ok(tools.includes(name), name);
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) assert.ok(!tools.includes(name), name);
  assert.ok(!tools.some(name => name.startsWith('mcp__plugin_')));
  assert.match(await readFile(join(root, 'plugins/kimi/agents/estelle-repair.md'), 'utf8'), /^tools: Read, Write, Edit, Bash, Grep, Glob,/m);
});
