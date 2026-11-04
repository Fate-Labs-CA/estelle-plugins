#!/usr/bin/env node
// The real `claude` and `codex` CLIs, each in a throwaway HOME, with this branch's plugin installed. Only two things are
// stubbed, on one local port: Estelle's server, and the model, which cannot be reached without someone's login. The stub
// model does one thing a real one would: it runs the shell command the rendered slash command told it to run. So a pass
// proves the package installs, the command reaches the model as written, the host's hook named the session, and the CLI
// called the door. It does not prove a real model follows the instructions, and it starts no machine.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RUN_MS = 90_000;
const LAST_LINE = 'LAST-LINE-FROM-THE-DOOR https://fatelabs.ca/dashboard/sessions?session=x';
// A random throwaway for each variable a CLI insists on. The stubs accept anything, and it authorises nothing anywhere.
const THROWAWAY = randomUUID();

const sse = rows => rows.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const usage = { input_tokens: 1, output_tokens: 1 };

function anthropicReply(block, stop) {
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null, usage };
  const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text };
  return sse([['message_start', { type: 'message_start', message }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]]);
}

function openaiReply(item) {
  const response = { id: 'resp_1', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return sse([['response.created', { type: 'response.created', response: { id: 'resp_1' } }],
    ['response.output_item.done', { type: 'response.output_item.done', item }],
    ['response.completed', { type: 'response.completed', response }]]);
}

function codexToolCall(tools, command) {
  const names = (tools || []).map(tool => tool.name).filter(Boolean);
  const name = names.find(n => n === 'shell_command') || names.find(n => n === 'exec_command') || names.find(n => n === 'shell') || names[0];
  const args = name === 'exec_command' ? { cmd: command } : name === 'shell' ? { command: ['bash', '-lc', command] } : { command };
  return { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: JSON.stringify(args) };
}

function startStubs(state) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = JSON.parse(text || '{}'); } catch { /* A probe with no JSON still answers. */ }
      const send = (status, value, type = 'application/json') => {
        response.writeHead(status, { 'Content-Type': type });
        response.end(type === 'application/json' ? JSON.stringify(value) : value);
      };
      const url = request.url.split('?')[0];
      if (url === '/sessions/move') {
        state.door.push(body);
        return send(200, { moved: true, final: true, session_id: body.session_id, message: 'm', last_message: LAST_LINE });
      }
      if (url.endsWith('/v1/messages')) return model(state, body, text, 'anthropic', send);
      if (url.endsWith('/responses')) return model(state, body, text, 'openai', send);
      state.other.push(url);
      return send(200, {});
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

function model(state, body, text, dialect, send) {
  state.modelCalls.push(text);
  const stream = 'text/event-stream';
  const reported = text.includes(LAST_LINE);
  const wanted = state.command && text.includes(state.trigger) && !reported && !state.ran;
  if (dialect === 'anthropic') {
    if (wanted) {
      state.ran = true;
      return send(200, anthropicReply({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: state.command } }, 'tool_use'), stream);
    }
    return send(200, anthropicReply({ type: 'text', text: reported ? LAST_LINE : `stub-model: ${state.reply || 'ok'}` }, 'end_turn'), stream);
  }
  if (wanted) {
    state.ran = true;
    return send(200, openaiReply(codexToolCall(body.tools, state.command)), stream);
  }
  return send(200, openaiReply({ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: reported ? LAST_LINE : 'stub-model: ok' }] }), stream);
}

function run(binary, args, { env, cwd }) {
  return new Promise(done => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ code: 'timeout', out, err }); }, RUN_MS);
    child.on('close', code => { clearTimeout(timer); done({ code, out, err }); });
  });
}

