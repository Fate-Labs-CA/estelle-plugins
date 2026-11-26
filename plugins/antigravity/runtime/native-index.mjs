import { lstat, realpath, opendir } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { git } from './io.mjs';

const paths = text => text.split('\0').filter(Boolean);
const fingerprint = info => [info.dev, info.ino, info.mode, info.size, info.mtimeMs].join(':');
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export const nativeGit = cwd => (args, options = {}) => git(cwd, ['--literal-pathspecs',
  '-c', 'core.fileMode=true', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { strict: true, ...options });

export function indexState(run) {
  // Git can suppress dirty paths using index flags. Refuse rather than read every
  // tracked file (which could include credentials) to discover hidden changes.
  const tagged = run(['ls-files', '--sparse', '-v', '-z'], { raw: true });
  const debug = run(['ls-files', '--sparse', '--debug', '-z'], { raw: true });
  const flags = [...debug.matchAll(/\tflags: ([0-9a-f]+)\n/g)];
  const entries = paths(tagged);
  const sparse = ['core.sparseCheckout', 'index.sparse'].map(key => run(['config', '--type=bool', '--default=false', '--get', key]));
  if (entries.some(row => !row.startsWith('H ')) || flags.length !== entries.length
      || flags.some(row => Number.parseInt(row[1], 16) !== 0) || sparse.some(value => value !== 'false')) {
    throw new Error('native_index_state_unsupported');
  }
  return { tagged, debug, sparse, ignoreCase: run(['config', '--type=bool', '--default=false', '--get', 'core.ignoreCase']) };
}

const MAX_INDEX_PATHS = 10_000;
const MAX_INDEX_DIRECTORIES = 2_048;
const MAX_DIRECTORY_ENTRIES = 40_000;
const MAX_DIRECTORY_NAME_BYTES = 2 * 1024 * 1024;

async function directoryNames(root, full, budget) {
  if ((full !== root && !inside(root, full)) || await realpath(full) !== full) throw new Error('native_reserved_path');
  const before = await lstat(full);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('native_reserved_path');
  const handle = await opendir(full), exact = new Set(), folded = new Set();
  try {
    for (let n = 0; n <= MAX_DIRECTORY_ENTRIES; n++) {
      const entry = await handle.read();
      if (!entry) break;
      budget.count++; budget.bytes += Buffer.byteLength(entry.name);
      if (budget.count > MAX_DIRECTORY_ENTRIES || budget.bytes > MAX_DIRECTORY_NAME_BYTES) throw new Error('native_artifact_bound');
      exact.add(entry.name); folded.add(entry.name.normalize('NFC').toLowerCase());
    }
  } finally { await handle.close(); }
  const after = await lstat(full);
  if (fingerprint(before) !== fingerprint(after) || await realpath(full) !== full) throw new Error('native_artifact_changed');
  return { exact, folded };
}

export async function indexSpelling(root, index) {
  const entries = paths(index.tagged);
  if (entries.length > MAX_INDEX_PATHS) throw new Error('native_artifact_bound');
  const directories = new Map(), budget = { count: 0, bytes: 0 };
  for (const row of entries) {
    const parts = row.slice(2).split('/');
    if (parts.length > 64 || Buffer.byteLength(row) > 4096 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('native_reserved_path');
    let directory = root;
    for (let n = 0; n < parts.length; n++) {
      if (!directories.has(directory)) {
        if (directories.size >= MAX_INDEX_DIRECTORIES) throw new Error('native_artifact_bound');
        directories.set(directory, await directoryNames(root, directory, budget));
      }
      const names = directories.get(directory), part = parts[n];
      if (!names.exact.has(part)) {
        if (names.folded.has(part.normalize('NFC').toLowerCase())) throw new Error('native_index_state_unsupported');
        // Filesystems may equate other spellings too; an existing non-exact alias
        // is not a proven deletion, even when Git's case setting says otherwise.
        try { await lstat(resolve(directory, part)); throw new Error('native_index_state_unsupported'); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        break; // A real deletion is represented by the normal Git path list.
      }
      if (n < parts.length - 1) directory = resolve(directory, part);
    }
  }
}

