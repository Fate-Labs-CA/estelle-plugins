import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, opendir, unlink, rename } from 'node:fs/promises';
import { normalize as claude, formatContext as claudeContext } from '../adapters/claude.mjs';
import { normalize as codex, formatContext as codexContext } from '../adapters/codex.mjs';
import { safeSession, hash, repository, readJson, writeJson, errorCode, recordStatus } from './io.mjs';
import { streamSession } from './stream.mjs';
import { checkpointSession } from './checkpoint.mjs';
import { redact } from './redact.mjs';
import { queueReindex } from './reindex.mjs';
import { timelineIdentity } from './identity.mjs';
import { mutatingTool, writeWarning } from './write-warning.mjs';
import { beginContext, saveContext, takeContext } from './queued-context.mjs';

const CHECKPOINT_EVENTS = new Set(['Stop', 'SubagentStop', 'PreCompact', 'Interrupt']);
const STREAM_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStop', 'PreCompact', 'Interrupt']);
const MAX_DEFERRED_SCAN = 512;

async function adapter(host) {
  if (host === 'claude-code') return { normalize: claude, formatContext: claudeContext };
  if (host === 'codex') return { normalize: codex, formatContext: codexContext };
  if (host === 'kimi') return import('../adapters/kimi.mjs');
  if (host === 'grok') return import('../adapters/grok.mjs');
  if (host === 'cursor') return import('../adapters/cursor.mjs');
  if (host === 'dsh') return import('../adapters/dsh.mjs');
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

export async function drainOne(stateDir, request, { captureOnly = false } = {}) {
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
    if (!['claude-code', 'codex', 'kimi', 'grok', 'cursor', 'dsh'].includes(item.host)) throw new Error('unsupported_host');
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
      captureOnly ? null : checkpointSession({ payload, host: item.host, repo: repo?.name, stateDir, request }),
      streamSession({ payload, host: item.host, repo: repo?.name, stateDir, request }),
    ]);
    if ((captureOnly || result.saved) && !stream.pending && !stream.backlog) {
      if (stream.incomplete || stream.unsupported) {
        await mkdir(join(stateDir, 'partial'), { recursive: true, mode: 0o700 });
        await rename(path, join(stateDir, 'partial', name));
      } else await unlink(path);
    }
    if (captureOnly) return { incomplete: stream.incomplete, unsupported: stream.unsupported,
      pending: stream.pending || stream.backlog, association_partial: stream.association_partial };
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

async function recall(n, repo, request) {
  const query = typeof n.prompt === 'string' ? n.prompt.trim().slice(0, 8_000) : '';
  if (!query || !repo) return { text: '', skipped: true };
  const body = { repo: repo.name, query: redact(query), code: false, host: n.host,
    timeline_session: timelineIdentity(n.host, n.sessionId) };
  const result = await request('/search', body);
  if (typeof result.recall !== 'string') throw new Error('response_json');
  const degraded = result.degraded === true;
  const text = !result.recall.trim() && degraded
    ? 'Estelle recall is temporarily unavailable. Retry with estelle_resume or memory_chat.' : result.recall;
  return { text, degraded };
}

const START_TEXT = 'If Estelle MCP tools are available, call estelle_resume before planning and use their live schemas. '
  + 'Use only this session’s verified Room identity; never invent or borrow a token. '
  + 'Check capture coverage before claiming a complete handoff.';

/** One host event, one process. Network failures are recorded separately from successful empty results. */
export async function handleHook({ host, payload, stateDir, request, captureOnly = false, requestContext }) {
  const port = await adapter(host);
  const n = port.normalize(payload);
  if (!n.event) throw new Error('event_missing');
  if (!safeSession(n.sessionId)) throw new Error('session_missing');
  // A capture-only sign-in swaps the state directory and the one route this hook may call. A credential storage
  // outage must never cost the write warning, which needs neither: the warning is still given, the capture is not.
  let authFailure;
  let signedOut = false;
  try {
    const authContext = requestContext ? await requestContext() : null;
    if (authContext?.signedOut) signedOut = true;
    else if (authContext) ({ stateDir, request, captureOnly } = authContext);
  } catch (error) { authFailure = error; }
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
  if (authFailure) {
    await recordStatus(stateDir, { host, event: n.event, mode: 'capture', status: 'failed', code: errorCode(authFailure) }).catch(() => {});
    if (found) return withWarning(host, port.defaultOutput?.(payload.hook_event_name) ?? null, found.warning);
    const told = await tellOnce({ host, port, n, stateDir, notice: stoppedNotice(host, errorCode(authFailure)) });
    if (told) return told;
    if (n.event === 'SessionStart') return port.formatContext(START_TEXT, n.event) ?? port.defaultOutput?.(payload.hook_event_name) ?? null;
    throw authFailure;
  }
  const output = await answerEvent({ host, port, n, payload, stateDir, request, captureOnly });
  if (found) return withWarning(host, output, found.warning);
  return signedOut && n.event === 'SessionStart' ? { ...output, systemMessage: SIGN_IN_NOTICE } : output;
}

const SIGN_IN_NOTICE = 'Estelle is not recording this session. Run /estelle:login once to sign in.';
const TELLING_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