async function fixtureRepo(base) {
  const origin = join(base, 'acme', 'app.git');
  await mkdir(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', origin]);
  const cwd = join(base, 'work');
  await mkdir(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, HOME: base, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' } });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  await writeFile(join(cwd, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('push', '-q', '-u', 'origin', 'main');
  return cwd;
}

// Only what a child needs: this deliberately does not inherit the caller's environment, so no real key can reach it.
const cleanEnv = (home, port, extra = {}) => ({ PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), LANG: 'C.UTF-8',
  ESTELLE_API_URL: `http://127.0.0.1:${port}`, ESTELLE_API_KEY: THROWAWAY, ESTELLE_REPO: 'acme/app', ...extra });

function report(name, checks, detail = {}) {
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([label]) => label);
  console.log(JSON.stringify({ host: name, result: failed.length ? 'fail' : 'pass', checks, ...detail }, null, 1));
  return !failed.length;
}

// Which fields of a conversation this CLI really wrote carry a credential-looking NAME, with the type of the value and
// never the value. A refusal the proof cannot explain would otherwise read as a failure of the host.
async function flaggedFields(folder) {
  const written = execFileSync('find', [folder, '-name', '*.jsonl'], { encoding: 'utf8' }).trim().split('\n')[0];
  const flagged = new Set();
  const walk = (value, at = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|password|api[_-]?key|private[_-]?key/i.test(key) && typeof item !== 'number') flagged.add(`${at}${key}:${typeof item}`);
      walk(item, `${at}${key}.`);
    }
  };
  if (written) for (const line of (await readFile(written, 'utf8')).split('\n').filter(Boolean)) walk(JSON.parse(line));
  return [...flagged];
}

async function proveClaude(port, state, base) {
  const home = join(base, 'claude-home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const cwd = await fixtureRepo(join(base, 'claude'));
  const plugin = join(ROOT, 'plugins/claude');
  const env = cleanEnv(home, port, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: THROWAWAY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });
  const validate = await run('claude', ['plugin', 'validate', plugin], { env, cwd });
  state.command = `node "${plugin}/runtime/cli.mjs" move handoff <<'ESTELLE_MOVE'\nfinish the tests\nESTELLE_MOVE`;
  state.trigger = "<<'ESTELLE_MOVE'";
  const result = await run('claude', ['-p', '/estelle:handoff finish the tests', '--plugin-dir', plugin, '--dangerously-skip-permissions',
    '--output-format', 'text', '--model', 'claude-sonnet-4-5'], { env, cwd });
  const door = state.door.at(-1) || {};
  const flagged = await flaggedFields(join(home, '.claude/projects'));
  return { checks: {
    'claude plugin validate passes': validate.code === 0,
    'the rendered /estelle:handoff reached the model': state.modelCalls.some(text => text.includes('move handoff')),
    'the words reached the model with the command': state.modelCalls.some(text => text.includes('finish the tests')),
    'the door was called': state.door.length === 1,
    'as a handoff': door.mode === 'handoff',
    'naming the session the host hook saw': /^claude-code-[0-9a-f-]{36}$/.test(door.session_id || ''),
    'with the pinned commit': /^[0-9a-f]{40}$/.test(door.git?.commit || ''),
    'and the note': door.note === 'finish the tests',
    'the real conversation file this CLI just wrote crossed': Boolean(door.native),
    'the host printed the door\'s last line': result.out.includes(LAST_LINE),
  }, detail: { native: door.native ? 'carried' : door.native_unavailable, flagged, exit: result.code, stderr: result.err.slice(-300) }, door };
}

