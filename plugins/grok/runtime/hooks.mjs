import { join } from 'node:path';
import { mkdir, opendir, unlink, rename } from 'node:fs/promises';
import { normalize as claude, formatContext as claudeContext } from '../adapters/claude.mjs';
import { normalize as codex, formatContext as codexContext } from '../adapters/codex.mjs';
import { safeSession, hash, repository, readJson, writeJson, errorCode, recordStatus } from './io.mjs';
import { streamSession } from './stream.mjs';
import { ANNOUNCING_HOSTS, announceSubagent } from './subagent-hooks.mjs';
import { checkpointSession } from './checkpoint.mjs';
import { scrub } from './redact.mjs';
import { queueReindex } from './reindex.mjs';
import { timelineIdentity } from './identity.mjs';
import { mutatingTool, writeWarning } from './write-warning.mjs';
import { beginContext, saveContext, takeContext } from './queued-context.mjs';
import { updateNotice } from './update-check.mjs';
import { MAILBOX_HOSTS, pullAtBoundary, sessionIdentity } from './mailbox.mjs';
import { SUBAGENT_TEXT, SUPERVISED_HOSTS, SUPERVISE_BOUNDARY, subagentIdentity, subagentTask, superviseAtBoundary } from './supervise.mjs';

const CHECKPOINT_EVENTS = new Set(['Stop', 'SubagentStop', 'PreCompact', 'Interrupt']);
const STREAM_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Interrupt']);
const MAX_DEFERRED_SCAN = 512;

async function adapter(host) {
  if (host === 'claude-code') return { normalize: claude, formatContext: claudeContext };
  if (host === 'codex') return { normalize: codex, formatContext: codexContext };
  if (host === 'kimi') return import('../adapters/kimi.mjs');
  if (host === 'grok') return import('../adapters/grok.mjs');
  if (host === 'cursor') return import('../adapters/cursor.mjs');
  if (host === 'dsh') return import('../adapters/dsh.mjs');
  if (host === 'opencode') return import('../adapters/opencode.mjs');
  if (host === 'pi') return import('../adapters/pi.mjs');
  if (host === 'hermes') return import('../adapters/hermes.mjs');
  if (host === 'qwen-code') return import('../adapters/qwen.mjs');
  if (host === 'openclaw') return import('../adapters/openclaw.mjs');
  throw new Error('unsupported_host');
}

export async function deferSession(normalized, stateDir) {
  const { host, sessionId, cwd, transcriptPath, event } = normalized;
  if (!safeSession(sessionId)) throw new Error('session_missing');
  // Exit does no network or transcript read. Do not queue a prompt, tool result, or credential.
  await writeJson(join(stateDir, 'deferred', `${hash(`${host}:${sessionId}`)}.json`), {
    host, queuedAt: new Date().toISOString(),
    payload: { session_id: sessionId, cwd, transcript_path: transcriptPath || null, hook_event_name: event },
  });
}

