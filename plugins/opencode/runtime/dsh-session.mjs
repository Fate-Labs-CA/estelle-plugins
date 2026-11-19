#!/usr/bin/env node
// The pane a cloud Silo types into. dsh ships no terminal interface, only one-shot `--profile headless`, so this turns each
// submitted prompt into one headless run on one continued session, and draws the two markers the typing layer reads.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { git, repository } from './io.mjs';

export const READY = 'dsh-ready>';
export const WORKING = 'dsh-working';
// A pasted prompt arrives as several lines. It is one task once input has been quiet this long.
const SETTLE_MS = 800;
const MAX_TASK_CHARS = 200_000;
const MAX_LINE_BYTES = 8_000_000;
const CLEAR = '\u001b[2J\u001b[H';

export function headlessArguments({ sessionId, gitDirectory }) {
  return ['--profile', 'headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never',
    ...(gitDirectory ? ['--add-dir', gitDirectory] : []), ...(sessionId ? ['--session-id', sessionId] : []), '-'];
}

/** Telemetry stays off even if a later patch layer turned a row back on. */
export function sessionEnvironment(env, repo) {
  return { ...env, DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED', ...(repo ? { ESTELLE_REPO: repo } : {}) };
}

export function describe(event) {
  if (event?.type === 'tool_call') return `${WORKING} · ${event.tool ?? 'tool'}`;
  if (event?.type === 'text' && typeof event.text === 'string') return `${WORKING} · ${event.text.split('\n')[0].slice(0, 160)}`;
  if (event?.type === 'status' && event.phase === 'step_start') return `${WORKING} · step ${event.step ?? ''}`.trimEnd();
  return null;
}

/** One submitted prompt, one headless process. The run's own exit decides what the pane says, never a parsed fragment. */
function runTask(task, state, out, spawnImpl) {
  return new Promise(resolve => {
    out.write(`${WORKING} · started\n`);
    const child = spawnImpl('dsh', headlessArguments(state), { cwd: state.cwd, env: state.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let answer = '';
    let failure = '';
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'session' && typeof event.sessionId === 'string') state.sessionId = event.sessionId;
      if (event.type === 'final') answer = typeof event.text === 'string' ? event.text : '';
      if (event.type === 'error') failure = String(event.message ?? 'dsh reported an error').slice(0, 2000);
      const shown = describe(event);
      if (shown) out.write(`${shown}\n`);
    });
    child.on('error', error => { failure = `dsh could not start: ${error.code ?? error.message}`; resolve({ answer, failure }); });
    child.on('close', code => resolve({ answer, failure: failure || (code === 0 ? '' : `dsh exited ${code}`) }));
    child.stdin.on('error', () => {});
    child.stdin.end(task);
  });
}

export async function runSession({ input = process.stdin, out = process.stdout, cwd = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
  const repo = repository(cwd, env);
  const state = { cwd, env: sessionEnvironment(env, repo?.name), sessionId: '',
    gitDirectory: git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) };
  const prompt = () => out.write(`${READY} `);
  let pending = [];
  let timer;
  let chain = Promise.resolve();
  const submit = () => {
    const task = pending.join('\n').slice(0, MAX_TASK_CHARS);
    pending = [];
    if (!task.trim()) return prompt();
    chain = chain.then(async () => {
      const { answer, failure } = await runTask(task, state, out, spawnImpl);
      // The screen is cleared so no working line stays above the ready marker for the typing layer to read as busy.
      out.write(`${CLEAR}${answer}${answer ? '\n' : ''}${failure ? `dsh failed: ${failure}\n` : ''}`);
      prompt();
    });
  };
  prompt();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    pending.push(line);
    clearTimeout(timer);
    timer = setTimeout(submit, SETTLE_MS);
  }
  clearTimeout(timer);
  if (pending.length) submit();
  await chain;
  return state;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runSession();