// The usual path: this host signed in with OAuth, so the CLI holds no key. It must not reach for the server, and the model
// must be handed the MCP call. The stub model cannot make that call, so this stops at showing it was handed over.
async function proveClaudeOAuth(port, state, base) {
  const home = join(base, 'claude-oauth-home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const cwd = await fixtureRepo(join(base, 'claude-oauth'));
  const plugin = join(ROOT, 'plugins/claude');
  const env = cleanEnv(home, port, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: THROWAWAY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });
  delete env.ESTELLE_API_KEY;
  state.command = `node "${plugin}/runtime/cli.mjs" move handoff <<'ESTELLE_MOVE'\nfinish the tests\nESTELLE_MOVE`;
  state.trigger = "<<'ESTELLE_MOVE'";
  state.door.length = 0; state.modelCalls.length = 0; state.ran = false;
  const result = await run('claude', ['-p', '/estelle:handoff finish the tests', '--plugin-dir', plugin, '--dangerously-skip-permissions',
    '--output-format', 'text', '--model', 'claude-sonnet-4-5'], { env, cwd });
  const call = state.modelCalls.find(text => text.includes('ESTELLE_MCP_CALL') && text.includes('move_key'));
  return { checks: {
    'the door was not called, because this process cannot authenticate to it': state.door.length === 0,
    'the model was handed one exact estelle_move call': Boolean(call),
    'and it was not told the move could not be confirmed': !state.modelCalls.some(text => text.includes('could not confirm whether')),
  }, detail: { exit: result.code, err: result.err.slice(-200) } };
}

