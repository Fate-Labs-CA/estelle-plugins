// Estelle for OpenClaw: one native plugin (openclaw.plugin.json, entry in package.json `openclaw.extensions`). It hands
// OpenClaw's typed hooks to the shared hook runner (adapters/host-bridge.mjs) and places what the runner answers.
// Written against openclaw 2026.11.10 (docs/plugins/hooks/*.md and the dist payloads); not run inside a live gateway here
// (its plugin commands need Node.js 24.16), so the tests drive the real handlers with a fake `api`.
//
// Where text goes: OpenClaw's observe hooks (after_tool_call, agent_end) return nothing the model sees, so the only
// places Estelle can speak to the model are `before_prompt_build` results. Start text and this session's identity go in
// `prependSystemContext`; recall, a write warning and mail pulled at a tool boundary wait for the next
// `before_prompt_build` and go in `prependContext`. Mail therefore arrives at the next model call that builds a prompt,
// not inside the tool result as on Claude Code.
// Needs `plugins.entries.estelle.hooks.allowConversationAccess: true` in openclaw.json for before_prompt_build and agent_end.
import { contextOf, END_TIMEOUT_MS, readInstructions, runHook, warningOf } from './host-bridge.mjs';
import { mirrorPath, syncMirror } from './openclaw-mirror.mjs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const HOST = 'openclaw';
const MAX_SESSIONS = 256;
const MAX_QUEUED = 8;
const MAX_TOOL_OUTPUT = 4_000;

/** OpenClaw session ids and keys can hold `:`; the runner accepts `[A-Za-z0-9_-]{1,200}`. */
export const safeId = value => (typeof value === 'string' && value.trim()
  ? value.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200) : '');
const stateRoot = env => env.ESTELLE_STATE_DIR || join(env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'estelle');
const textOf = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value?.content)) return value.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
};

/** Wire Estelle into one OpenClaw plugin runtime. `run` and `instructions` are injectable so tests drive the real handlers. */
export function activate(api, { env = process.env, run = runHook, instructions, stateDir = stateRoot(env) } = {}) {
  const sessions = new Map();
  // Read on the first prompt, so register() returns at once: OpenClaw's docs do not say it may be asynchronous.
  let guidePending = null;
  const guide = () => (instructions !== undefined ? instructions : (guidePending ??= readInstructions().catch(() => '')));
  const warn = text => { try { api.logger?.warn?.(text); } catch { /* a logger is optional */ } };
  const state = id => {
    if (!sessions.has(id)) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { queued: [], written: new Set(), identity: '', cwd: '', started: null });
    }
    return sessions.get(id);
  };
  const idOf = ctx => safeId(ctx?.sessionId) || safeId(ctx?.sessionKey);
  const hook = (event, id, ctx, extra = {}, timeoutMs) => {
    const session = state(id);
    if (isAbsolute(ctx?.workspaceDir ?? '')) session.cwd = ctx.workspaceDir;
    return run(HOST, { hook_event_name: event, session_id: id, cwd: session.cwd || process.cwd(),
      transcript_path: mirrorPath(stateDir, id), ...extra }, { env, ...(timeoutMs ? { timeoutMs } : {}) });
  };
  const queue = (session, text) => {
    if (!text) return;
    session.queued.push(text);
    if (session.queued.length > MAX_QUEUED) session.queued.shift();
  };
  const start = (id, ctx) => {
    const session = state(id);
    session.started ??= hook('session_start', id, ctx).then(output => {
      session.identity = contextOf(output);
      const notice = warningOf(output);
      if (notice) warn(notice);
    });
    return session.started;
  };
  const mirror = async (id, messages, done) => {
    try { await syncMirror({ sessionId: id, messages, path: mirrorPath(stateDir, id), written: state(id).written, done }); }
    catch { /* The runner reports a missing or stale transcript itself. */ }
  };

  api.on('session_start', async (event, ctx) => {
    const id = idOf(ctx) || safeId(event?.sessionId);
    if (id) await start(id, ctx);
  });
  api.on('before_prompt_build', async (event, ctx) => {
    const id = idOf(ctx);
    if (!id) return undefined;
    await start(id, ctx);
    const session = state(id);
    const prompt = typeof event?.currentUserMessage === 'string' ? event.currentUserMessage : typeof event?.prompt === 'string' ? event.prompt : '';
    const recall = prompt.trim() ? contextOf(await hook('before_prompt_build', id, ctx, { prompt })) : '';
    const pending = session.queued.splice(0);
    const lead = [...pending, recall].filter(Boolean).join('\n\n');
    const system = [await guide(), session.identity].filter(Boolean).join('\n\n');
    // The identity and instructions live in the system context on every call, so a compaction never drops them.
    return { ...(system ? { prependSystemContext: system } : {}), ...(lead ? { prependContext: lead } : {}) };
  });
  api.on('before_tool_call', async (event, ctx) => {
    const id = idOf(ctx);
    if (!id || typeof event?.toolName !== 'string') return undefined;
    const output = await hook('before_tool_call', id, ctx, { tool_name: event.toolName, tool_input: event.params ?? {},
      tool_use_id: event.toolCallId });
    const warning = warningOf(output);
    if (warning) { queue(state(id), warning); warn(warning); }
    return undefined; // ⛔ A warning, never a block or a rewrite.
  });
  api.on('after_tool_call', async (event, ctx) => {
    const id = idOf(ctx);
    if (!id || typeof event?.toolName !== 'string') return;
    const output = textOf(event.result).slice(0, MAX_TOOL_OUTPUT);
    // The mail Estelle pulls at this boundary is queued for the next prompt build: this hook's return is ignored.
    queue(state(id), contextOf(await hook('after_tool_call', id, ctx, { tool_name: event.toolName, tool_input: event.params ?? {},
      tool_use_id: event.toolCallId, tool_response: { output, is_error: Boolean(event.error) } })));
  });
  api.on('agent_end', async (event, ctx) => {
    const id = idOf(ctx);
    if (!id) return;
    await mirror(id, event?.messages, true);
    await hook('agent_end', id, ctx);
  });
  api.on('before_compaction', async (_event, ctx) => {
    const id = idOf(ctx);
    if (id) await hook('before_compaction', id, ctx);
  });
  api.on('session_end', async (_event, ctx) => {
    const id = idOf(ctx);
    if (!id) return;
    await hook('session_end', id, ctx, {}, END_TIMEOUT_MS);
    sessions.delete(id);
  });
}

export default {
  id: 'estelle', name: 'Estelle',
  description: 'Estelle memory, recall, write warnings, session capture and checkpoints for OpenClaw.',
  configSchema: { safeParse: value => ({ success: true, data: value ?? {} }), jsonSchema: { type: 'object', additionalProperties: false } },
  register: api => activate(api),
};