function stoppedNotice(host, code) {
  const fix = host === 'claude-code' ? 'run /estelle:login'
    : `run: node "${fileURLToPath(new URL('./cli.mjs', import.meta.url))}" setup ${host} --login`;
  return `Estelle is not recording this session: its sign-in stopped working (${code}). To sign in again, ${fix}`;
}

/** A broken sign-in otherwise looks exactly like a session being recorded. Once per session, at the first event this host
 *  can carry words on, which is not the same event on every host. ``null`` when this event cannot, or it was already said. */
async function tellOnce({ host, port, n, stateDir, notice }) {
  if (!TELLING_EVENTS.has(n.event)) return null;
  const marker = join(stateDir, 'capture-notice', `${hash(`${host}:${n.sessionId}`)}.json`);
  if (await readJson(marker).then(() => true, () => false)) return null;
  const output = port.formatContext(n.event === 'SessionStart' ? `${START_TEXT}\n\n${notice}` : notice, n.event);
  if (!output) return null;
  await writeJson(marker, { told: true }).catch(() => {});
  console.error(notice);
  return host === 'claude-code' || host === 'codex' ? { ...output, systemMessage: notice } : output;
}

/** The warning added to whatever this event already answers. ⛔ It adds words and never a decision: no host is told to stop.
 *  Each host's own field, because each shows a different one. Stderr too, the only place Kimi has at this event. */
function withWarning(host, output, warning) {
  console.error(warning);
  if (host === 'kimi') return output;
  if (host === 'cursor') return { ...output, user_message: warning, agent_message: warning };
  if (host === 'dsh') return { ...output, warning };
  const earlier = output?.hookSpecificOutput?.additionalContext;
  const additionalContext = earlier ? `${earlier}\n\n${warning}` : warning;
  if (host === 'grok') return { ...output, hookSpecificOutput: { ...output?.hookSpecificOutput, additionalContext } };
  return { ...output, systemMessage: warning, hookSpecificOutput: { ...output?.hookSpecificOutput, hookEventName: 'PreToolUse', additionalContext } };
}

async function answerEvent({ host, port, n, payload, stateDir, request, captureOnly }) {
  const defaultOutput = () => port.defaultOutput?.(payload.hook_event_name) ?? null;
  const queuedContext = !captureOnly && (host === 'grok' || host === 'cursor');
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
  const actions = [];
  const edited = n.event === 'PostToolUse' && mutatingTool(n.toolName)
    && n.raw?.tool_response?.is_error !== true && n.raw?.tool_response?.success !== false;
  if (!captureOnly && repo && (edited || ['Stop', 'SessionStart'].includes(n.event))) {
    actions.push(runAction('reindex', n, stateDir, () => queueReindex({ normalized: n, repo, stateDir, request })));
  }
  if (n.event === 'SessionStart') actions.push(runAction('deferred', n, stateDir, () => drainOne(stateDir, request, { captureOnly })));
  // Session capture belongs to the authenticated account even before a workspace has Git metadata.
  if (STREAM_EVENTS.has(n.event)) actions.push(runAction('stream', n, stateDir,
    () => streamSession({ payload: streamPayload, host, repo: repo?.name, stateDir, request })));
  if (!captureOnly && CHECKPOINT_EVENTS.has(n.event)) actions.push(runAction('checkpoint', n, stateDir,
    () => checkpointSession({ payload: streamPayload, host, repo: repo?.name, stateDir, request })));
  // Attach handlers before awaiting recall: other operations can finish while it is in flight.
  const completedActions = Promise.allSettled(actions);
  let context;
  if (!captureOnly && n.event === 'UserPromptSubmit') {
    context = await runAction('context', n, stateDir, () => recall(n, repo, request));
  }
  await completedActions;
  if (context?.failed) return port.formatContext(`Estelle recall was not obtained (${context.code}). Use its MCP tools directly; this is not an empty search result.`, n.event) ?? defaultOutput();
  if (context?.text && queuedContext) {
    const saved = await saveContext(grokContextPath, n.turnId, contextRequest, context.text, context.degraded);
    await recordStatus(stateDir, { host, event: n.event, mode: 'context',
      ...(context.degraded ? { status: 'partial', code: 'recall_degraded', pending: saved }
        : { status: saved ? 'pending' : 'skipped' }) });
    return defaultOutput();
  }
  const contextBoundary = host === 'grok' && n.event === 'PreToolUse'
    || host === 'cursor' && ['PostToolUse', 'PostToolUseFailure'].includes(n.event);
  if (!captureOnly && contextBoundary) {
    const queued = await takeContext(grokContextPath, n.turnId);
    if (queued) {
      await recordStatus(stateDir, { host, event: n.event, mode: 'context',
        ...(queued.degraded ? { status: 'partial', code: 'recall_degraded', pending: false } : { status: 'emitted' }) });
      return port.formatContext(queued.text, n.event);
    }
  }
  if (context?.text) return port.formatContext(context.text, n.event);
  if (n.event === 'SessionStart' || n.event === 'SubagentStart') return port.formatContext(START_TEXT, n.event) ?? defaultOutput();
  return defaultOutput();
}