// Where #1274 writes the file, on a machine that never held this session, read by the real CLI.
async function proveClaudeResume(port, state, base, door) {
  if (!door.native?.transcript) return { checks: { 'a conversation file was available to resume': false }, detail: { reason: door.native_unavailable } };
  // Words only the conversation holds: this machine never saw the session, and the new prompt is just `continue`.
  const marker = 'finish the tests';
  const sid = door.native.session_id;
  const home = join(base, 'claude-box');
  const cwd = join(home, 'repo');
  await mkdir(cwd, { recursive: true });
  const canonical = await realpath(cwd);
  const project = join(home, '.claude/projects', canonical.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${sid}.jsonl`), door.native.transcript);
  const env = cleanEnv(home, port, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: THROWAWAY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  state.command = ''; state.modelCalls.length = 0;
  const resumed = await run('claude', ['-p', 'continue', '--resume', sid, '--output-format', 'text', '--model', 'claude-sonnet-4-5'], { env, cwd });
  return { checks: { 'claude --resume sent the conversation\'s words to the model': state.modelCalls.some(text => text.includes(marker)),
    'and refused nothing': resumed.code === 0 && !/No conversation found/.test(resumed.err + resumed.out) },
    detail: { exit: resumed.code, out: resumed.out.slice(-160), err: resumed.err.slice(-200) } };
}

async function proveCodex(port, state, base) {
  const home = join(base, 'codex-home');
  const codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  const cwd = await fixtureRepo(join(base, 'codex'));
  const env = cleanEnv(home, port, { CODEX_HOME: codexHome, STUB_MODEL_ACCESS: THROWAWAY });
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.1-codex"\nmodel_provider = "stub"\n[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "STUB_MODEL_ACCESS"\nwire_api = "responses"\n`);
  const market = await run('codex', ['plugin', 'marketplace', 'add', ROOT], { env, cwd });
  const add = await run('codex', ['plugin', 'add', 'estelle@estelle-plugins'], { env, cwd });
  const list = await run('codex', ['plugin', 'list'], { env, cwd });
  const installed = execFileSync('find', [codexHome, '-type', 'f', '-path', '*command-skills/handoff/SKILL.md'], { encoding: 'utf8' }).trim().split('\n')[0];
  const cli = installed ? resolve(installed, '../../../runtime/cli.mjs') : '';
  // Codex lists a skill by name and its model opens the file, so the stub acts on the listing. This does not prove the
  // skill's body was read; a separate check below pins that the shipped body holds the command.
  state.command = `node "${cli}" move handoff <<'ESTELLE_MOVE'\n\nESTELLE_MOVE`;
  state.trigger = 'handoff';
  const result = await run('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '$handoff'], { env, cwd });
  const door = state.door.at(-1) || {};
  return { checks: {
    'the marketplace added from this branch': market.code === 0,
    'the plugin installed': add.code === 0,
    'it is listed': /estelle/.test(list.out),
    'the handoff skill was installed': Boolean(installed),
    'its name reached the model': state.modelCalls.some(text => text.includes('handoff')),
    'the installed skill body holds the command': (await readFile(installed, 'utf8')).includes("move handoff <<'ESTELLE_MOVE'"),
    'the door was called': state.door.length === 1,
    'as a handoff': door.mode === 'handoff',
    'naming a Codex session': /^codex-/.test(door.session_id || ''),
    'with the pinned commit': /^[0-9a-f]{40}$/.test(door.git?.commit || ''),
    'the real rollout this CLI just wrote crossed': Boolean(door.native),
  }, detail: { native: door.native ? 'carried' : door.native_unavailable, flagged: await flaggedFields(join(codexHome, 'sessions')), exit: result.code, out: result.out.slice(-160) }, door };
}

// A machine that never held this session, reading the file where the server's import writes it, in a home with no plugin.
async function proveCodexResume(port, state, base, door) {
  if (!door.native?.transcript) return { checks: { 'a rollout was available to resume': false }, detail: { reason: door.native_unavailable } };
  const sid = door.native.session_id;
  const home = join(base, 'codex-box');
  const codexHome = join(home, '.codex');
  const cwd = join(home, 'repo');
  const meta = JSON.parse(door.native.transcript.split('\n')[0]).payload;
  const stamp = new Date(meta.timestamp).toISOString();
  const folder = join(codexHome, 'sessions', stamp.slice(0, 4), stamp.slice(5, 7), stamp.slice(8, 10));
  await mkdir(folder, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(folder, `rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${sid}.jsonl`), door.native.transcript);
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.1-codex"\nmodel_provider = "stub"\n[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "STUB_MODEL_ACCESS"\nwire_api = "responses"\n`);
  const env = cleanEnv(home, port, { CODEX_HOME: codexHome, STUB_MODEL_ACCESS: THROWAWAY });
  state.command = ''; state.modelCalls.length = 0;
  const resumed = await run('codex', ['exec', '--skip-git-repo-check', 'resume', sid, 'continue'], { env, cwd });
  return { checks: { 'codex resume sent the conversation\'s words to the model': state.modelCalls.some(text => text.includes('$handoff')),
    'and refused nothing': resumed.code === 0 }, detail: { exit: resumed.code, err: resumed.err.slice(-240) } };
}

// Set ESTELLE_PROVE_SAVE to a folder to keep what crossed, so the server's own validator can be run over a real file.
async function saveForServer(host, door) {
  if (!process.env.ESTELLE_PROVE_SAVE || !door.native) return;
  await writeFile(join(process.env.ESTELLE_PROVE_SAVE, `${host}.json`), JSON.stringify(door.native));
}

const hosts = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex'];
const base = await realpath(await mkdtemp(join(tmpdir(), 'estelle-prove-host-')));
let passed = true;
try {
  for (const host of hosts) {
    const state = { door: [], other: [], modelCalls: [], command: '', ran: false };
    const server = await startStubs(state);
    const { port } = server.address();
    if (host === 'claude') {
      const first = await proveClaude(port, state, base);
      passed = report('claude-code', first.checks, first.detail) && passed;
      state.ran = false;
      await saveForServer('claude-code', first.door);
      const second = await proveClaudeResume(port, state, base, first.door);
      passed = report('claude-code --resume', second.checks, second.detail) && passed;
      const oauth = await proveClaudeOAuth(port, state, base);
      passed = report('claude-code, signed in with OAuth', oauth.checks, oauth.detail) && passed;
    } else {
      const proved = await proveCodex(port, state, base);
      passed = report('codex', proved.checks, proved.detail) && passed;
      await saveForServer('codex', proved.door);
      const second = await proveCodexResume(port, state, base, proved.door);
      passed = report('codex resume', second.checks, second.detail) && passed;
    }
    server.close();
  }
} finally { await rm(base, { recursive: true, force: true }); }
process.exitCode = passed ? 0 : 1;
