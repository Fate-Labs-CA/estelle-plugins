import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOOK_EVENTS, normalize, formatContext } from '../adapters/hermes.mjs';
import { streamSession } from '../runtime/stream.mjs';
import { readTranscriptMessages } from '../runtime/checkpoint.mjs';

const root = resolve(import.meta.dirname, '..');
const PLUGIN = join(root, 'plugins', 'hermes', '__init__.py');
const SESSION = '20261120_060811_fa54de';
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const envelope = (event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd: '/tmp/hermes-project', ...extra });

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-hermes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Run Python against the built plugin; `body` uses `plugin` (the module) and prints one JSON line. */
function py(body, env = {}) {
  const script = `import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("estelle_hermes", ${JSON.stringify(PLUGIN)})
plugin = importlib.util.module_from_spec(spec); spec.loader.exec_module(plugin)
${body}`;
  const done = spawnSync(python, ['-I', '-c', script], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout.trim().split('\n').at(-1));
}

test('maps every Hermes hook the plugin sends onto one Estelle event', () => {
  const expected = { on_session_start: 'SessionStart', pre_llm_call: 'UserPromptSubmit', pre_tool_call: 'PreToolUse',
    post_tool_call: 'PostToolUse', post_llm_call: 'Stop', on_session_finalize: 'SessionEnd',
    subagent_start: 'SubagentStart', subagent_stop: 'SubagentStop', post_compaction: 'PreCompact' };
  assert.deepEqual([...HOOK_EVENTS].sort(), Object.keys(expected).sort());
  for (const [native, event] of Object.entries(expected)) {
    const tool = ['PreToolUse', 'PostToolUse'].includes(event) ? { tool_name: 'read_file' } : {};
    assert.equal(normalize(envelope(native, tool)).event, event);
  }
  assert.equal(normalize(envelope('pre_tool_call', { tool_name: 'write_file' })).toolName, 'Write');
  assert.equal(normalize(envelope('pre_tool_call', { tool_name: 'patch' })).toolName, 'Edit');
  assert.equal(normalize(envelope('on_session_start', { parent_session_id: 'parent_1' })).event, 'SubagentStart');
  assert.throws(() => normalize(envelope('pre_tool_call')), TypeError);
  assert.deepEqual(formatContext('x', 'UserPromptSubmit'), { additionalContext: 'x' });
  assert.equal(formatContext('x', 'Stop'), null);
});

test('the plugin registers its hooks, skills and /estelle-* commands with Hermes, and a command becomes the next message',
  { skip: !python && 'python3 not installed' }, () => {
    const result = py(`
class Ctx:
    def __init__(self): self.hooks, self.skills, self.commands, self.sent = [], [], {}, []
    def register_hook(self, name, fn): self.hooks.append(name)
    def register_skill(self, name, path, description=""): self.skills.append(name)
    def register_command(self, name, handler, description="", args_hint=""): self.commands[name] = handler
    def inject_message(self, content, role="user"): self.sent.append(content); return True
ctx = Ctx()
plugin.register(ctx, plugin.Estelle(home=__import__("pathlib").Path("/tmp"), runner=lambda *a, **k: None))
answer = ctx.commands["estelle-review"]("the auth change")
print(json.dumps({"hooks": ctx.hooks, "skills": len(ctx.skills), "estelle": "estelle" in ctx.skills,
                  "commands": sorted(ctx.commands), "answer": answer, "sent": ctx.sent}))`);
    assert.deepEqual(result.hooks, HOOK_EVENTS.slice());
    assert.ok(result.skills >= 20 && result.estelle);
    assert.deepEqual(result.commands, ['estelle-cloud', 'estelle-code', 'estelle-handoff', 'estelle-login', 'estelle-logout', 'estelle-monitor', 'estelle-resume',
      'estelle-review', 'estelle-rooms']);
    assert.equal(result.answer, null);
    assert.match(result.sent[0], /Target \(blank means the current diff\): the auth change/);
  });

