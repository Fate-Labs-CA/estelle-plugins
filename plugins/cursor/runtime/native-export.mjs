import { nativeGit, indexState, indexSpelling } from './native-index.mjs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { git, repository, apiClient, errorCode } from './io.mjs';
import { redact, isSensitiveField } from './redact.mjs';

const MAX_BYTES = 512 * 1024;
const MAX_FILES = 40;
const MAX_SCALAR_CHARS = 8192;
// A long tool result is normal. A long string is scanned in overlapping windows and refused if a credential is found,
// matching the server's native_session_restore, whose scanner is quadratic on an unbroken run.
const SCAN_OVERLAP_CHARS = 1024;
const PRIVATE_TYPES = new Set(['thinking', 'redacted_thinking', 'reasoning', 'agent_reasoning', 'agent_reasoning_raw_content']);
const PRIVATE_KEYS = new Set(['thinking', 'reasoning', 'reasoning_content', 'encrypted_content']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RESERVED = new Set(['.git', '.env', '.claude', '.codex', '.kimi', '.kimi-code', '.estelle', '.estelle-plugins',
  'stress_accounts.json', 'estelle_accounts.json', 'estelle_experience.json']);
const digest = text => createHash('sha256').update(text).digest('hex');
const SAFE_CODES = new Set(['native_public_repository', 'native_artifact_bound', 'native_artifact_changed', 'native_artifact_shape',
  'native_selection', 'native_repository', 'native_private_reasoning_unsupported', 'native_credential_field',
  'native_consent_required', 'native_staged_changes_unsupported', 'native_untracked_changes_unsupported',
  'native_tree_transport_unsupported', 'native_untracked_selection_required', 'native_restore_unverified', 'native_index_state_unsupported',
  'native_receipt_mismatch', 'native_scalar_bound', 'native_reserved_path', 'native_source_credential_or_binary', 'native_file_mode_unsupported', 'native_arguments']);
export const nativeErrorCode = error => SAFE_CODES.has(error?.message) ? error.message : errorCode(error);
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function readNativeBytes(path, limit = MAX_BYTES, expected = null) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (expected && (info.ino !== expected.ino || info.dev !== expected.dev)) throw new Error('native_artifact_changed');
    if (!info.isFile() || info.size > limit) throw new Error('native_artifact_bound');
    const bytes = Buffer.alloc(info.size + 1);
    const out = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (out.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('native_artifact_changed');
    return bytes.subarray(0, out.bytesRead);
  } finally { await handle.close(); }
}
async function readExact(path, limit = MAX_BYTES, expected = null) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readNativeBytes(path, limit, expected));
}
export const NATIVE_LIMITS = Object.freeze({ bytes: MAX_BYTES, files: MAX_FILES, blobBytes: 8192 });
export function checkNativeRelativePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path.split('/').length > 32
      || path.split('/').some(part => !part || part === '.' || part === '..' || RESERVED.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env.'))
      || /[\x00-\x1f\\]/.test(path)) throw new Error('native_reserved_path');
  return path;
}

function nativeUsage(key, value) {
  const counter = name => /^(?:(?:input|output|total|reasoning|cached|cached_input|reasoning_output|cache_write_input|cache_creation_input|cache_read_input)_tokens|max_tokens|token_count)$/.test(name);
  // A count under a `token` name (Claude's ephemeral_5m_input_tokens, whatever comes next) is not a credential.
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && (counter(key) || /tokens?$/i.test(key));
  const envelope = /(?:token_usage|tokens_details)$/.test(key);
  return envelope && value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(count => typeof count === 'number' && Number.isFinite(count) && count >= 0);
}

function withoutReasoning(value, depth = 0) {
  if (depth > 16) throw new Error('native_artifact_shape');
  if (Array.isArray(value)) return value.filter(item => !PRIVATE_TYPES.has(item?.type)).map(item => withoutReasoning(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key))
    .map(([key, item]) => [key, withoutReasoning(item, depth + 1)]));
}

