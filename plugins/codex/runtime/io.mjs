import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, open, rename, stat, readFile, unlink } from 'node:fs/promises';
import { VERSION } from './version.mjs';

export const MAX_JSON_BYTES = 2_000_000;
export const MAX_RESPONSE_BYTES = 2_000_000;
export const REQUEST_TIMEOUT_MS = 8_000;
export const safeSession = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export const hash = value => createHash('sha256').update(value).digest('hex');

export function stateDirectory(env = process.env, capturePartition) {
  // Never write into a host's immutable, approved plugin bundle.
  const base = resolve(env.ESTELLE_PLUGIN_DATA || join(homedir(), '.estelle-plugins'));
  const bundle = realpathSync(resolve(import.meta.dirname, '..'));
  let existing = base;
  let resolved = false;
  const MAX_PARENTS = 64;
  for (let i = 0; i < MAX_PARENTS; i++) {
    try { existing = realpathSync(existing); resolved = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = dirname(existing); }
  }
  if (!resolved) throw new Error('state_inside_bundle');
  for (const candidate of [base, existing]) {
    const child = relative(bundle, candidate);
    if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) throw new Error('state_inside_bundle');
  }
  // A different account credential must never replay another account's saved transcript batches.
  const key = env.ESTELLE_API_KEY;
  if (!key && capturePartition !== undefined) {
    if (!/^[a-f0-9]{32}$/.test(capturePartition)) throw new Error('capture_binding_changed');
    return join(base, `capture-${capturePartition}`);
  }
  return join(base, key ? hash(key).slice(0, 24) : 'unauthenticated');
}

export async function readJson(path, maxBytes = MAX_JSON_BYTES) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('state_size');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) throw new Error('state_size');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

export async function writeJson(path, value) {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > MAX_JSON_BYTES) throw new Error('state_size');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export function git(cwd, args, { strict = false, raw = false, bytes = false, timeout = 1500 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[name];
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], {
      env, encoding: bytes ? null : 'utf8', timeout, maxBuffer: MAX_JSON_BYTES, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return bytes || raw ? output : output.trim();
  } catch { if (strict) throw new Error('git_failed'); return ''; }
}

export function repository(cwd, env = process.env) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'], { raw: true }).replace(/\r?\n$/, '');
  if (!root) return null;
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const match = /(?:[:/])([^/:\s]+\/[^/\s]+?)(?:\.git)?$/.exec(remote);
  const name = env.ESTELLE_REPO || match?.[1];
  if (!name || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { root, name };
}

export function apiBase(env = process.env) {
  let url;
  try { url = new URL(env.ESTELLE_API_URL || 'https://api.fatelabs.ca'); }
  catch { throw new Error('invalid_api_url'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('invalid_api_url');
  }
  return url.origin;
}

export function apiClient({ env = process.env, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS,
  deadline = Date.now() + 12_000 } = {}) {
  const base = apiBase(env);
  const key = env.ESTELLE_API_KEY;
  return async (path, body) => {
    if (!key || /[\r\n]/.test(key)) throw new Error('credential_missing');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException('hook deadline', 'TimeoutError');
    if (!/^\/[a-z0-9/_-]+$/i.test(path)) throw new Error('invalid_route');
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error('request_size');
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(remaining, timeoutMs)),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        'X-Estelle-Client-Protocol': '1', 'X-Estelle-Hook-Contract': '1',
        'X-Estelle-Client-Version': `estelle-plugins/${VERSION}` },
      body: encoded,
    });
    let bytes = 0;
    const parts = [];
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('response_size');
      parts.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (!response.ok) {
      // Server text is used internally by stream poison-event isolation. Never log it.
      const error = new Error('http_error');
      error.status = response.status;
      let detail;
      try {
        const parsed = JSON.parse(text);
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      } catch { /* A non-JSON refusal remains an HTTP error. */ }
      error.message = typeof detail === 'string' ? detail.slice(0, 1000) : text.slice(0, 1000);
      throw error;
    }
    try { return text ? JSON.parse(text) : {}; }
    catch { throw new Error('response_json'); }
  };
}

const ERROR_CODES = new Set(['credential_missing', 'invalid_api_url', 'invalid_route',
  'capture_missing', 'capture_pending', 'capture_busy', 'capture_private', 'capture_incomplete',
  'capture_record', 'capture_origin', 'capture_binding_changed', 'capture_transport_unknown',
  'capture_unsupported_platform',
  'request_size', 'response_size', 'response_json', 'state_size', 'input_size', 'input_json',
  'event_missing', 'session_missing', 'transcript_missing', 'unsupported_host', 'state_inside_bundle', 'context_claim_locked']);

export function errorCode(error) {
  if (Number.isInteger(error?.status)) return `http_${error.status}`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (ERROR_CODES.has(error?.message)) return error.message;
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC'].includes(error?.code)) return error.code.toLowerCase();
  return 'operation_failed';
}

export async function recordStatus(stateDir, { host, event, mode, status, code, pending }) {
  const row = { at: new Date().toISOString(), host, event, mode, status, ...(code ? { code } : {}),
    ...(typeof pending === 'boolean' ? { pending } : {}) };
  // One bounded record per host/mode; no prompts, paths, headers, tokens, or remote response text.
  if (!/^[a-z-]+$/.test(host) || !/^[a-z-]+$/.test(mode)) throw new Error('unsupported_host');
  await writeJson(join(stateDir, 'status', `${host}-${mode}.json`), row);
}
