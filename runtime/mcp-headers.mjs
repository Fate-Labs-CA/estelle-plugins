import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { repository } from './io.mjs';

// The repository the HOST was started in, as the one header Estelle's server reads (`X-Estelle-Repo`) so that a memory
// tool called without a repo answers about this checkout instead of asking "which repo?" over every repo the account has.
//
// Claude Code runs this as the plugin server's `headersHelper`. It starts the helper in the PLUGIN's directory, not the
// project's, and passes no project variable, so the helper's own cwd says nothing. Its parent process is Claude Code (or
// the `sh` it used, whose cwd is the plugin's), and that process's cwd is the project. Anything that cannot be read gives
// `{}`: no header, which is exactly the connection a host without this helper makes. It never prints a path or an error.
const LOOKUP_MS = 1500;
const MAX_ANCESTORS = 3;

function runText(command, args, run) {
  return run(command, args, { encoding: 'utf8', timeout: LOOKUP_MS, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The working directory of process `pid`, or '' when this platform or permission does not say. */
export function cwdOfProcess(pid, { platform = process.platform, readlink = readlinkSync, run = execFileSync } = {}) {
  try {
    if (platform === 'linux') return readlink(`/proc/${pid}/cwd`);
    if (platform === 'darwin') {
      const line = runText('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], run).split('\n').find(row => row.startsWith('n'));
      return line ? line.slice(1) : '';
    }
  } catch { /* unreadable: no answer */ }
  return '';
}

function parentOf(pid, run) {
  try { return Number(runText('ps', ['-o', 'ppid=', '-p', String(pid)], run).trim()) || 0; } catch { return 0; }
}

const inside = (child, parent) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

/** The first ancestor process working in a git checkout that is not the plugin's own directory. */
export function hostRepository({ env = process.env, pid = process.ppid, run = execFileSync, cwdOf = cwdOfProcess,
  repo = repository } = {}) {
  let current = pid;
  for (let depth = 0; current > 1 && depth < MAX_ANCESTORS; depth += 1) {
    const cwd = cwdOf(current, { run });
    const own = env.CLAUDE_PLUGIN_ROOT && cwd && inside(cwd, env.CLAUDE_PLUGIN_ROOT);
    const found = cwd && !own ? repo(cwd, env) : null;
    if (found) return found;
    current = parentOf(current, run);
  }
  return null;
}

/** `{ 'X-Estelle-Repo': 'owner/name' }`, or `{}` when no checkout is known. `ESTELLE_REPO` wins when set. */
export function mcpRepoHeaders(options = {}) {
  const env = options.env ?? process.env;
  const found = env.ESTELLE_REPO && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.ESTELLE_REPO)
    ? { name: env.ESTELLE_REPO } : hostRepository({ ...options, env });
  return found ? { 'X-Estelle-Repo': found.name } : {};
}