test('subagent and compaction hooks register only where the installed Hermes lists them, and send the right envelopes',
  { skip: !python && 'python3 not installed' }, () => {
    const result = py(`
class Ctx:
    def __init__(self): self.hooks = []
    def register_hook(self, name, fn): self.hooks.append(name)
    def register_skill(self, *a, **k): pass
    def register_command(self, *a, **k): pass
    def inject_message(self, *a, **k): return True
def hooks(valid):
    ctx = Ctx(); plugin.register(ctx, plugin.Estelle(home=__import__("pathlib").Path("/tmp"), runner=lambda *a, **k: None), valid_hooks=valid); return ctx.hooks
old = hooks(set(plugin.BASE_HOOKS)); new = hooks(set(plugin.BASE_HOOKS) | set(plugin.NEWER_HOOKS))
calls = []
def runner(command, input=None, **_):
    calls.append(json.loads(input)); return types.SimpleNamespace(stdout=b"{}")
e = plugin.Estelle(home=__import__("pathlib").Path("/tmp"), runner=runner, cwd=lambda: "/tmp/hermes-project")
e.subagent_start(child_session_id="child_1", parent_session_id="parent_1", child_goal="audit billing", child_role="leaf")
e.subagent_stop(parent_session_id="parent_1", child_role="leaf", child_summary="two bugs", child_status="completed")
e.post_compaction(session_id="parent_1")
print(json.dumps({"old": old, "new": new, "calls": calls}))`);
    assert.deepEqual(result.old, ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call', 'on_session_finalize']);
    assert.deepEqual(result.new, HOOK_EVENTS.slice());
    const [start, stop, compaction] = result.calls;
    assert.equal(normalize(start).event, 'SubagentStart');
    assert.equal(start.session_id, 'child_1');
    assert.equal(start.parent_session_id, 'parent_1');
    assert.equal(start.prompt, 'audit billing');
    assert.equal(normalize(stop).event, 'SubagentStop');
    assert.equal(stop.last_assistant_message, 'two bugs');
    assert.equal(normalize(compaction).event, 'PreCompact');
  });

test('a Hermes turn: recall and instructions reach the model, then the mirror is written and read as a Claude-shaped transcript',
  { skip: !python && 'python3 not installed' }, async t => {
    const home = await scratch(t);
    const result = py(`
calls = []
def runner(command, input=None, **_):
    calls.append(json.loads(input))
    answer = {"additionalContext": "RECALL: we chose JSON mode"} if calls[-1]["hook_event_name"] in ("pre_llm_call", "on_session_start") else {}
    return types.SimpleNamespace(stdout=json.dumps(answer).encode())
e = plugin.Estelle(home=__import__("pathlib").Path(${JSON.stringify(home)}), runner=runner, cwd=lambda: "/tmp/hermes-project")
sid = ${JSON.stringify(SESSION)}
e.on_session_start(session_id=sid, model="m")
first = e.pre_llm_call(session_id=sid, user_message="read the readme")
second = e.pre_llm_call(session_id=sid, user_message="and again")
e.pre_tool_call(tool_name="write_file", args={"path": "a.py", "content": "x"}, session_id=sid, tool_call_id="c1")
e.post_tool_call(tool_name="write_file", args={"path": "a.py"}, result="ok", session_id=sid, tool_call_id="c1", status="ok")
history = [{"role": "user", "content": "read the readme"},
           {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"README.md\\"}"}}]},
           {"role": "tool", "tool_call_id": "c1", "content": "hello"},
           {"role": "assistant", "content": "It says hello."}]
e.post_llm_call(session_id=sid, conversation_history=history, turn_id="t1")
e.post_llm_call(session_id=sid, conversation_history=history, turn_id="t1")
e.on_session_finalize(session_id=sid)
print(json.dumps({"first": first, "second": second, "events": [c["hook_event_name"] for c in calls],
                  "tool": calls[3], "mirror": str(e.mirror(sid)), "stop": calls[5]}))`);
    assert.match(result.first.context, /RECALL: we chose JSON mode/);
    assert.match(result.first.context, /estelle_resume/, 'the first turn carries Estelle\'s instructions');
    assert.doesNotMatch(result.second.context, /## /, 'instructions are sent once, recall every turn');
    assert.deepEqual(result.events, ['on_session_start', 'pre_llm_call', 'pre_llm_call', 'pre_tool_call', 'post_tool_call',
      'post_llm_call', 'post_llm_call', 'on_session_finalize']);
    assert.deepEqual(result.tool.tool_input, { path: 'a.py', content: 'x' });
    assert.equal(result.stop.transcript_path, result.mirror);
    const lines = (await readFile(result.mirror, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 5, 'the second post_llm_call appends nothing');
    assert.deepEqual(lines.map(line => line.type), ['user', 'assistant', 'user', 'assistant', 'system']);
    const { messages } = await readTranscriptMessages({ path: result.mirror, host: 'hermes' });
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'assistant']);
    const calls = [];
    const stream = await streamSession({ payload: envelope('Stop', { transcript_path: result.mirror }), host: 'hermes',
      repo: 'fixture/hermes', stateDir: join(home, 'state'), request: async (route, body) => { calls.push(body); return {}; } });
    assert.equal(stream.transcript_format, 'hermes-plugin-mirror');
    const kinds = calls.flatMap(body => body.events ?? []).map(event => event.kind);
    for (const kind of ['customer_message', 'tool_call', 'tool_result', 'agent_message']) assert.ok(kinds.includes(kind), kind);
    assert.equal(calls[0].session_id, `hermes-${SESSION}`);
  });

test('the plugin reaches the real runner in a child Node process, which answers a session start without a key',
  { skip: !python && 'python3 not installed' }, async t => {
    const home = await scratch(t);
    const result = py(`
answer = plugin.run_hook("on_session_start", {"session_id": "s_1", "cwd": "/tmp", "transcript_path": None})
print(json.dumps(answer))`, { ESTELLE_API_KEY: '', ESTELLE_PLUGIN_DATA: join(home, 'state') });
    assert.match(result.additionalContext, /estelle_resume/);
  });
