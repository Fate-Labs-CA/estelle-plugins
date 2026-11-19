// Estelle for OpenCode: one plugin module. It adds the Estelle MCP server, commands, agents, skills and instructions
// through OpenCode's `config` hook, and hands OpenCode's own events to the shared hook runner (adapters/host-bridge.mjs).
// Written against @opencode-ai/plugin 1.19.6 (`PluginModule = { id, server }`, `Hooks`).
import { join } from 'node:path';
import { contextOf, END_TIMEOUT_MS, PLUGIN_ROOT, readAgents, readCommands, runHook, SERVER_NAME, SERVER_URL, warningOf }
  from './host-bridge.mjs';
import { mirrorPath, syncMirror } from './opencode-mirror.mjs';
import { stateDirectory } from '../runtime/io.mjs';

const HOST = 'opencode';
// Sessions one OpenCode process keeps state for; the oldest is forgotten past this.
const MAX_SESSIONS = 256;
const MAX_TOOL_WARNINGS = 64;

/** The config this plugin adds. Pure, so the test reads exactly what OpenCode is given. Nothing the person configured
 *  is replaced: their own `Estelle` server, command or agent of the same name wins. */
export function estelleConfig(config, { commands, agents, root = PLUGIN_ROOT, env = process.env }) {
  const key = env.ESTELLE_API_KEY;
  // No key: OpenCode's own MCP OAuth signs in (`opencode mcp auth Estelle`). A header with an empty key would disable that.
  const server = { type: 'remote', url: SERVER_URL, enabled: true,
    ...(key && !/[\r\n]/.test(key) ? { headers: { Authorization: `Bearer ${key}` } } : {}) };
  const command = { ...config.command };
  for (const item of commands) command[`estelle:${item.name}`] ??= { description: item.description, template: item.template };
  const agent = { ...config.agent };
  for (const item of agents) agent[item.name] ??= { description: item.description, prompt: item.prompt, mode: 'subagent' };
  const instructions = [...(config.instructions ?? [])];
  const own = join(root, 'instructions.md');
  if (!instructions.includes(own)) instructions.push(own);
  const paths = [...(config.skills?.paths ?? [])];
  if (!paths.includes(join(root, 'skills'))) paths.push(join(root, 'skills'));
  return { ...config, mcp: { [SERVER_NAME]: server, ...config.mcp }, command, agent, instructions,
    skills: { ...config.skills, paths } };
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
  return value;
}