export async function drainOne(stateDir, request) {
  let directory;
  try { directory = await opendir(join(stateDir, 'deferred')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let scanned = 0;
  const candidates = [];
  for await (const entry of directory) {
    if (++scanned > MAX_DEFERRED_SCAN) break;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    candidates.push(entry.name);
  }
  candidates.sort();
  const cursorPath = join(stateDir, 'deferred-cursor.json');
  const cursor = await readJson(cursorPath).catch(error => {
    if (error.code === 'ENOENT') return { last: '' };
    throw error;
  });
  const pivot = candidates.findIndex(name => name > cursor.last);
  const ordered = pivot < 0 ? candidates : [...candidates.slice(pivot), ...candidates.slice(0, pivot)];
  for (const name of ordered) {
    await writeJson(cursorPath, { last: name });
    const path = join(stateDir, 'deferred', name);
    const item = await readJson(path, 16_000);
    if (!['claude-code', 'codex', 'kimi', 'grok', 'cursor', 'dsh', 'opencode', 'pi', 'hermes', 'qwen-code', 'openclaw'].includes(item.host)) throw new Error('unsupported_host');
    const repo = repository(item.payload.cwd);
    const payload = { ...item.payload, hook_event_name: 'Stop' };
    if (item.host === 'kimi') {
      const port = await adapter(item.host);
      payload.transcript_path = await port.getTranscriptPath({ host: 'kimi', sessionId: payload.session_id, cwd: payload.cwd });
    }
    if (!payload.transcript_path) {
      // Preserve the reference for diagnosis without letting one unusable item starve the queue.
      await mkdir(join(stateDir, 'unavailable'), { recursive: true, mode: 0o700 });
      await rename(path, join(stateDir, 'unavailable', name));
      continue;
    }
    const [result, stream] = await Promise.all([
      checkpointSession({ payload, host: item.host, repo: repo?.name, stateDir, request }),
      streamSession({ payload, host: item.host, repo: repo?.name, stateDir, request }),
    ]);
    if (result.saved && !stream.pending && !stream.backlog) {
      if (stream.incomplete || stream.unsupported) {
        await mkdir(join(stateDir, 'partial'), { recursive: true, mode: 0o700 });
        await rename(path, join(stateDir, 'partial', name));
      } else await unlink(path);
    }
    return stream.association_partial ? { association_partial: true } : undefined;
  }
}

async function runAction(mode, normalized, stateDir, operation) {
  let result;
  let row;
  try {
    result = await operation();
    const skipped = result?.unsupported || result?.incomplete || result?.saved === false;
    row = result?.association_partial ? { status: 'partial', code: 'association_unverified' }
      : result?.degraded ? { status: 'partial', code: 'recall_degraded' }
      : { status: result?.pending ? 'pending' : result?.skipped ? 'skipped' : skipped ? 'partial' : 'ok' };
  } catch (error) {
    row = { status: 'failed', code: errorCode(error) };
    result = { failed: true, code: row.code };
  }
  try {
    await recordStatus(stateDir, { host: normalized.host, event: normalized.event, mode,
      ...row });
  } catch {
    // Recording an optional integration failure must never create another rejected action.
    console.error('Estelle could not save local hook status. Check the plugin data directory.');
    return { ...result, diagnostics_failed: true };
  }
  return result;
}

/** The per-prompt memory read. A subagent asks the same question with its task as the query and ITS OWN identity as the
    timeline session, so the read neither takes its parent's mail nor hands it its parent's token. */
async function recall(n, repo, request, { prompt = n.prompt, session = timelineIdentity(n.host, n.sessionId) } = {}) {
  const query = typeof prompt === 'string' ? scrub(prompt).trim().slice(0, 8_000) : '';
  // A prompt that was nothing but <private> spans asks Estelle nothing.
  if (!query || query === '[private]' || !repo) return { text: '', skipped: true };
  const body = { repo: repo.name, query, code: false, kinds: ['memory'], host: n.host, timeline_session: session };
  const result = await request('/search', body);
  if (typeof result.recall !== 'string') throw new Error('response_json');
  const degraded = result.degraded === true;
  const text = !result.recall.trim() && degraded
    ? 'Estelle recall is temporarily unavailable. Retry with estelle_resume or memory_chat.' : result.recall;
  return { text, degraded };
}

const START_TEXT = 'If Estelle MCP tools are available, call estelle_resume before planning and use their live schemas. '
  + 'A cloud session (start, run there, hand off, steer) is estelle_move; if unsure what Estelle can do, ask estelle_docs '
  + 'before saying you don\'t know. '
  + 'Use only this session’s verified Room identity; never invent or borrow a token. '
  + 'Check capture coverage before claiming a complete handoff.';

/** One host event, one process. Network failures are recorded separately from successful empty results. */
export async function handleHook({ host, payload, stateDir, request, update }) {
  const port = await adapter(host);
  const n = port.normalize(payload);
  if (!n.event) throw new Error('event_missing');
  if (!safeSession(n.sessionId)) throw new Error('session_missing');
  // `/estelle handoff` reads this to learn which session and conversation file it is in. Names and a path, no content.
  if (n.cwd && ['SessionStart', 'UserPromptSubmit'].includes(n.event)) {
    const { noteCurrentSession } = await import('./move.mjs');
    await noteCurrentSession(stateDir, { host, sessionId: n.sessionId, transcriptPath: n.transcriptPath, cwd: n.cwd }).catch(() => {});
  }
  const found = writeWarning(n);
  if (found?.unscanned) {
    await recordStatus(stateDir, { host, event: n.event, mode: 'protect', status: 'partial', code: 'input_bound' });
    return port.defaultOutput?.(payload.hook_event_name) ?? null;
  }
  // Only the real runner passes `update`; a bare call never reaches the network. Started now so it overlaps the hook's own work.
  const notice = update && n.event === 'SessionStart'
    ? updateNotice({ host, stateDir, ...update }).catch(() => null) : null;
  const output = await answerEvent({ host, port, n, payload, stateDir, request, notice });
  const shown = withUpdateNotice(host, output, await notice);
  return found ? withWarning(host, shown, found.warning) : shown;
}

/** The update line, in the one place each host shows its person. ⛔ It adds words and never a decision.
 *  Hosts without a verified channel get it through the start context instead (see answerEvent). */
function withUpdateNotice(host, output, line) {
  if (!line) return output;
  if (host === 'cursor') return { ...output, user_message: line };
  if (host === 'claude-code' || host === 'codex') return { ...output, systemMessage: line };
  if (host === 'pi') return { ...output, warning: line };
  if (host === 'kimi' || host === 'grok') console.error(line); // stderr is the only place they show a person anything at this event
  return output;
}

const UI_NOTICE_HOSTS = new Set(['claude-code', 'codex', 'cursor', 'pi']);

/** The warning added to whatever this event already answers. ⛔ It adds words and never a decision: no host is told to stop.
 *  Each host's own field, because each shows a different one. Stderr too, the only place Kimi has at this event. */
function withWarning(host, output, warning) {
  console.error(warning);
  if (host === 'kimi') return output;
  if (host === 'cursor') return { ...output, user_message: warning, agent_message: warning };
  // dsh, OpenCode, Pi and Hermes run Estelle from their own in-process plugin, which shows `warning` in the host's own way.
  if (['dsh', 'opencode', 'pi', 'hermes'].includes(host)) return { ...output, warning };
  const earlier = output?.hookSpecificOutput?.additionalContext;
  const additionalContext = earlier ? `${earlier}\n\n${warning}` : warning;
  if (host === 'grok') return { ...output, hookSpecificOutput: { ...output?.hookSpecificOutput, additionalContext } };
  return { ...output, systemMessage: warning, hookSpecificOutput: { ...output?.hookSpecificOutput, hookEventName: 'PreToolUse', additionalContext } };
}

async function answerEvent({ host, port, n, payload, stateDir, request, notice: updatePending }) {
  const defaultOutput = () => port.defaultOutput?.(payload.hook_event_name) ?? null;
  const queuedContext = host === 'grok' || host === 'cursor';
  const grokContextPath = join(stateDir, 'context', `${hash(`${host}:${n.sessionId}`)}.json`);
  let contextRequest;
  if (queuedContext && n.event === 'UserPromptSubmit') {
    contextRequest = await beginContext(grokContextPath, n.turnId);
  }
  if (n.event === 'SessionEnd' || n.event === 'Interrupt') {
    await deferSession(n, stateDir);
    return null;
  }
  if (host === 'kimi' && port.getTranscriptPath) n.transcriptPath = await port.getTranscriptPath(n);
  const streamPayload = { ...payload, session_id: n.sessionId, cwd: n.cwd,
    hook_event_name: n.event, transcript_path: n.transcriptPath || null };
  const repo = repository(n.cwd);
  // The prompt's recall goes on the wire FIRST (estelle#2272): the capture work below parses the transcript in this
  // same event loop, and started first it delayed the recall past its 8 s bound under load.
  const recalling = n.event === 'UserPromptSubmit' ? runAction('context', n, stateDir, () => recall(n, repo, request)) : undefined;
  if (recalling) await new Promise((resolve) => setImmediate(resolve));
  const actions = [];
  const edited = n.event === 'PostToolUse' && mutatingTool(n.toolName)
    && n.raw?.tool_response?.is_error !== true && n.raw?.tool_response?.success !== false;
  if (repo && (edited || ['Stop', 'SessionStart'].includes(n.event))) {
    actions.push(runAction('reindex', n, stateDir, () => queueReindex({ normalized: n, repo, stateDir, request })));
  }
  if (n.event === 'SessionStart') actions.push(runAction('deferred', n, stateDir, () => drainOne(stateDir, request)));
  // Session capture belongs to the authenticated account even before a workspace has Git metadata.
  if (STREAM_EVENTS.has(n.event)) actions.push(runAction('stream', n, stateDir,
    () => streamSession({ payload: streamPayload, host, repo: repo?.name, stateDir, request })));
  // A host that names its subagents in a hook but keeps no child transcript the plugin reads: the child's start and end.
  if (ANNOUNCING_HOSTS.has(host) && ['SubagentStart', 'SubagentStop'].includes(n.event)) actions.push(runAction('subagent', n, stateDir,
    () => announceSubagent({ n, host, repo: repo?.name, stateDir, request })));
  if (CHECKPOINT_EVENTS.has(n.event)) actions.push(runAction('checkpoint', n, stateDir,
    () => checkpointSession({ payload: streamPayload, host, repo: repo?.name, stateDir, request })));
  // This session's own identity (id + session_token) and its mail, for hosts the server can address.
  const mailbox = MAILBOX_HOSTS.has(host);
  const subagent = n.event === 'SubagentStart' && Boolean(n.agentId);
  const identity = mailbox && ['SessionStart', 'SubagentStart'].includes(n.event)
    ? runAction('identity', n, stateDir, () => sessionIdentity(n, request)) : undefined;
  // The same memory read the main agent gets at each prompt, over the subagent's task: it is the subagent's "first prompt".
  const inherited = subagent && SUPERVISED_HOSTS.has(host) ? runAction('context', n, stateDir, async () => {
    const task = await subagentTask(n);
    return task ? recall(n, repo, request, { prompt: task, session: subagentIdentity(n) }) : { text: '', skipped: true };
  }) : undefined;
  // What this parent's subagents need it to know (one cheap ask, bounded, silent on failure).
  const watch = SUPERVISED_HOSTS.has(host) && SUPERVISE_BOUNDARY[n.event] && !n.agentId
    ? runAction('supervise', n, stateDir, () => superviseAtBoundary(n, stateDir, request)) : undefined;
  const boundary = !mailbox ? '' : n.event === 'SessionStart' ? 'start'
    : n.event === 'PostToolUse' && !n.agentId ? 'tool' : '';
  const mail = boundary ? runAction('mailbox', n, stateDir, () => pullAtBoundary(n, stateDir, request, boundary)) : undefined;
  // Attach handlers before awaiting recall: other operations can finish while it is in flight.
  const completedActions = Promise.allSettled(actions);
  const context = recalling ? await recalling : undefined;
  await completedActions;
  const [own, delivered, watched, memory] = await Promise.all([identity, mail, watch, inherited]);
  const notice = watched?.text || '';
  const updateLine = updatePending && !UI_NOTICE_HOSTS.has(host) ? await updatePending : null;
  const extra = [own?.text, delivered?.text, memory?.text, ...(n.event === 'Stop' ? [] : [notice]),
    updateLine && `Estelle plugin update: tell the person this once, in your first reply. ${updateLine}`]
    .filter(text => typeof text === 'string' && text.trim()).join('\n\n');
  // A Stop hook cannot add model context without blocking the stop; the person sees this line, and the next prompt's
  // check names whatever is still running.
  if (n.event === 'Stop' && notice) return { systemMessage: notice };
  if (context?.failed) return port.formatContext(`Estelle recall was not obtained (${context.code}). Use its MCP tools directly; this is not an empty search result.${notice ? `\n\n${notice}` : ''}`, n.event) ?? defaultOutput();
  if (context?.text && queuedContext) {
    const saved = await saveContext(grokContextPath, n.turnId, contextRequest, context.text, context.degraded);
    await recordStatus(stateDir, { host, event: n.event, mode: 'context',
      ...(context.degraded ? { status: 'partial', code: 'recall_degraded', pending: saved }
        : { status: saved ? 'pending' : 'skipped' }) });
    return defaultOutput();
  }
  const contextBoundary = host === 'grok' && n.event === 'PreToolUse'
    || host === 'cursor' && ['PostToolUse', 'PostToolUseFailure'].includes(n.event);
  if (contextBoundary) {
    const queued = await takeContext(grokContextPath, n.turnId);
    if (queued) {
      await recordStatus(stateDir, { host, event: n.event, mode: 'context',
        ...(queued.degraded ? { status: 'partial', code: 'recall_degraded', pending: false } : { status: 'emitted' }) });
      // Mail pulled at this same boundary rides with the queued recall: the server has already handed it over, so dropping it would lose it.
      return port.formatContext(extra ? `${queued.text}\n\n${extra}` : queued.text, n.event);
    }
  }
  if (context?.text) return port.formatContext(notice ? `${context.text}\n\n${notice}` : context.text, n.event);
  if (n.event === 'SessionStart' || n.event === 'SubagentStart') {
    const guidance = n.event === 'SubagentStart' && n.agentId && SUPERVISED_HOSTS.has(host) ? `${START_TEXT}\n\n${SUBAGENT_TEXT}` : START_TEXT;
    return port.formatContext(extra ? `${guidance}\n\n${extra}` : guidance, n.event) ?? defaultOutput();
  }
  if (extra) return port.formatContext(extra, n.event) ?? defaultOutput();
  return defaultOutput();
}
