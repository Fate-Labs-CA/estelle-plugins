// `/estelle handoff` and `/estelle cloud`: collect this session's state and call the one server door, POST /sessions/move.
// The server picks the harness and writes the words. This file never reads an auth file or a credential: the conversation
// file comes from the host's own hook, one named file, and nothing else under the home directory is touched.
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, opendir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiClient, git, hash, readJson, repository, stateDirectory, writeJson } from './io.mjs';
import { NATIVE_LIMITS, captureNativeTranscript, checkNativeRelativePath } from './native-export.mjs';
import { checkpointSession } from './checkpoint.mjs';
import { canonicalHost, cloudExecutionIdentity, timelineIdentity } from './identity.mjs';
import { isOpaque, textHasCredential } from './credential.mjs';

export const MOVING = 'moving this session to the cloud';
export const MOVE_LIMITS = Object.freeze({
  snapshotFiles: 200, snapshotFileBytes: 2_000_000, pushMs: 45_000, requestMs: 60_000,
  wordsChars: 8_000, noteChars: 600, rolloutScan: 20_000, pendingMs: 86_400_000,
  unpushedDiffBytes: 8_000_000, visibilityMs: 5_000, gitMs: 20_000, untrackedSent: 64 });
// Paths that hold credentials by their nature, whatever is in them: a scan cannot see inside an encrypted or binary key.
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|\.docker\/config\.json|\.aws\/credentials|\.ssh\/[^/]+|id_(?:rsa|dsa|ecdsa|ed25519)|master\.key|credentials\.yml\.enc|secrets?\.(?:ya?ml|json|toml|env)|credentials\.json|service[-_]account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx))$/i;
// A lockfile is full of opaque digests under prefixes, and publishing it is normal.
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock)$/;
// credential.mjs reads labels and known vendors, and a vendor it has never heard of has neither. So a short prefix on an
// opaque value counts by itself, in either case. A value with no prefix is not flagged: that is every hash in a repository.
// The leading `+` or `-` is a diff's, because an unpushed commit is scanned as its diff.
const prefixedOpaque = text => text.split(/[\s"'`,;:=()[\]{}<>]+/).some(word => /^[+-]?[A-Za-z]{2,10}[_-]/.test(word) && isOpaque(word));
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

// 🔴 THE FOUNDER'S RULING: "Handoff just push untrack continue." So a file is carried or it is named, and neither stops the handoff.
// Credential paths never go, and neither does a file the scan flags or one too large to scan.
async function sortForPush(root, paths, scan) {
  const safe = [];
  const skipped = [];
  for (const path of paths) {
    let held = false;
    try { checkNativeRelativePath(path); } catch { held = true; }
    if (held || PRIVATE_PATH.test(path)) { skipped.push(path); continue; }
    const full = join(root, path);
    const info = await lstat(full).catch(() => null);
    if (!info || !info.isFile() || LOCKFILE.test(path)) { safe.push(path); continue; } // A deletion or a symlink carries no text to scan.
    if (info.size > MOVE_LIMITS.snapshotFileBytes || scan(await readFile(full, 'latin1'))) { skipped.push(path); continue; }
    safe.push(path);
  }
  return { safe: safe.slice(0, MOVE_LIMITS.snapshotFiles), skipped: [...skipped, ...safe.slice(MOVE_LIMITS.snapshotFiles)] };
}

// The commits this push would carry that origin has not seen, because a value deleted in a later commit is still history.
function unpushedHistory(root, scan) {
  let diff;
  let names;
  try {
    // By name, separately: a binary key has no `+++` line in a diff, so the diff alone never sees it.
    names = execFileSync('git', ['-C', root, 'log', '--name-only', '--no-renames', '-z', '--format=', 'HEAD', '--not', '--remotes'],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: MOVE_LIMITS.unpushedDiffBytes, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').map(name => name.trim()).filter(Boolean);
    diff = execFileSync('git', ['-C', root, 'log', '-p', '--no-color', '--no-ext-diff', 'HEAD', '--not', '--remotes', '--', '.',
      ':(exclude,glob)**/*.lock', ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/pnpm-lock.yaml'],
    { encoding: 'latin1', timeout: 20_000, maxBuffer: MOVE_LIMITS.unpushedDiffBytes, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ['your unpushed commits: too large to scan, so they could not be cleared']; }
  const named = names.filter(name => PRIVATE_PATH.test(name)).map(name => `${name}: in an unpushed commit, and holds credentials by its nature`);
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  return [...new Set(named), ...(scan(added) ? ['your unpushed commits: something shaped like a credential is in their history'] : [])];
}

// A commit cannot lose one file, so history is the one thing that still refuses the whole handoff.
function assertSafeHistory(root, scan) {
  const problems = unpushedHistory(root, scan);
  if (problems.length) {
    throw refusal(`Nothing was pushed, because your unpushed commits would carry credentials to your remote: ${problems.join('; ')}.`,
      'Remove them from those commits, then run this again.');
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
// and the push counts only once the remote reads back the same commit. Only the files named go, literally, so a skipped one cannot.
async function pushSnapshot(root, session, safe) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(directory, 'index'), GIT_LITERAL_PATHSPECS: '1' };
    gitWrite(root, ['read-tree', 'HEAD'], { env });
    if (safe.length) {
      const list = join(directory, 'paths');
      await writeFile(list, safe.join('\0'));
      gitWrite(root, ['add', '-A', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], { env, timeout: 30_000 });
    }
    const tree = gitWrite(root, ['write-tree'], { env });
    // Dated from HEAD, so the same tree is the same commit: a rerun pushes nothing new and names the same intent.
    const when = git(root, ['log', '-1', '--format=%cI', 'HEAD'], { strict: true, timeout: MOVE_LIMITS.gitMs });
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

// `--porcelain -z`: a rename or copy is followed by its old path as a bare entry, which is no row of its own.
function changedFiles(root) {
  const rows = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true, strict: true, timeout: MOVE_LIMITS.gitMs }).split('\0');
  const tracked = [];
  const untracked = [];
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at];
    if (!row) continue;
    (row.startsWith('??') ? untracked : tracked).push(row.slice(3));
    if (/^[RC]/.test(row)) at += 1;
  }
  return { tracked, untracked };
}

// 🔴 UNKNOWN IS NOT CLEAN OR PUSHED. A slow `git status` used to answer empty, and that read as nothing to carry.
function isPushed(root, commit) {
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream && !git(root, ['rev-list', '--max-count=1', `${upstream}..${commit}`], { strict: true, timeout: MOVE_LIMITS.gitMs })) return true;
  return git(root, ['ls-remote', 'origin', 'HEAD'], { timeout: MOVE_LIMITS.gitMs }).startsWith(commit);
}

function readingGit(work) {
  try { return work(); }
  catch (error) {
    if (error?.message !== 'git_failed') throw error;
    throw refusal('Estelle could not read this repository in time, and it will not guess that nothing changed.', 'Nothing was pushed. Run this again.');
  }
}

// A public repository gets nothing in its history. The one way onto a box without git is the conversation import's own file list:
// text only and small, on a key, with a conversation to ride beside. Anything outside those limits is named, and with no such
// conversation the handoff refuses, because that is the only place left to put the work.
async function filesForBox(root, safe, room) {
  const files = [];
  const skipped = [];
  let left = room;
  for (const path of safe) {
    const info = await lstat(join(root, path)).catch(() => null);
    const text = info?.isFile() && info.size <= NATIVE_LIMITS.blobBytes ? await readFile(join(root, path), 'utf8') : null;
    const fits = text !== null && !text.includes('\0') && !text.includes('\ufffd') && Array.from(text).length <= NATIVE_LIMITS.blobBytes
      && Buffer.byteLength(text) <= left && files.length < NATIVE_LIMITS.files;
    if (!fits) { skipped.push(path); continue; }
    left -= Buffer.byteLength(text);
    files.push({ path, text, sha256: createHash('sha256').update(text).digest('hex') });
  }
  return { files, skipped };
}

// What the box starts from. `pushed` work goes by commit; changed files go through a snapshot branch, or on a public repository
// through the box. `boxRoom` is what the conversation import has left, and zero means no import can carry them.
export async function gitState(root, session, scan = secretShaped, isOpen = async () => false, boxRoom = 0) {
  const { commit, branch, changed, pushed } = readingGit(() => {
    const head = git(root, ['rev-parse', 'HEAD'], { strict: true, timeout: MOVE_LIMITS.gitMs });
    const { tracked, untracked } = changedFiles(root);
    return { commit: head, branch: git(root, ['branch', '--show-current']), changed: [...tracked, ...untracked], pushed: isPushed(root, head) };
  });
  if (!/^[a-f0-9]{40}$/.test(commit)) throw refusal('This repository has no commit to start from.', 'Commit something first.');
  const { safe, skipped } = await sortForPush(root, changed, scan);
  const clean = { state: { branch, commit, dirty: false }, snapshot: null, carried: 0, boxFiles: [], skipped };
  if (!safe.length && pushed) return clean;
  const open = await isOpen();
  if (open !== false) {
    const why = open === true ? 'is public, so its history is no place for your work' : 'may be public, because Estelle could not tell';
    if (!pushed) throw refusal(`Nothing was pushed: this repository ${why}, and it has commits origin does not.`, 'Push them yourself, then run this again.');
    if (!boxRoom) throw refusal(`Nothing was pushed: this repository ${why}, and only a conversation carried with ESTELLE_API_KEY can take files without git.`, 'Commit and push what it needs, or set that key, then run this again.');
    const { files, skipped: tooLarge } = await filesForBox(root, safe, boxRoom);
    return { ...clean, boxFiles: files, skipped: [...skipped, ...tooLarge] };
  }
  assertSafeHistory(root, scan);
  const snapshot = await pushSnapshot(root, session, safe);
  return { state: { branch, commit: snapshot.commit, dirty: true, snapshot_branch: snapshot.branch }, snapshot, carried: safe.length, boxFiles: [], skipped };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A new session starts from a prompt, so it pushes nothing, and it says so before the machine starts: its task may be a question,
// and a conversation is no reason to publish work. It starts from what origin already has.
function cloudState(repo) {
  if (!repo) return { state: {}, snapshot: null, startsFrom: '' };
  return readingGit(() => {
    const head = git(repo.root, ['rev-parse', 'HEAD'], { strict: true, timeout: MOVE_LIMITS.gitMs });
    const branch = git(repo.root, ['branch', '--show-current']);
    const { tracked, untracked } = changedFiles(repo.root);
    const left = tracked.length + untracked.length;
    const start = startingPoint(repo.root, head, branch);
    const notes = [left ? `Your ${plural(left, 'uncommitted file')} aren't included.`.replace(/1 uncommitted file aren't/, "1 uncommitted file isn't") : '',
      start.unpushed ? `Your ${plural(start.unpushed, 'unpushed commit')} aren't included.`.replace(/1 unpushed commit aren't/, "1 unpushed commit isn't") : ''].filter(Boolean);
    const named = start.commit ? `${start.label} at ${start.commit.slice(0, 7)}` : 'the default branch';
    return { state: start.commit ? { ...(start.branch ? { branch: start.branch } : {}), commit: start.commit, dirty: false } : {}, snapshot: null,
      startsFrom: notes.length ? `Starts from ${named}. ${notes.join(' ')}` : '' };
  });
}

function startingPoint(root, head, branch) {
  if (/^[a-f0-9]{40}$/.test(head) && isPushed(root, head)) return { commit: head, branch, label: branch || 'this commit', unpushed: 0 };
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const name = upstream.replace(/^origin\//, '');
    const unpushed = Number(git(root, ['rev-list', '--count', `${upstream}..HEAD`], { strict: true, timeout: MOVE_LIMITS.gitMs }));
    return { commit: git(root, ['rev-parse', upstream], { strict: true, timeout: MOVE_LIMITS.gitMs }), branch: name, label: name, unpushed };
  }
  const remote = git(root, ['ls-remote', 'origin', 'HEAD'], { timeout: MOVE_LIMITS.gitMs }).split(/\s+/)[0];
  const known = /^[a-f0-9]{40}$/.test(remote) ? Number(git(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], { timeout: MOVE_LIMITS.gitMs }) || 0) : 0;
  return { commit: /^[a-f0-9]{40}$/.test(remote) ? remote : '', branch: '', label: 'the default branch', unpushed: known };
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

// A new session's key is its intent, so the same ask from the same place asks the server about the same machine: still running says
// so with its link, and over means a new one. A folder is part of the intent, so one prompt from two folders is two sessions.
const cloudKey = (repo, cwd, sessionId, ask, commit) => `plugin-${hash([repo?.name || cwd, sessionId, 'cloud', ask.harness, ask.prompt, commit].join('\x1f')).slice(0, 40)}`;

// One remote the box can clone. Any other host's `owner/name` is a different repository on GitHub, or none.
function refuseOtherHost(repo, env) {
  if (!repo || env.ESTELLE_REPO) return;
  const remote = git(repo.root, ['remote', 'get-url', 'origin']);
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]/i.exec(remote)?.[1]?.toLowerCase();
  if (host !== 'github.com') {
    throw refusal(`Estelle can only start from GitHub, and this repository's origin is ${host || 'not one it can read'}, so nothing was started.`);
  }
}

// One move. `say` receives each line a person reads, so a host that can stream shows the first line before the wait.
export async function runMove({ mode, words, env = process.env, cwd = process.cwd(), stateDir = stateDirectory(env), home,
  request = hasServerAccess(env) ? apiClient({ env, timeoutMs: MOVE_LIMITS.requestMs, deadline: Date.now() + MOVE_LIMITS.requestMs }) : null,
  say = () => {}, now = Date.now, scan = secretShaped, isPublic = isPublicRepo }) {
  // ⚠️ A box's own plugin stops here. A caller that skips the plugin is bounded by the account's Silo cap and its credits, not by depth.
  if (cloudExecutionIdentity(env)) throw refusal('This session is already running in the cloud, so nothing new was started.');
  const repo = repository(cwd, env);
  refuseOtherHost(repo, env);
  if (!repo && mode === 'handoff') throw refusal('This folder is not a Git repository with an origin on GitHub.', 'Run this from your repository.');
  const ask = parseWords(mode, words);
  const current = repo ? await currentSession(stateDir, repo.root, env, home) : null;
  if (mode === 'handoff' && !current?.sessionId) {
    throw refusal('Estelle has not seen this session, so it does not know what to continue.', 'Check the plugin is enabled with `doctor`, send one message here, then run this again.');
  }
  const host = current?.host ? canonicalHost(current.host) : '';
  const nativeSession = current?.sessionId || '';
  const sessionId = nativeSession ? timelineIdentity(host, nativeSession, env) : '';
  if (mode === 'handoff') say(MOVING);
  const isOpen = () => isPublic(repo.name);
  if (!request) return viaMcp({ mode, ask, repo, cwd, host, sessionId, nativeSession, scan, isOpen, say });
  if (mode === 'cloud') return cloudViaKey({ ask, repo, cwd, host, sessionId, request, say, env });
  const path = intentPath(stateDir, repo.root, sessionId, mode, words);
  const held = await readIntent(path, now());
  if (held) {
    // An earlier run never learned how this ended. Ask first; a record means it began, and nothing launches over it.
    let seen;
    try { seen = await request('/sessions/move', { action: 'status', move_key: held.key, ...(mode === 'handoff' ? { session_id: sessionId } : {}) }); }
    catch (error) { throw uncertain(sessionId, env, causeOf(error)); }
    if (seen.found === true) return finish(seen, { path, snapshot: null, checkpoint: null });
  }
  const key = held?.key || randomUUID();
  await writeJson(path, { key, at: now() });
  const carried = await conversation(host, nativeSession, current?.transcriptPath, home, env);
  const room = carried.native ? NATIVE_LIMITS.bytes - Buffer.byteLength(carried.native.transcript) : 0;
  const { state, snapshot, carried: went, boxFiles, skipped } = await gitState(repo.root, sessionId || key, scan, isOpen, Math.max(room, 0));
  if (carried.native) carried.native.files = boxFiles;
  const saved = await saveCheckpoint(current, repo, stateDir, request);
  const body = { mode, repo: repo.name, git: state, from_host: host || undefined, confirm: true, origin: 'plugin', move_key: key,
    ...(sessionId ? { session_id: sessionId } : {}), ...contextOf(mode, nativeSession, sessionId),
    ...(ask.harness ? { harness: ask.harness } : {}), ...whatWent(went, skipped),
    ...(ask.note ? { note: ask.note } : {}), ...(carried.native ? { native: carried.native } : {}),
    ...(carried.unavailable ? { native_unavailable: carried.unavailable } : {}) };
  let answer;
  try { answer = await request('/sessions/move', body); }
  catch (error) {
    // A 4xx means the server refused the ask and started nothing. Anything else may have landed on either side.
    if (error?.status >= 400 && error?.status < 500) { await rm(path, { force: true }); throw error; }
    throw uncertain(sessionId, env, causeOf(error));
  }
  return finish(answer, { path, snapshot, checkpoint: saved });
}

const whatWent = (went, skipped) => ({ ...(went ? { files_carried: went } : {}),
  ...(skipped?.length ? { left_behind: skipped.slice(0, MOVE_LIMITS.untrackedSent) } : {}) });

async function cloudViaKey({ ask, repo, cwd, host, sessionId, request, say, env }) {
  const { state, startsFrom } = cloudState(repo);
  if (startsFrom) say(startsFrom);
  const body = { mode: 'cloud', ...(repo ? { repo: repo.name } : {}), git: state, from_host: host || undefined, confirm: true, origin: 'plugin',
    move_key: cloudKey(repo, cwd, sessionId, ask, state.commit), ...(ask.harness ? { harness: ask.harness } : {}), prompt: ask.prompt };
  let answer;
  try { answer = await request('/sessions/move', body); }
  catch (error) {
    if (error?.status >= 400 && error?.status < 500) throw error;
    throw uncertain(sessionId, env, causeOf(error));
  }
  return finish(answer, { snapshot: null, checkpoint: null });
}

// A host's hooks checkpoint under its own id, and a move names the timeline id, so the server is told both.
const contextOf = (mode, nativeSession, sessionId) => (mode === 'handoff' && nativeSession && nativeSession !== sessionId
  ? { context_session_id: nativeSession } : {});

// 🔴 THE USUAL PATH: Claude Code signs in to Estelle with OAuth, and that sign-in belongs to the host, so this process
// holds no key and cannot reach the server. It does the part only it can (the git state and the snapshot) and hands the
// model one MCP call. A tool call cannot carry a conversation file, and this process cannot save a checkpoint either, so
// the server's last message says what actually travelled.
// The key is derived, not stored: this process never learns the answer, and the same tree and words are the same intent.
async function viaMcp({ mode, ask, repo, cwd, host, sessionId, nativeSession, scan, isOpen, say }) {
  const cloud = mode === 'cloud';
  const { state, snapshot, carried, skipped, startsFrom } = cloud ? cloudState(repo) : await gitState(repo.root, sessionId || repo.name, scan, isOpen);
  if (startsFrom) say(startsFrom);
  const intent = cloud ? cloudKey(repo, cwd, sessionId, ask, state.commit)
    : `plugin-${hash([repo.name, sessionId, mode, ask.harness, ask.note, state.commit].join('\x1f')).slice(0, 40)}`;
  const args = { mode, ...(repo ? { repo: repo.name } : {}), move_key: intent, confirm: true, ...(state.commit ? { commit: state.commit } : {}),
    ...(state.branch ? { branch: state.branch } : {}), ...(state.snapshot_branch ? { snapshot_branch: state.snapshot_branch } : {}),
    ...(host ? { from_host: host } : {}), ...(sessionId && !cloud ? { session_id: sessionId } : {}), ...contextOf(mode, nativeSession, sessionId),
    ...(ask.harness ? { harness: ask.harness } : {}), ...whatWent(carried, skipped),
    ...(ask.prompt ? { prompt: ask.prompt } : {}), ...(ask.note ? { note: ask.note } : {}) };
  return { answer: { moved: undefined }, snapshot, mcp: args, final: `ESTELLE_MCP_CALL\n${JSON.stringify(args)}` };
}

// 🔴 THE COMMAND ENDS HERE, AT THE LINK. It used to poll until the work landed, so a host's 120 s shell timeout killed it holding a
// billing machine and no link. Status is a separate read, on the page. An outcome nobody knows keeps its key, so a rerun only asks.
async function finish(answer, { path, snapshot, checkpoint }) {
  if (path && answer.moved !== null && answer.state !== 'unknown') await rm(path, { force: true });
  return { answer, snapshot, checkpoint, final: answer.last_message || answer.message };
}

async function saveCheckpoint(current, repo, stateDir, request) {
  if (!current?.sessionId || !current.transcriptPath) return { saved: false, reason: 'this host did not name its conversation file' };
  try {
    return await checkpointSession({ payload: { session_id: current.sessionId, transcript_path: current.transcriptPath,
      hook_event_name: 'PreCompact', cwd: repo.root }, host: current.host, repo: repo.name, stateDir, request });
  } catch { return { saved: false, reason: 'the checkpoint could not be saved' }; }
}

// Every last line carries a link. The refusal that could not tell already holds its session's.
const sessionsLink = env => `${String(env.ESTELLE_SITE_URL || 'https://fatelabs.ca').replace(/\/$/, '')}/dashboard/sessions`;
export function messageOf(error, env = process.env) {
  if (error?.message === 'move_refused') return error.uncertain ? `${error.reason} ${error.needed}`.trim() : `${error.reason} ${error.needed} ${sessionsLink(env)}`.replace(/\s+/g, ' ').trim();
  return `Estelle could not start this (${error?.status ? `HTTP ${error.status}: ${error.message}` : 'network error'}). Nothing was confirmed as started. ${sessionsLink(env)}`;
}

// The CLI door: `move <handoff|cloud>` with the person's words on stdin, so no shell ever parses them.
export async function moveCommand(mode, input, { stdout = console.log, setExit = code => { process.exitCode = code; } } = {}) {
  if (mode !== 'handoff' && mode !== 'cloud') { stdout('Use `move handoff` or `move cloud`.'); setExit(2); return; }
  try {
    const result = await runMove({ mode, words: input, say: stdout });
    stdout(result.final);
    if ((result.answer.moved === false && result.answer.already_running !== true) || result.answer.moved === null) setExit(1);
  } catch (error) { stdout(messageOf(error)); setExit(1); }
}
