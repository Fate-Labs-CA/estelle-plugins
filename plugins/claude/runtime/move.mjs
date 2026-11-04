// `/estelle handoff` and `/estelle cloud`: collect this session's state and call the one server door, POST /sessions/move.
// The server picks the harness and writes the words. This file never reads an auth file or a credential: the conversation
// file comes from the host's own hook, one named file, and nothing else under the home directory is touched.
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, opendir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiClient, git, hash, readJson, repository, stateDirectory, writeJson } from './io.mjs';
import { captureNativeTranscript, checkNativeRelativePath } from './native-export.mjs';
import { checkpointSession } from './checkpoint.mjs';
import { canonicalHost, timelineIdentity } from './identity.mjs';
import { isOpaque, textHasCredential } from './credential.mjs';

export const MOVING = 'moving this session to the cloud';
export const MOVE_LIMITS = Object.freeze({
  snapshotFiles: 200, snapshotFileBytes: 2_000_000, pushMs: 60_000, requestMs: 120_000,
  pollEveryMs: 5_000, polls: 36, wordsChars: 8_000, noteChars: 600, rolloutScan: 20_000, pendingMs: 86_400_000,
  unpushedDiffBytes: 8_000_000, visibilityMs: 5_000 });
// Paths that hold credentials by their nature, whatever is in them: a scan cannot see inside an encrypted or binary key.
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|\.docker\/config\.json|\.aws\/credentials|\.ssh\/[^/]+|id_(?:rsa|dsa|ecdsa|ed25519)|master\.key|credentials\.yml\.enc|secrets?\.(?:ya?ml|json|toml|env)|credentials\.json|service[-_]account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx))$/i;
// A lockfile is full of opaque digests under prefixes, and publishing it is normal.
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock)$/;
// credential.mjs reads labels and known vendors, and a vendor it has never heard of has neither. So a short lowercase
// prefix on an opaque value counts by itself. A value with no prefix is not flagged: that is every hash in a repository.
const prefixedOpaque = text => text.split(/[\s"'`,;:=()[\]{}<>]+/).some(word => /^[a-z]{2,10}[_-]/.test(word) && isOpaque(word));
export const secretShaped = text => textHasCredential(text) || prefixedOpaque(text);
const HARNESSES = { codex: 'codex', claude: 'claude-code', 'claude-code': 'claude-code', cursor: 'cursor', kimi: 'kimi-code',
  'kimi-code': 'kimi-code', grok: 'grok' };
const NATIVE_HOSTS = new Set(['claude-code', 'codex']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const hasServerAccess = env => Boolean(env.ESTELLE_API_KEY);

export function refusal(reason, needed = '') {
  const error = new Error('move_refused');
  error.reason = reason; error.needed = needed;
  return error;
}

// `[harness] [words]`. The first word names a harness only when it is one, so `/estelle cloud fix codex` is a prompt.
export function parseWords(mode, raw) {
  const text = String(raw ?? '').trim();
  if (text.length > MOVE_LIMITS.wordsChars) throw refusal(`That is ${text.length} characters and a request holds ${MOVE_LIMITS.wordsChars}.`, 'Shorten it. Nothing was started.');
  const [first = '', ...rest] = text.split(/\s+/);
  const harness = HARNESSES[first.toLowerCase()] || '';
  const words = harness ? text.slice(first.length).trim() : text;
  if (mode === 'cloud' && !words) throw refusal('/estelle cloud needs a prompt.', 'Say what the cloud session should do.');
  if (mode === 'handoff' && words.length > MOVE_LIMITS.noteChars) {
    throw refusal(`That note is ${words.length} characters and a handoff holds ${MOVE_LIMITS.noteChars}.`, 'Shorten it. Nothing was started.');
  }
  return mode === 'cloud' ? { harness, prompt: words } : { harness, note: words };
}

const sessionPath = (stateDir, root) => join(stateDir, 'current', `${hash(root)}.json`);

// Called from every hook, so the commands know which session and file they are in. Names and a path, never content.
export async function noteCurrentSession(stateDir, { host, sessionId, transcriptPath, cwd }) {
  const repo = repository(cwd);
  if (!repo) return;
  await writeJson(sessionPath(stateDir, repo.root), { host, sessionId, transcriptPath: transcriptPath || '',
    at: new Date().toISOString() });
}

// Codex runs hooks only once a person trusts them, and never in `exec`, so a hook may never have named this session. It
// names its own thread to every process it starts, so a bounded walk of its own sessions folder finds that one file.
async function findRollout(root, thread) {
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < MOVE_LIMITS.rolloutScan) {
    const directory = await opendir(pending.pop()).catch(() => null);
    if (!directory) continue;
    for await (const entry of directory) {
      if (++seen >= MOVE_LIMITS.rolloutScan) break;
      if (entry.isDirectory()) pending.push(join(entry.parentPath, entry.name));
      else if (entry.isFile() && entry.name.endsWith(`${thread}.jsonl`)) return join(entry.parentPath, entry.name);
    }
  }
  return '';
}

async function currentSession(stateDir, root, env, home) {
  const noted = await readJson(sessionPath(stateDir, root), 16_000).catch(() => null);
  const thread = env.CODEX_THREAD_ID;
  if (!UUID.test(thread || '')) return noted;
  if (noted?.sessionId === thread) return noted;
  const sessions = join(env.CODEX_HOME || join(home || homedir(), '.codex'), 'sessions');
  return { host: 'codex', sessionId: thread, transcriptPath: await findRollout(sessions, thread) };
}

function gitWrite(root, args, { env = {}, timeout = 10_000 } = {}) {
  const clean = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete clean[name];
  return execFileSync('git', ['-C', root, ...args], { env: clean, encoding: 'utf8', timeout, maxBuffer: 8_000_000,
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Everything wrong with this push, at once, so one fix does not reveal the next refusal.
async function unsafeToPush(root, paths, scan) {
  const problems = [];
  for (const path of paths) {
    try { checkNativeRelativePath(path); }
    catch { problems.push(`${path}: a private path`); continue; }
    if (PRIVATE_PATH.test(path)) { problems.push(`${path}: a file that holds credentials by its nature`); continue; }
    const full = join(root, path);
    const info = await lstat(full).catch(() => null);
    if (!info || !info.isFile() || LOCKFILE.test(path)) continue; // A deletion or a symlink carries no text to scan.
    if (info.size > MOVE_LIMITS.snapshotFileBytes) { problems.push(`${path}: past the snapshot's file bound, so it could not be scanned`); continue; }
    if (scan(await readFile(full, 'latin1'))) problems.push(`${path}: holds something shaped like a credential`);
  }
  return problems;
}

// The commits this push would carry that origin has not seen, because a value deleted in a later commit is still history.
function unpushedHistory(root, scan) {
  let diff;
  try {
    diff = execFileSync('git', ['-C', root, 'log', '-p', '--no-color', '--no-ext-diff', 'HEAD', '--not', '--remotes', '--', '.',
      ':(exclude,glob)**/*.lock', ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/pnpm-lock.yaml'],
    { encoding: 'latin1', timeout: 20_000, maxBuffer: MOVE_LIMITS.unpushedDiffBytes, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ['your unpushed commits: too large to scan, so they could not be cleared']; }
  const names = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  const named = names.filter(name => PRIVATE_PATH.test(name)).map(name => `${name}: in an unpushed commit, and holds credentials by its nature`);
  return [...new Set(named), ...(scan(diff) ? ['your unpushed commits: something shaped like a credential is in their history'] : [])];
}

async function assertSafeToPush(root, paths, scan) {
  if (paths.length > MOVE_LIMITS.snapshotFiles) {
    throw refusal(`${paths.length} changed files is past the ${MOVE_LIMITS.snapshotFiles}-file snapshot bound.`,
      'Commit or stash some of them, or push your own branch, then run this again.');
  }
  const problems = [...await unsafeToPush(root, paths, scan), ...unpushedHistory(root, scan)];
  if (problems.length) {
    throw refusal(`Nothing was pushed, because this snapshot would carry credentials to your remote:\n- ${problems.join('\n- ')}\n`,
      'Remove them or add them to .gitignore, then run this again.');
  }
}

// A snapshot lands on origin, so a public repo publishes it. Asked anonymously: an answer of 200 means anyone can read it.
export async function isPublicRepo(name, fetchImpl = fetch) {
  try {
    const answer = await fetchImpl(`https://api.github.com/repos/${name}`, { signal: AbortSignal.timeout(MOVE_LIMITS.visibilityMs),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'estelle-plugin' } });
    return answer.status === 200 ? true : answer.status === 404 ? false : null;
  } catch { return null; }
}

// A commit built on a temporary index and pushed to its own branch. HEAD, the index and the working tree are never touched,
// and the push counts only once the remote reads back the same commit.
async function pushSnapshot(root, session, paths, scan, warn) {
  await assertSafeToPush(root, paths, scan);
  await warn();
  const directory = await mkdtemp(join(tmpdir(), 'estelle-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(directory, 'index') };
    gitWrite(root, ['read-tree', 'HEAD'], { env });
    gitWrite(root, ['add', '-A', '--', '.'], { env, timeout: 30_000 });
    const tree = gitWrite(root, ['write-tree'], { env });
    // Dated from HEAD, so the same tree is the same commit: a rerun pushes nothing new and names the same intent.
    const when = git(root, ['log', '-1', '--format=%cI', 'HEAD']);
    const commit = gitWrite(root, ['commit-tree', tree, '-p', 'HEAD', '-m', 'Estelle snapshot of uncommitted work'],
      { env: { GIT_AUTHOR_NAME: 'Estelle', GIT_AUTHOR_EMAIL: 'noreply@fatelabs.ca', GIT_COMMITTER_NAME: 'Estelle',
        GIT_COMMITTER_EMAIL: 'noreply@fatelabs.ca', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
    const branch = `estelle/snapshot/${session.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '-')}-${commit.slice(0, 8)}`;
    try { gitWrite(root, ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`], { timeout: MOVE_LIMITS.pushMs }); }
    catch { throw refusal('Your uncommitted work could not be pushed to a snapshot branch.', 'Check that you can push to origin, then run this again.'); }
    const seen = gitWrite(root, ['ls-remote', 'origin', `refs/heads/${branch}`], { timeout: 20_000 }).split(/\s+/)[0];
    if (seen !== commit) throw refusal('The snapshot branch did not read back from origin.', 'Check origin, then run this again.');
    return { branch, commit };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function isPushed(root, commit) {
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream && !git(root, ['rev-list', '--max-count=1', `${upstream}..${commit}`])) return true;
  return git(root, ['ls-remote', 'origin', 'HEAD']).startsWith(commit);
}

// What the box starts from. `pushed` work goes by commit; anything local goes through a snapshot branch or a refusal.
export async function gitState(root, session, scan = secretShaped, warn = async () => {}) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw refusal('This repository has no commit to start from.', 'Commit something first.');
  const branch = git(root, ['branch', '--show-current']);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true });
  const paths = status.split('\0').filter(Boolean).map(row => row.slice(3)).filter(Boolean);
  if (!paths.length && isPushed(root, commit)) return { state: { branch, commit, dirty: false }, snapshot: null };
  const snapshot = await pushSnapshot(root, session, paths, scan, warn);
  return { state: { branch, commit: snapshot.commit, dirty: true, snapshot_branch: snapshot.branch }, snapshot };
}

// captureNativeTranscript takes a home and appends the host's folder, so a relocated config folder needs its parent.
const homeFor = (host, env) => (host === 'codex' && env.CODEX_HOME ? dirname(env.CODEX_HOME)
  : host === 'claude-code' && env.CLAUDE_CONFIG_DIR ? dirname(env.CLAUDE_CONFIG_DIR) : undefined);

async function conversation(host, nativeSession, transcriptPath, home, env) {
  if (!NATIVE_HOSTS.has(host)) return { unavailable: `${host} has no proven way to reopen a conversation in another machine` };
  if (!UUID.test(nativeSession || '') || !transcriptPath) return { unavailable: 'this host did not name its conversation file' };
  try {
    const transcript = await captureNativeTranscript({ harness: host, sessionId: nativeSession, transcriptPath, home: home || homeFor(host, env) || homedir() });
    return { native: { session_id: nativeSession, transcript, files: [] } };
  } catch (error) {
    const reasons = { native_artifact_bound: 'the conversation is over the 512 KiB bound', native_credential_field: 'the conversation holds a credential field' };
    return { unavailable: reasons[error?.message] || 'the conversation file could not be read safely' };
  }
}

// A status read that fails is a read that failed, never news about the move: the machine may be fine. It keeps asking,
// inside the same bound, and an unanswered bound is reported by the caller as "keep this open".
async function settle(request, sessionId, sleep) {
  for (let poll = 0; poll < MOVE_LIMITS.polls; poll += 1) {
    await sleep(MOVE_LIMITS.pollEveryMs);
    const view = await request('/sessions/move', { action: 'status', session_id: sessionId }).catch(() => null);
    if (view?.final === true) return view;
  }
  return null;
}

// One intent keeps one key until its outcome is known, so a rerun after a timeout cannot buy a second machine. The key is
// written before the request goes out: the request may reach the server and its answer may not reach us.
const intentPath = (stateDir, root, sessionId, mode, words) => join(stateDir, 'moves',
  `${hash([root, sessionId, mode, String(words ?? '').trim()].join('\x1f'))}.json`);

async function readIntent(path, now) {
  const held = await readJson(path, 4_000).catch(() => null);
  return held?.key && now - Number(held.at || 0) < MOVE_LIMITS.pendingMs ? held : null;
}

function uncertain(sessionId, env, cause) {
  const site = String(env.ESTELLE_SITE_URL || 'https://fatelabs.ca').replace(/\/$/, '');
  const link = `${site}/dashboard/sessions${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`;
  const error = refusal(`Estelle could not confirm whether this started (${cause}), so do not start it another way.`,
    `Run this same command again: it only checks, and it will not start a second machine. Watch it here: ${link}`);
  error.uncertain = true;
  return error;
}

const causeOf = error => (error?.status ? `HTTP ${error.status}` : 'no answer from the server');
const definitive = answer => answer.moved === true ? answer.final === true : answer.moved === false;

// One move. `say` receives each line a person reads, so a host that can stream shows the first line before the wait.
export async function runMove({ mode, words, env = process.env, cwd = process.cwd(), stateDir = stateDirectory(env), home,
  request = hasServerAccess(env) ? apiClient({ env, timeoutMs: MOVE_LIMITS.requestMs, deadline: Date.now() + MOVE_LIMITS.requestMs * 3 }) : null,
  say = () => {}, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, scan = secretShaped,
  isPublic = isPublicRepo }) {
  const repo = repository(cwd, env);
  if (!repo) throw refusal('This folder is not a Git repository with an origin on GitHub.', 'Run this from your repository.');
  const ask = parseWords(mode, words);
  const current = await currentSession(stateDir, repo.root, env, home);
  if (mode === 'handoff' && !current?.sessionId) {
    throw refusal('Estelle has not seen this session, so it does not know what to continue.', 'Check the plugin is enabled with `doctor`, send one message here, then run this again.');
  }
  const host = current?.host ? canonicalHost(current.host) : '';
  const nativeSession = current?.sessionId || '';
  const sessionId = nativeSession ? timelineIdentity(host, nativeSession, env) : '';
  say(MOVING);
  const path = intentPath(stateDir, repo.root, sessionId, mode, words);
  const warn = async () => {
    const open = await isPublic(repo.name);
    if (open === true) say(`Warning: ${repo.name} is public, so the snapshot branch below is readable by anyone.`);
    if (open === null) say(`Warning: could not tell whether ${repo.name} is public. The snapshot branch below may be readable by anyone.`);
  };
  if (!request) return viaMcp({ mode, ask, repo, host, sessionId, scan, warn });
  const held = await readIntent(path, now());
  if (held) {
    // An earlier run never learned how this ended. Ask first; a record means it began, and nothing launches over it.
    let seen;
    try { seen = await request('/sessions/move', { action: 'status', move_key: held.key, ...(mode === 'handoff' ? { session_id: sessionId } : {}) }); }
    catch (error) { throw uncertain(sessionId, env, causeOf(error)); }
    if (seen.found === true) return finish(seen, seen, { path, request, sleep, snapshot: null, checkpoint: null });
  }
  const key = held?.key || randomUUID();
  await writeJson(path, { key, at: now() });
  const { state, snapshot } = await gitState(repo.root, sessionId || key, scan, warn);
  const saved = await saveCheckpoint(current, repo, stateDir, request);
  const carried = mode === 'handoff' ? await conversation(host, nativeSession, current?.transcriptPath, home, env) : {};
  const body = { mode, repo: repo.name, git: state, from_host: host || undefined, confirm: true, origin: 'plugin', move_key: key,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(ask.harness ? { harness: ask.harness } : {}), ...(ask.prompt ? { prompt: ask.prompt } : {}),
    ...(ask.note ? { note: ask.note } : {}), ...(carried.native ? { native: carried.native } : {}),
    ...(carried.unavailable ? { native_unavailable: carried.unavailable } : {}) };
  let answer;
  try { answer = await request('/sessions/move', body); }
  catch (error) {
    // A 4xx means the server refused the ask and started nothing. Anything else may have landed on either side.
    if (error?.status >= 400 && error?.status < 500) { await rm(path, { force: true }); throw error; }
    throw uncertain(sessionId, env, causeOf(error));
  }
  return finish(answer, answer, { path, request, sleep, snapshot, checkpoint: saved });
}

// 🔴 THE USUAL PATH: Claude Code signs in to Estelle with OAuth, and that sign-in belongs to the host, so this process
// holds no key and cannot reach the server. It does the part only it can (the git state and the snapshot) and hands the
// model one MCP call. A tool call cannot carry a conversation file, so this path restarts from context and the server says
// so. The key is derived, not stored: this process never learns the answer, and the same tree and words are the same intent.
async function viaMcp({ mode, ask, repo, host, sessionId, scan, warn }) {
  const { state, snapshot } = await gitState(repo.root, sessionId || repo.name, scan, warn);
  const intent = `plugin-${hash([repo.name, sessionId, mode, ask.harness, ask.note ?? ask.prompt, state.commit].join('\x1f')).slice(0, 40)}`;
  const args = { mode, repo: repo.name, move_key: intent, confirm: true, commit: state.commit,
    ...(state.branch ? { branch: state.branch } : {}), ...(state.snapshot_branch ? { snapshot_branch: state.snapshot_branch } : {}),
    ...(host ? { from_host: host } : {}), ...(sessionId ? { session_id: sessionId } : {}), ...(ask.harness ? { harness: ask.harness } : {}),
    ...(ask.prompt ? { prompt: ask.prompt } : {}), ...(ask.note ? { note: ask.note } : {}) };
  return { answer: { moved: undefined }, snapshot, mcp: args, final: `ESTELLE_MCP_CALL\n${JSON.stringify(args)}` };
}

async function finish(answer, first, { path, request, sleep, snapshot, checkpoint }) {
  const settled = answer.final === false ? await settle(request, answer.session_id, sleep) : answer;
  // The key is released only once the outcome is known. Past that, running the command again is a new intent.
  const known = settled && (settled.final === true || definitive(settled)) && settled.state !== 'unknown' && first.moved !== null;
  if (known) await rm(path, { force: true });
  return { answer: first, settled, snapshot, checkpoint, final: settled ? settled.last_message || settled.message
    : `${first.last_message}\nEstelle could not confirm the move in time, so keep this session open and watch the link.` };
}

async function saveCheckpoint(current, repo, stateDir, request) {
  if (!current?.sessionId || !current.transcriptPath) return { saved: false, reason: 'this host did not name its conversation file' };
  try {
    return await checkpointSession({ payload: { session_id: current.sessionId, transcript_path: current.transcriptPath,
      hook_event_name: 'PreCompact', cwd: repo.root }, host: current.host, repo: repo.name, stateDir, request });
  } catch { return { saved: false, reason: 'the checkpoint could not be saved' }; }
}

export function messageOf(error) {
  if (error?.message === 'move_refused') return `${error.reason} ${error.needed}`.trim();
  return `Estelle could not start this (${error?.status ? `HTTP ${error.status}: ${error.message}` : 'network error'}). Nothing was confirmed as started.`;
}

// The CLI door: `move <handoff|cloud>` with the person's words on stdin, so no shell ever parses them.
export async function moveCommand(mode, input, { stdout = console.log, setExit = code => { process.exitCode = code; } } = {}) {
  if (mode !== 'handoff' && mode !== 'cloud') { stdout('Use `move handoff` or `move cloud`.'); setExit(2); return; }
  try {
    const result = await runMove({ mode, words: input, say: stdout });
    if (result.snapshot) stdout(`Uncommitted work is on branch ${result.snapshot.branch}. Your branch was not changed.`);
    stdout(result.final);
    if (result.answer.moved === false || result.answer.moved === null) setExit(1);
  } catch (error) { stdout(messageOf(error)); setExit(1); }
}
