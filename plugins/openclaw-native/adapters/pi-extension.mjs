// Estelle for Pi: one extension. It registers the Estelle MCP server with Pi's built-in MCP support, the Estelle
// commands, and hands Pi's own events to the shared hook runner (adapters/host-bridge.mjs). Skills ship in the package
// manifest (`pi.skills`). Written against @earendil-works/pi-coding-agent 1.5.2 (docs/extensions.md, docs/mcp.md).
import { contextOf, END_TIMEOUT_MS, readCommands, readInstructions, runHook, SERVER_NAME, SERVER_URL, warningOf }
  from './host-bridge.mjs';

const HOST = 'pi';
const MAX_TOOL_WARNINGS = 64;
// Tools declared to the model directly; the rest of Estelle's tools are found with Pi's `tool_search` when needed.
// `review` stays deferred: its input schema's root is a oneOf, which some providers refuse in a declaration (xAI
// answered 400 `invalid_client_tool_schema` for the whole request, measured 2026-11-18), so declaring it up front would
// break every turn on those providers instead of only the turn that asks for it.
export const DIRECT_TOOLS = Object.freeze(['estelle_resume', 'estelle_grep', 'verify', 'find_definition', 'find_usages',
  'locate', 'memory_chat', 'estelle_move', 'estelle_docs']);

const COMMAND = /^\/estelle:([a-z][a-z-]{0,40})(?:\s+([\s\S]*))?$/;

/** Offers `/estelle:<name>` while the person types it at the start of the editor; anything else goes to Pi's own. */
export function completer(current, byName) {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const typed = cursorLine === 0 && /^\/e[a-z:-]*$/.test(before) ? before : null;
      const items = typed ? [...byName.values()].map(item => ({ value: `/estelle:${item.name}`, label: `/estelle:${item.name}`,
        description: item.description })).filter(item => item.value.startsWith(typed)) : [];
      return items.length ? { prefix: typed, items } : current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true };
}

/** The server entry this extension registers. Pure, so the test reads exactly what Pi is given. */
export function estelleServer(env = process.env) {
  const key = env.ESTELLE_API_KEY;
  // No key: Pi's own MCP OAuth signs in (`/mcp login Estelle`). An Authorization header would disable that.
  return { url: SERVER_URL, description: 'Estelle: repository evidence, shared memory, review, Rooms, monitoring and cloud sessions',
    exposure: 'deferred', toolExposure: Object.fromEntries(DIRECT_TOOLS.map(name => [name, 'direct'])),
    ...(key && !/[\r\n]/.test(key) ? { headers: { Authorization: `Bearer ${key}` } } : {}) };
}

/** Wire Estelle into one Pi extension runtime. `run` is injectable so tests drive the real handlers. */
export async function activate(pi, { env = process.env, run = runHook, commands, instructions } = {}) {
  let context = '';
  const warnings = new Map();
  const sessionOf = ctx => ({ session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    transcript_path: ctx.sessionManager.getSessionFile() ?? null });
  const hook = (event, ctx, extra = {}, timeoutMs) => run(HOST, { hook_event_name: event, ...sessionOf(ctx), ...extra },
    { env, ...(timeoutMs ? { timeoutMs } : {}) });
  const guide = instructions ?? await readInstructions();

  try { pi.registerMcpServer(SERVER_NAME, estelleServer(env)); }
  catch (error) { console.error(`Estelle could not register its MCP server with Pi: ${error.message}`); }

  // `/estelle:<name> words` becomes the command's prompt before Pi expands templates, the way a prompt template would:
  // the turn is the person's own, in every mode. A registered command's handler cannot start a turn that print and
  // JSON modes wait for (measured on 1.5.2: the process exits with the handler, or hangs if the handler waits).
  const byName = new Map((commands ?? await readCommands()).map(item => [item.name, item]));
  pi.on('input', async event => {
    const match = COMMAND.exec(typeof event.text === 'string' ? event.text.trim() : '');
    const item = match && byName.get(match[1]);
    if (!item) return { action: 'continue' };
    return { action: 'transform', text: item.template.replaceAll('$ARGUMENTS', (match[2] ?? '').trim()) };
  });

  // SessionStart fires on startup, /new, /resume, /fork and reload, so the identity line is restated after each.
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === 'function') ctx.ui.addAutocompleteProvider(current => completer(current, byName));
    const started = await hook('session_start', ctx);
    context = contextOf(started);
    const notice = warningOf(started);
    if (notice && ctx.hasUI) ctx.ui.notify(notice, 'warning');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    // Instructions and this session's identity live in the system prompt, so a compaction never drops them.
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === 'object') {
      sections.estelle = guide;
      if (context) sections.estelle_session = context;
    }
    if (event.messageType !== 'user' || typeof event.prompt !== 'string') return undefined;
    const text = contextOf(await hook('before_agent_start', ctx, { prompt: event.prompt }));
    // Recall travels as a session message the model reads; capture skips extension messages.
    return text ? { message: { customType: 'estelle-recall', content: text, display: false } } : undefined;
  });
  pi.on('tool_call', async (event, ctx) => {
    const warning = warningOf(await hook('tool_call', ctx, { tool_name: event.toolName, tool_input: event.input ?? {},
      tool_use_id: event.toolCallId }));
    if (!warning) return undefined;
    warnings.set(event.toolCallId, warning);
    if (warnings.size > MAX_TOOL_WARNINGS) warnings.delete(warnings.keys().next().value);
    if (ctx.hasUI) ctx.ui.notify(warning, 'warning');
    return undefined; // ⛔ A warning, never a block.
  });
  // Mail and room entries for this session arrive with the tool result the model is about to read.
  pi.on('tool_result', async (event, ctx) => {
    const output = (event.content ?? []).map(block => (block?.type === 'text' ? block.text : '')).join('\n').slice(0, 4_000);
    const text = contextOf(await hook('tool_result', ctx, { tool_name: event.toolName, tool_input: event.input ?? {},
      tool_use_id: event.toolCallId, tool_response: { output, is_error: event.isError === true } }));
    const warning = warnings.get(event.toolCallId);
    warnings.delete(event.toolCallId);
    const extra = [warning, text].filter(Boolean).join('\n\n');
    return extra ? { content: [...(event.content ?? []), { type: 'text', text: extra }] } : undefined;
  });
  pi.on('agent_settled', async (_event, ctx) => { await hook('agent_settled', ctx); });
  pi.on('session_before_compact', async (_event, ctx) => { await hook('session_before_compact', ctx); return undefined; });
  pi.on('session_shutdown', async (_event, ctx) => { await hook('session_shutdown', ctx, {}, END_TIMEOUT_MS); });
}

export default function estelle(pi) { return activate(pi); }