function scrubString(text) {
  if (text.length <= MAX_SCALAR_CHARS) return redact(text);
  for (let start = 0; start < text.length; start += MAX_SCALAR_CHARS - SCAN_OVERLAP_CHARS) {
    const window = text.slice(start, start + MAX_SCALAR_CHARS);
    if (redact(window) !== window) throw new Error('native_credential_field');
  }
  return text;
}

function scrubJsonl(text, harness, sessionId) {
  const parsed = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (parsed.length > 4000) throw new Error('native_artifact_bound');
  if (!parsed.length || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('native_artifact_shape');
  // Private reasoning never leaves this machine, and neither host needs an old turn's to continue.
  const rows = parsed.filter(row => !PRIVATE_TYPES.has(row?.payload?.type)).map(row => withoutReasoning(row));
  if (harness === 'claude-code' && rows.some(row => row.sessionId !== sessionId)) throw new Error('native_selection');
  if (harness === 'codex' && (rows[0].type !== 'session_meta' || rows[0].payload?.id !== sessionId)) throw new Error('native_selection');
  let fields = 0;
  const pending = rows.map(value => ({ value, depth: 0 }));
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (!value || typeof value !== 'object' || depth > 16) throw new Error('native_artifact_shape');
    for (const key of Object.keys(value)) {
      if (++fields > 40_000) throw new Error('native_artifact_bound');
      const usage = nativeUsage(key, value[key]);
      if (!usage && (isSensitiveField(key) || /^authorization$/i.test(key))) throw new Error('native_credential_field');
      if (typeof value[key] === 'string') value[key] = scrubString(value[key]);
      else if (value[key] && typeof value[key] === 'object') pending.push({ value: value[key], depth: depth + 1 });
    }
  }
  return rows.map(value => JSON.stringify(value)).join('\n') + '\n';
}

export async function captureNativeTranscript({ harness, sessionId, transcriptPath, home = homedir() }) {
  if (!['claude-code', 'codex'].includes(harness) || !UUID.test(sessionId || '')) throw new Error('native_selection');
  const root = resolve(home, harness === 'codex' ? '.codex/sessions' : '.claude/projects');
  const source = resolve(transcriptPath);
  const sourceInfo = await lstat(source);
  if (!inside(root, source) || sourceInfo.isSymbolicLink() || !inside(await realpath(root), await realpath(source))) throw new Error('native_reserved_path');
  if (!basename(source).endsWith(`${sessionId}.jsonl`)) throw new Error('native_selection');
  return scrubJsonl(await readExact(source, MAX_BYTES, sourceInfo), harness, sessionId);
}

