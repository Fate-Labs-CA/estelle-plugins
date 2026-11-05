// The hook host for DeepSeek Harness. dsh has no external hook protocol, so these listeners are the host: they run on dsh's
// own events and start the same `runtime/cli.mjs hook` process every other host starts. dsh-plugin.mjs is the mounted entry.
// Hooks never stop a turn: a failed hook is logged and the agent continues, as on every other host.
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hash, stateDirectory } from '../runtime/io.mjs';
import { WRITE_TOOLS } from './dsh.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'runtime', 'cli.mjs');
const HOOK_TIMEOUT_MS = 20_000;
const SESSION_END_TIMEOUT_MS = 3_000;
const MAX_HOOK_OUTPUT_BYTES = 2_000_000;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_SKILLS = 256;
const SKILL_RANK = 650; // Below every root dsh scans, so a person's own skill of the same name wins.
const CONTEXT_SOURCE = Object.freeze({ kind: 'estelle' });
const CAPTURED = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']);
const WRITES = new Set(WRITE_TOOLS);

const textBlocks = text => [{ type: 'text', text }];
const blocksText = content => (Array.isArray(content) ? content : []).filter(block => block?.type === 'text')
  .map(block => block.text).join('');
const isSubagent = session => session?.header?.origin === 'subagent';

/** One hook, one process, one bounded answer. Null on any failure: the runtime records its own diagnostics. */
function runHook(ctx, payload, timeout = HOOK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [CLI, 'hook', 'dsh'], { cwd: payload.cwd, timeout, maxBuffer: MAX_HOOK_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) { ctx.logger.warn(`estelle: ${payload.hook_event_name} hook failed: ${error.code ?? error.message}`); return resolve(null); }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : null); }
        catch { ctx.logger.warn(`estelle: ${payload.hook_event_name} hook answered with text that is not JSON`); resolve(null); }
      });
    child.stdin.on('error', () => {}); // A hook that died before reading its input already reported through the callback.
    child.stdin.end(JSON.stringify(payload));
  });
}

/** The readable JSONL our runtime maps. dsh's own log is compressed and its persistence seam exposes no path. */
function transcriptWriter(ctx) {
  const directory = join(stateDirectory(), 'dsh-transcripts');
  const tails = new Map();
  const written = new Map();
  const pathOf = id => join(directory, `${hash(id).slice(0, 40)}.jsonl`);
  const append = (id, event) => {
    if (!CAPTURED.has(event.type)) return;
    const line = JSON.stringify({ type: event.type, seq: event.seq, time: event.time, data: event.data }) + '\n';
    const size = (written.get(id) ?? 0) + Buffer.byteLength(line);
    if (size > MAX_TRANSCRIPT_BYTES) return; // A later reader sees an incomplete log, never a truncated line.
    written.set(id, size);
    const next = (tails.get(id) ?? mkdir(directory, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(pathOf(id), line, { mode: 0o600 }))
      .catch(error => ctx.logger.warn(`estelle: transcript write failed: ${error.code ?? error.message}`));
    tails.set(id, next);
  };
  return { append, pathOf, flush: id => tails.get(id) ?? Promise.resolve() };
}

function registerCommands(ctx, createUserMessage) {
  ctx.inject(['commands'], child => {
    const directory = join(ROOT, 'commands');
    for (const entry of readdirSync(directory).sort()) {
      const source = readFileSync(join(directory, entry), 'utf8');
      const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
      if (!description) throw new Error(`Command needs one description line: ${entry}`);
      child.commands.register({
        name: `estelle-${entry.replace(/\.md$/, '')}`, description, input: { hint: '<what you want>' },
        // A dsh command creates no model message by itself. Ours are instructions to the model, so they submit one.
        handler: ({ agent, rawInput }) => {
          const asked = rawInput.trim() || 'what the person asked for';
          agent.followup(createUserMessage({ content: textBlocks(body.replaceAll('$ARGUMENTS', asked)), source: { kind: 'user' } }));
          return { kind: 'success' };
        },
      });
    }
  });
}

function registerSkills(ctx) {
  ctx.inject(['skills'], child => {
    const directory = join(ROOT, 'skills');
    const candidates = async () => {
      const names = (await readdir(directory)).sort().slice(0, MAX_SKILLS);
      const rows = await Promise.all(names.map(async skill => {
        const locator = join(directory, skill, 'SKILL.md');
        const [, frontMatter] = /^---\n([\s\S]*?)\n---\n/.exec(await readFile(locator, 'utf8')) ?? [];
        const description = /^description: (.+)$/m.exec(frontMatter ?? '')?.[1]?.replace(/^"|"$/g, '');
        return description ? { name: skill, description, locator, provider: 'estelle', source: 'bundled', rank: SKILL_RANK,
          invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: dirname(locator) } } : null;
      }));
      return rows.filter(Boolean);
    };
    child.skills.registerProvider(() => ({ name: 'estelle', list: candidates, async get(candidate) {
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: await readFile(candidate.locator, 'utf8') };
    } }));
  });
}