/** The plugin's hooks for one OpenCode instance. `run` and `messages` are injectable so tests drive the real wiring. */
export function createHooks({ directory, client, env = process.env, run = runHook, stateDir = stateDirectory(env),
  messagesOf } = {}) {
  const sessions = new Map();     // sessionID -> { parent, context, started, written, pending, stopping }
  const warnings = new Map();     // callID -> warning text for the tool result
  const read = messagesOf ?? (async id => (await client.session.messages({ path: { id } }))?.data ?? []);
  const cwd = directory;
  const envelope = (event, sessionID, extra = {}) => {
    const session = sessions.get(sessionID);
    return { hook_event_name: event, session_id: sessionID, cwd, transcript_path: mirrorPath(stateDir, sessionID),
      ...(session?.parent ? { parent_session_id: session.parent } : {}), ...extra };
  };
  const state = sessionID => sessions.get(sessionID) ?? remember(sessions, sessionID, { parent: null, context: '', written: new Set() });

  /** SessionStart once per session this process meets: created here, or resumed from before it loaded. */
  function start(sessionID, event = 'session.seen', parent = null) {
    const session = state(sessionID);
    if (parent) session.parent = parent;
    session.started ??= run(HOST, envelope(event, sessionID), { env }).then(output => { session.context = contextOf(output); });
    return session.started;
  }

  /** `current` is the person's message from chat.message, which OpenCode has not stored yet. */
  async function mirror(sessionID, idle, current) {
    const session = state(sessionID);
    try {
      const messages = [...await read(sessionID), ...(current ? [current] : [])];
      await syncMirror({ messages, path: mirrorPath(stateDir, sessionID), written: session.written, idle });
    } catch { /* The runner reports a missing or stale transcript itself. */ }
  }

  /** Stop once per turn. `opencode run` can dispose the instance while session.idle's work is in flight, so dispose
   *  waits for it and saves any turn that never reached idle. */
  function stop(sessionID) {
    const session = state(sessionID);
    session.pending = false;
    session.stopping = (async () => {
      await mirror(sessionID, true);
      await run(HOST, envelope('session.idle', sessionID), { env });
    })();
    return session.stopping;
  }

  return {
    config: async config => { Object.assign(config, estelleConfig(config, { commands: await readCommands(), agents: await readAgents(), env })); },
    event: async ({ event }) => {
      const info = event?.properties?.info;
      if (event?.type === 'session.created' && info?.id) await start(info.id, 'session.created', info.parentID ?? null);
      else if (event?.type === 'session.idle' && event.properties?.sessionID) await stop(event.properties.sessionID);
      else if (event?.type === 'session.deleted' && info?.id) {
        await run(HOST, envelope('session.deleted', info.id), { env, timeoutMs: END_TIMEOUT_MS });
        sessions.delete(info.id);
      }
    },
    // The start text is part of the system prompt on every model call, so a compaction never drops this session's identity.
    'experimental.chat.system.transform': async (input, output) => {
      if (!input?.sessionID) return;
      await start(input.sessionID);
      const text = sessions.get(input.sessionID)?.context;
      if (text) output.system.push(text);
    },
    'chat.message': async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return;
      await start(sessionID);
      state(sessionID).pending = true;
      await mirror(sessionID, false, { info: { role: 'user', ...output.message }, parts: output.parts ?? [] });
      const prompt = (output.parts ?? []).filter(part => part?.type === 'text' && !part.synthetic).map(part => part.text).join('\n');
      const text = contextOf(await run(HOST, envelope('chat.message', sessionID, { prompt, model: input.model?.modelID ?? null }), { env }));
      // Recall goes into the person's message as a synthetic part: the model reads it, the mirror and capture skip it.
      if (text) output.parts.push({ id: `${output.message.id.replace(/^msg/, 'prt')}estelle`, sessionID,
        messageID: output.message.id, type: 'text', text, synthetic: true });
    },
    'tool.execute.before': async (input, output) => {
      const warning = warningOf(await run(HOST, envelope('tool.execute.before', input.sessionID,
        { tool_name: input.tool, tool_input: output.args ?? {}, tool_use_id: input.callID }), { env }));
      if (warning) remember(warnings, input.callID, warning);
      if (warnings.size > MAX_TOOL_WARNINGS) warnings.delete(warnings.keys().next().value);
    },
    // Mail and room entries for this session arrive with the tool result the model is about to read.
    'tool.execute.after': async (input, output) => {
      const text = contextOf(await run(HOST, envelope('tool.execute.after', input.sessionID, { tool_name: input.tool,
        tool_input: input.args ?? {}, tool_use_id: input.callID, tool_response: { output: String(output.output ?? '').slice(0, 4_000) } }), { env }));
      const warning = warnings.get(input.callID);
      warnings.delete(input.callID);
      const extra = [warning, text].filter(Boolean).join('\n\n');
      if (extra) output.output = `${output.output ?? ''}\n\n${extra}`;
    },
    dispose: async () => {
      await Promise.allSettled([...sessions.values()].map(session => session.stopping));
      await Promise.allSettled([...sessions.entries()].filter(([, session]) => session.pending).map(([id]) => stop(id)));
    },
    'experimental.session.compacting': async input => {
      if (!input?.sessionID) return;
      await mirror(input.sessionID, false);
      await run(HOST, envelope('experimental.session.compacting', input.sessionID), { env });
    },
  };
}

export const server = async input => createHooks({ directory: input.directory, client: input.client });
export default { id: 'estelle', server };