export async function prepareContinuation({ harness, sessionId, transcriptPath, cwd, siloId, home = homedir(), consent, replace }) {
  if (consent !== true || replace !== true) throw new Error('native_consent_required');
  if (!['claude-code', 'codex'].includes(harness) || !UUID.test(sessionId || '') || !siloId) throw new Error('native_selection');
  const repo = repository(cwd);
  if (!repo) throw new Error('native_repository');
  const run = nativeGit(repo.root);
  const indexBefore = indexState(run);
  const canonicalRoot = await realpath(repo.root);
  await indexSpelling(canonicalRoot, indexBefore);
  const baseCommit = run(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error('native_repository');
  // This first transport refuses states it cannot preserve rather than turning staged work into
  // unstaged work or silently dropping deletes. Untracked files require a later explicit picker.
  if (run(['diff', '--cached', '--name-only', '-z'], { raw: true })) throw new Error('native_staged_changes_unsupported');
  if (run(['ls-files', '--others', '--exclude-standard', '-z'], { raw: true })) throw new Error('native_untracked_changes_unsupported');
  const paths = run(['diff', '--name-only', '-z', 'HEAD', '--'], { raw: true }).split('\0').filter(Boolean);
  if (paths.length > MAX_FILES) throw new Error('native_artifact_bound');
  const files = [];
  const observed = [];
  for (const path of paths) {
    checkNativeRelativePath(path);
    const full = resolve(repo.root, path);
    const info = await lstat(full); // Deletion or symlink is a refusal, never an empty file.
    const canonical = await realpath(full);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o111
        || !inside(await realpath(repo.root), canonical)
        || canonical !== resolve(await realpath(repo.root), path)) throw new Error('native_reserved_path');
    const baseMode = run(['ls-tree', 'HEAD', '--', path], { raw: true }).split(' ')[0];
    if (baseMode !== '100644') throw new Error('native_file_mode_unsupported');
    const text = await readExact(full, MAX_BYTES, info);
    if (Array.from(text).length > MAX_SCALAR_CHARS) throw new Error('native_scalar_bound');
    if (text.includes('\0') || redact(text) !== text) throw new Error('native_source_credential_or_binary');
    files.push({ path, text, sha256: digest(text) });
    observed.push({ full, info });
  }
  const transcript = await captureNativeTranscript({ harness, sessionId, transcriptPath, home });
  if (run(['diff', '--cached', '--name-only', '-z'], { raw: true }) || run(['ls-files', '--others', '--exclude-standard', '-z'], { raw: true })) throw new Error('native_artifact_changed');
  if (run(['rev-parse', 'HEAD']) !== baseCommit || run(['diff', '--name-only', '-z', 'HEAD', '--'], { raw: true }).split('\0').filter(Boolean).join('\0') !== paths.join('\0')) throw new Error('native_artifact_changed');
  for (const { full, info } of observed) {
    const current = await lstat(full);
    if (current.ino !== info.ino || current.dev !== info.dev || current.mode !== info.mode
        || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error('native_artifact_changed');
  }
  await indexSpelling(canonicalRoot, indexBefore);
  if (JSON.stringify(indexBefore) !== JSON.stringify(indexState(run))) throw new Error('native_artifact_changed');
  const body = { action: 'restore_native', silo_id: siloId, native: {
    consent: true, replace: true, harness, session_id: sessionId, base_commit: baseCommit, transcript, files,
  } };
  if (Buffer.byteLength(transcript) + files.reduce((n, file) => n + Buffer.byteLength(file.text), 0) > MAX_BYTES) throw new Error('native_artifact_bound');
  return body;
}

export async function continueCloud(options, request = apiClient({ timeoutMs: 80_000, deadline: Date.now() + 80_000 })) {
  if (options.consent !== true || options.replace !== true) throw new Error('native_consent_required');
  const body = await prepareContinuation(options);
  const result = await request('/ade', body);
  return { silo_id: result.silo_id, session_id: result.session_id, harness: result.harness,
    native_command_started: result.native_command_started === true,
    artifacts_verified: result.artifacts_verified === true, safe_to_close_laptop: false,
    note: 'Native import requested. Authentication, context readiness and local/cloud handover still need verification.' };
}

export async function runNativeContinue(args, { isPublic } = {}) {
  const names = { '--harness': 'harness', '--session': 'sessionId', '--transcript': 'transcriptPath', '--repo': 'cwd', '--silo': 'siloId' };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--consent') options.consent = true;
    else if (args[i] === '--replace') options.replace = true;
    else if (args[i] === '--preserve-tree') options.preserveTree = true;
    else if (args[i] === '--untracked' && args[i + 1]) {
      options.selectedUntracked ||= []; options.selectedUntracked.push(args[++i]);
    }
    else if (names[args[i]] && args[i + 1]) {
      const name = names[args[i]];
      options[name] = args[++i];
    }
    else throw new Error('native_arguments');
  }
  // 🔴 This carries files to a box, and a box pushes what it finds. A public repository, or one nobody could read, gets none (`move.mjs`).
  const repo = repository(options.cwd);
  if (repo) {
    const ask = isPublic ?? (await import('./move.mjs')).isPublicRepo;
    if (await ask(repo.name) !== false) throw new Error('native_public_repository');
  }
  if (options.preserveTree) return (await import('./native-tree.mjs')).continueTreeCloud(options);
  if (options.selectedUntracked) throw new Error('native_arguments');
  return continueCloud(options);
}