function registerInstructions(ctx) {
  ctx.inject(['systemPrompt'], child => {
    const text = readFileSync(join(ROOT, 'instructions.md'), 'utf8');
    child.systemPrompt.section({ name: 'estelle', order: child.systemPrompt.getSectionOrder('TOOL_GOAL'), text });
  });
}

export function applyEstelle(ctx, { createUserMessage }) {
  const contextMessage = text => createUserMessage({ content: textBlocks(text), source: CONTEXT_SOURCE });
  const transcripts = transcriptWriter(ctx);
  const running = new Set();
  const track = work => { running.add(work); work.finally(() => running.delete(work)); return work; };
  // Dispose returns once hooks in flight settle, and dsh bounds its own shutdown at five seconds.
  ctx.effect(() => () => Promise.allSettled([...running]), 'estelle: drain hooks in flight');
  const cwdOf = agent => agent.session?.header?.cwd ?? process.cwd();
  const base = (agent, event) => ({ hook_event_name: event, session_id: agent.session.header.id, cwd: cwdOf(agent),
    transcript_path: transcripts.pathOf(agent.session.header.id) });
  const live = new Map();

  ctx.on('session/event', (session, event) => {
    if (isSubagent(session)) return;
    transcripts.append(session.header.id, event);
    // turn/end, not agent/turn-stopping: it is the event that makes the turn's final line readable by the stream.
    const agent = live.get(session.header.id);
    if (event.type === 'turn/end' && agent) {
      track(transcripts.flush(session.header.id).then(() => runHook(ctx, base(agent, 'Stop'))));
    }
  });

  ctx.on('agent/created', async ({ agent, source }) => {
    if (isSubagent(agent.session)) return;
    live.set(agent.session.header.id, agent);
    const output = await track(runHook(ctx, { ...base(agent, 'SessionStart'), source: String(source ?? 'startup') }));
    if (output?.context) agent.inject(contextMessage(output.context));
  });

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const asked = messages.filter(message => message.source?.kind === 'user');
    if (!asked.length || isSubagent(agent.session)) return next();
    const output = await track(runHook(ctx, { ...base(agent, 'UserPromptSubmit'), prompt: asked.map(m => blocksText(m.content)).join('\n') }));
    const decision = await next();
    return output?.context && decision.kind === 'enter'
      ? { ...decision, messages: [...decision.messages, contextMessage(output.context)] } : decision;
  });

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!execution.agent || !WRITES.has(execution.name)) return next();
    const output = await track(runHook(ctx, { ...base(execution.agent, 'PreToolUse'), tool_name: execution.name,
      tool_input: execution.arguments, tool_use_id: execution.callId }));
    // ⛔ A warning and never a refusal: the write goes ahead either way.
    if (output?.warning) {
      ctx.logger.warn(output.warning);
      execution.agent.inject(contextMessage(output.warning));
    }
    return next();
  });

  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next();
    if (execution.agent && !isSubagent(execution.agent.session)) {
      // Observation only. The agent does not wait for capture, and dispose drains what is still running.
      track(transcripts.flush(execution.agent.session.header.id).then(() => runHook(ctx, { ...base(execution.agent, 'PostToolUse'),
        tool_name: execution.name, tool_input: execution.arguments, tool_use_id: execution.callId,
        tool_response: { is_error: result?.isError === true } })));
    }
    return decision;
  });

  ctx.on('agent/disposed', ({ agent }) => {
    if (isSubagent(agent.session)) return;
    live.delete(agent.session.header.id);
    track(transcripts.flush(agent.session.header.id).then(() => runHook(ctx, base(agent, 'SessionEnd'), SESSION_END_TIMEOUT_MS)));
  });

  registerCommands(ctx, createUserMessage);
  registerSkills(ctx);
  registerInstructions(ctx);
}
