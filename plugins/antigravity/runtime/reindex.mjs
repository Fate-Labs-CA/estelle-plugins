import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { hash, readJson, writeJson } from './io.mjs';
import { redact } from './redact.mjs';

// Extracted from public estelle-cli reindex_spool / checkout_identity contracts.
const LIMITS = Object.freeze({ paths: 500, batch: 100, fileBytes: 256_000,
  bodyBytes: 2_000_000, patchLines: 10_000, debounceMs: 5_000,
  repoIntervalMs: 20_000, lockAttempts: 20, lockDelayMs: 25, deadLockMs: 30_000 });
const EXTENSIONS = new Set('c cpp cs go h hpp java js jsx kt md php py rb rs scala swift ts tsx'.split(' '));
const SKIP_DIRS = new Set('.git build coverage dist node_modules target vendor'.split(' '));
const CREDENTIAL_NAMES = new Set(['.env', '.netrc', '.npmrc', '.pypirc', 'auth.json',
  'credentials.json', 'estelle_accounts.json', 'estelle_experience.json', 'stress_accounts.json',
  'id_ecdsa', 'id_ed25519', 'id_rsa']);
const CREDENTIAL_EXTENSIONS = new Set(['key', 'p12', 'pem', 'pfx']);
const GIT_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(root, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of GIT_KEYS) delete env[key];
  const result = spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    env, encoding: 'utf8', timeout: 1_500, maxBuffer: LIMITS.bodyBytes,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout : undefined;
}

function within(child, root) {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function credentialPath(key) {
  const name = path.basename(key).toLowerCase();
  return CREDENTIAL_NAMES.has(name) || name.startsWith('.env.') || /^id_(rsa|ed25519)/.test(name)
    || CREDENTIAL_EXTENSIONS.has(path.extname(name).slice(1));
}

function editedPaths(n) {
  const input = n.toolInput;
  if (!input || typeof input !== 'object') return [];
  const paths = new Set();
  for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key].trim()) paths.add(input[key]);
  }
  const patch = ['input', 'patch', 'diff', 'arguments', 'command']
    .map(key => input[key]).find(value => typeof value === 'string' && value.includes('*** Begin Patch'));
  if (patch) {
    const lines = patch.split('\n');
    if (lines.length > LIMITS.patchLines) throw new Error('reindex_patch_bound');
    for (const line of lines) {
      const match = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/.exec(line);
      if (match) paths.add(match[1]);
      if (paths.size > LIMITS.batch) throw new Error('reindex_path_bound');
    }
  }
  return [...paths];
}

async function admit(root, cwd, offered) {
  if (!offered || /[\0\r\n]/.test(offered)) return null;
  const full = path.resolve(cwd, offered);
  if (!within(full, root)) return null;
  const key = path.relative(root, full).split(path.sep).join('/');
  if (credentialPath(key) || key.split('/').some(part => SKIP_DIRS.has(part))) return null;
  if (!EXTENSIONS.has(path.extname(key).slice(1))) return null;
  let canonical;
  try { canonical = await realpath(full); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Resolve the existing parent before accepting a deletion.
    canonical = path.join(await realpath(path.dirname(full)), path.basename(full));
  }
  if (!within(canonical, root) || canonical !== full) return null;
  const ignored = git(root, ['check-ignore', '-q', '--', key]);
  if (ignored !== undefined) return null;
  const inventory = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', key]);
  if (inventory === undefined || !inventory.split('\0').includes(key)) return null;
  return key;
}

async function lock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LIMITS.lockAttempts; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      const token = randomUUID();
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      catch (error) { await unlink(file).catch(() => {}); throw error; }
      finally { await handle.close(); }
      return async () => {
        const item = await readJson(file, 1024);
        if (item.token === token) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await clearDeadLock(file);
      await sleep(LIMITS.lockDelayMs);
    }
  }
  throw new Error('reindex_locked');
}

