import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { repository, apiClient } from './io.mjs';
import { nativeGit, indexState, indexSpelling } from './native-index.mjs';
import { redact } from './redact.mjs';
import { NATIVE_LIMITS, checkNativeRelativePath, readNativeBytes, captureNativeTranscript } from './native-export.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = text => text.split('\0').filter(Boolean);
const fingerprint = info => info ? [info.dev, info.ino, info.mode, info.size, info.mtimeMs].join(':') : 'absent';
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

async function worktreeFile(root, path) {
  let full = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    full = resolve(full, parts[i]);
    let info;
    try { info = await lstat(full); }
    catch (error) { if (error.code === 'ENOENT') return { info: null, blob: null }; throw error; }
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) throw new Error('native_reserved_path');
    if (i === parts.length - 1 && !info.isFile()) throw new Error('native_file_mode_unsupported');
  }
  const canonical = await realpath(full);
  if (!inside(root, canonical) || canonical !== full) throw new Error('native_reserved_path');
  const info = await lstat(full);
  const bytes = await readNativeBytes(full, NATIVE_LIMITS.blobBytes, info);
  return { info, blob: blob(bytes, info.mode & 0o111 ? '100755' : '100644') };
}

function blob(bytes, mode) {
  if (bytes.length > NATIVE_LIMITS.blobBytes) throw new Error('native_artifact_bound');
  const text = bytes.toString('utf8').replaceAll('\0', '');
  if (redact(text) !== text || text.toLowerCase().replace(/[_-]/g, '').includes('sessiontoken')) throw new Error('native_source_credential_or_binary');
  return { mode, base64: bytes.toString('base64'), sha256: sha(bytes) };
}

function indexFile(run, path) {
  const raw = run(['ls-files', '--stage', '-z', '--', path], { raw: true });
  if (!raw) return { raw, blob: null };
  const rows = paths(raw);
  const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(rows[0]);
  if (rows.length !== 1 || !match || match[3] !== path) throw new Error('native_file_mode_unsupported');
  const sizeText = run(['cat-file', '-s', match[2]]);
  const size = Number(sizeText);
  if (!/^[0-9]+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || size > NATIVE_LIMITS.blobBytes) throw new Error('native_artifact_bound');
  const bytes = run(['cat-file', 'blob', match[2]], { bytes: true });
  return { raw, blob: blob(bytes, match[1]) };
}

function state(run) {
  return { index: indexState(run), head: run(['rev-parse', 'HEAD']),
    dirty: run(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], { raw: true }),
    staged: run(['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--'], { raw: true }),
    untracked: run(['ls-files', '--others', '--exclude-standard', '-z'], { raw: true }) };
}

export async function captureTree({ cwd, selectedUntracked = [] }) {
  const repo = repository(cwd);
  if (!repo) throw new Error('native_repository');
  const root = await realpath(repo.root);
  const run = nativeGit(repo.root);
  const before = state(run);
  await indexSpelling(root, before.index);
  if (!/^[a-f0-9]{40}$/.test(before.head)) throw new Error('native_repository');
  const untracked = paths(before.untracked).sort();
  if (!Array.isArray(selectedUntracked) || selectedUntracked.some(path => typeof path !== 'string')
      || [...new Set(selectedUntracked)].sort().join('\0') !== untracked.join('\0')) throw new Error('native_untracked_selection_required');
  const names = [...new Set([...paths(before.dirty), ...paths(before.staged), ...untracked])].sort();
  if (names.length > NATIVE_LIMITS.files) throw new Error('native_artifact_bound');
  names.forEach(checkNativeRelativePath);
  if (names.some((path, i) => names.some((other, j) => i !== j && other.startsWith(path + '/')))) throw new Error('native_reserved_path');
  const tree = [], observed = [];
  let total = 0;
  for (const path of names) {
    const index = indexFile(run, path), worktree = await worktreeFile(root, path);
    const entry = { path, index: index.blob, worktree: worktree.blob };
    total += [entry.index, entry.worktree].reduce((n, value) => n + (value ? Buffer.from(value.base64, 'base64').length : 0), 0);
    if (total > NATIVE_LIMITS.bytes) throw new Error('native_artifact_bound');
    tree.push(entry); observed.push({ path, index: index.raw, worktree });
  }
  const after = state(run);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('native_artifact_changed');
  for (const row of observed) {
    const current = await worktreeFile(root, row.path);
    if (indexFile(run, row.path).raw !== row.index || fingerprint(current.info) !== fingerprint(row.worktree.info)
        || current.blob?.sha256 !== row.worktree.blob?.sha256) throw new Error('native_artifact_changed');
  }
  await indexSpelling(root, before.index);
  if (JSON.stringify(before) !== JSON.stringify(state(run))) throw new Error('native_artifact_changed');
  return { repo: repo.name, baseCommit: before.head, tree, bytes: total };
}

export async function prepareTreeContinuation(options) {
  if (options.consent !== true || options.replace !== true) throw new Error('native_consent_required');
  if (!options.siloId) throw new Error('native_selection');
  const captured = await captureTree(options);
  const transcript = await captureNativeTranscript(options);
  if (captured.bytes + Buffer.byteLength(transcript) > NATIVE_LIMITS.bytes) throw new Error('native_artifact_bound');
  return { action: 'restore_native', silo_id: options.siloId, native: { consent: true, replace: true,
    harness: options.harness, session_id: options.sessionId, base_commit: captured.baseCommit, transcript,
    tree: captured.tree } };
}

export async function continueTreeCloud(options, request = apiClient({ timeoutMs: 80_000, deadline: Date.now() + 80_000 })) {
  if (options.consent !== true || options.replace !== true) throw new Error('native_consent_required');
  const capabilities = await request('/ade', { action: 'native_capabilities' });
  if (capabilities.transport_version !== 2 || capabilities.tree_snapshot !== true) throw new Error('native_tree_transport_unsupported');
  const body = await prepareTreeContinuation(options);
  const result = await request('/ade', body);
  if (result.tree_snapshot_applied !== true || result.artifacts_verified !== true) throw new Error('native_restore_unverified');
  if (result.silo_id !== options.siloId || result.session_id !== options.sessionId || result.harness !== options.harness) throw new Error('native_receipt_mismatch');
  return { silo_id: result.silo_id, session_id: result.session_id, harness: result.harness,
    artifacts_verified: true, tree_snapshot_applied: true, native_command_started: result.native_command_started === true,
    safe_to_close_laptop: false, note: 'Selected index/worktree state was imported. Native authentication, context readiness and ownership handover still require verification.' };
}
