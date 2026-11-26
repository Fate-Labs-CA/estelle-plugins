// A session's own identity at SessionStart, and its mail at its next tool call.
//
// Identity: Estelle's server hands this session its id and session_token (POST /session/mail {action: identity})
// and the hook prints that line into the model's context. Before this, the token arrived only once, inside the
// first prompt's recall, so a compaction erased it and the session could not prove itself in a room or as a
// mail sender. SessionStart fires again on resume, clear and compact, so the line is restated each time.
//
// Tool boundary: at PostToolUse the hook pulls this session's pending mail and room entries
// (POST /session/mail {action: deliver, boundary: tool}), so a running session sees a message at its next
// tool call instead of waiting for its person's next prompt. Bounded: at most one pull per
// TOOL_PULL_INTERVAL_MS per session, and never from a subagent's tool call (the mail is the main
// conversation's; a subagent shares its session id).
import { join } from 'node:path';
import { hash, readJson, writeJson } from './io.mjs';
import { timelineIdentity } from './identity.mjs';
import { subagentIdentity } from './supervise.mjs';

// Hosts whose sessions the server can mail (its live list) and whose hook output carries additionalContext.
// OpenCode, Pi and OpenClaw carry the text through their in-process plugin (adapters/opencode-plugin.mjs, adapters/pi-extension.mjs,
// adapters/openclaw-plugin.mjs); the server must list every host here as a local one too (estelle api_session_mail.py
// EXTERNAL_ORIGINS), or identity is refused and only the start text is printed.
// Cursor and Qwen Code print the tool-boundary pull as additionalContext at PostToolUse (both hosts document it); the
// OpenClaw plugin queues it for its next before_prompt_build. Not listed, with the reason: Grok (stdout ignored for passive
// events), Kimi (PostToolUse stdout not specified), Hermes 0.19 (post_tool_call return is ignored), dsh (no tool-result hook).
export const MAILBOX_HOSTS = new Set(['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'qwen-code', 'openclaw']);
export const TOOL_PULL_INTERVAL_MS = 10_000;
// Characters of delivered text one hook output carries; the server already bounds a delivery well below this.
const MAX_CONTEXT_CHARS = 12_000;

const textOf = result => (typeof result?.context === 'string' ? result.context.slice(0, MAX_CONTEXT_CHARS) : '');

/** This session's id and token, as the line to print. '' when the server issued none. A SUBAGENT shares its parent's session
    id, so it asks for its own (`subagentIdentity`): handing it the parent's line would let it speak as the parent. */
export async function sessionIdentity(n, request) {
  const own = n.event === 'SubagentStart' ? subagentIdentity(n) : '';
  const result = await request('/session/mail', { action: 'identity', session_id: own || timelineIdentity(n.host, n.sessionId) });
  return { text: textOf(result) };
}

/** Pending mail and room entries at a boundary ('start' or 'tool'). A tool pull is throttled per session. */
export async function pullAtBoundary(n, stateDir, request, boundary, now = Date.now()) {
  if (boundary === 'tool') {
    const path = join(stateDir, 'mailbox', `${hash(`${n.host}:${n.sessionId}`)}.json`);
    const last = await readJson(path).catch(() => null);
    if (last && typeof last.at === 'number' && now - last.at >= 0 && now - last.at < TOOL_PULL_INTERVAL_MS) {
      return { text: '', skipped: true };
    }
    await writeJson(path, { at: now });
  }
  const result = await request('/session/mail', { action: 'deliver', session_id: timelineIdentity(n.host, n.sessionId),
    boundary });
  return { text: textOf(result) };
}