async function clearDeadLock(file) {
  try {
    if (Date.now() - (await stat(file)).mtimeMs < LIMITS.deadLockMs) return;
    const item = await readJson(file, 1024);
    if (!Number.isSafeInteger(item.pid) || item.pid < 1) return;
    try { process.kill(item.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') await unlink(file); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function load(file, initial) {
  try { return await readJson(file, 128_000); }
  catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
}

async function enqueue(file, repo, keys, now) {
  const release = await lock(`${file}.lock`);
  try {
    const state = await load(file, { repo: repo.name, root: repo.root, pending: {}, since: now, overflow: 0 });
    if (state.repo !== repo.name || state.root !== repo.root || !state.pending || typeof state.pending !== 'object') {
      throw new Error('reindex_spool_identity');
    }
    const pending = { ...state.pending };
    let overflow = state.overflow || 0;
    for (const key of keys) {
      if (!Object.hasOwn(pending, key) && Object.keys(pending).length >= LIMITS.paths) { overflow++; continue; }
      pending[key] = randomUUID();
    }
    const next = { ...state, pending, overflow, since: Object.keys(state.pending).length ? state.since : now };
    await writeJson(file, next);
    return next;
  } finally { await release(); }
}

async function reserve(marker, now) {
  const release = await lock(`${marker}.lock`);
  try {
    const previous = await load(marker, { at: 0 });
    if (!Number.isFinite(previous.at) || now < previous.at + LIMITS.repoIntervalMs) return false;
    await writeJson(marker, { at: now });
    return true;
  } finally { await release(); }
}

async function checkout(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const originHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir'])?.trim();
  const commonDir = git(root, ['rev-parse', '--git-common-dir'])?.trim();
  const linked = gitDir && commonDir
    ? await realpath(gitDir) !== await realpath(path.resolve(root, commonDir)) : false;
  return { linked_worktree: Boolean(linked),
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    ...(originHead?.startsWith('origin/') ? { default_branch: originHead.slice(7) } : {}),
  };
}

async function filePayload(root, key) {
  if (await admit(root, root, key) !== key) return null;
  const full = path.join(root, key);
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMITS.fileBytes) return null;
    const actual = await realpath(full);
    if (actual !== full || !within(actual, root)) return null;
    const current = await stat(full);
    if (current.dev !== info.dev || current.ino !== info.ino) return null;
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) return null;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (redact(content) !== content) return null;
    return { path: key, content };
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: key };
    if (error instanceof TypeError) return null;
    throw error;
  } finally { await handle?.close(); }
}

async function batchBody(root, repo, pending, deadline) {
  const files = [], removed = [], consumed = {};
  let excluded = 0;
  let bytes = 1000;
  for (const [key, token] of Object.entries(pending).slice(0, LIMITS.batch)) {
    // Leave room for two per-file Git checks and the four checkout-identity reads.
    if (Date.now() + 9_500 > deadline) break;
    const item = await filePayload(root, key);
    if (item === null) { consumed[key] = token; excluded++; continue; }
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > LIMITS.bodyBytes) break;
    bytes += size;
    consumed[key] = token;
    if (item.removed) removed.push(item.removed); else files.push(item);
  }
  const body = { repo, files, ...(removed.length ? { removed } : {}), checkout: await checkout(root) };
  if (Buffer.byteLength(JSON.stringify(body)) > LIMITS.bodyBytes) throw new Error('request_size');
  return { consumed, excluded, body };
}

async function acknowledge(file, consumed) {
  const release = await lock(`${file}.lock`);
  try {
    const state = await readJson(file, 128_000);
    const pending = { ...state.pending };
    for (const [key, token] of Object.entries(consumed)) if (pending[key] === token) delete pending[key];
    await writeJson(file, { ...state, pending });
    return Object.keys(pending).length;
  } finally { await release(); }
}

/** Synchronous debounced flush. Pending paths retry on later hook calls; no background worker. */
export async function queueReindex({ normalized, repo, stateDir, request, now = Date.now(),
  deadline = Date.now() + 12_000 }) {
  if (!repo || typeof repo.name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.name)) throw new Error('reindex_repo');
  if (typeof request !== 'function' || !Number.isFinite(now) || now <= 0) throw new Error('reindex_arguments');
  const root = await realpath(repo.root);
  const identity = { name: repo.name, root };
  const directory = path.join(stateDir, 'reindex');
  const file = path.join(directory, `${hash(`${repo.name}\0${root}`)}.json`);
  const keys = [];
  const cwd = await realpath(normalized.cwd || root);
  for (const offered of editedPaths(normalized)) {
    if (Date.now() + 3_000 > deadline) {
      // Queue only a lexical path here; filePayload revalidates inventory and real paths before
      // reading any content. A slow Git process must not lose the remaining edit references.
      const full = path.resolve(cwd, offered);
      const key = path.relative(root, full).split(path.sep).join('/');
      if (within(full, root) && !credentialPath(key) && EXTENSIONS.has(path.extname(key).slice(1))
          && !key.split('/').some(part => SKIP_DIRS.has(part))) keys.push(key);
      continue;
    }
    const key = await admit(root, cwd, offered);
    if (key) keys.push(key);
  }
  const state = await enqueue(file, identity, keys, now);
  if (!Object.keys(state.pending).length) return { pending: false, sent: 0, skipped: keys.length === 0 };
  if (now < state.since + LIMITS.debounceMs) return { pending: true, sent: 0, overflow: state.overflow };
  if (!await reserve(path.join(directory, `repo-${hash(repo.name)}.json`), now)) return { pending: true, sent: 0 };
  const { body, consumed, excluded } = await batchBody(root, repo.name, state.pending, deadline);
  const sent = body.files.length + (body.removed?.length || 0);
  const response = sent ? await request('/reindex', body) : {};
  const remaining = await acknowledge(file, consumed);
  // A lane skip is consumed, never reported as current. No freshness stamp is written here.
  return { pending: remaining > 0, sent, accepted: sent > 0 && response.skipped_off_default !== true,
    skippedOffDefault: response.skipped_off_default === true, overflow: state.overflow,
    excluded, incomplete: excluded > 0 || state.overflow > 0 };
}
