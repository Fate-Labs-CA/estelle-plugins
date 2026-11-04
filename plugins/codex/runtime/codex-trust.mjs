/** Read whether Codex will run Estelle's hooks. Read-only: hook approval belongs to the person, in Codex. */
import { spawn } from 'node:child_process';

const PLUGIN_ID = 'estelle@estelle-plugins';
const DEADLINE_MS = 8_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_HOOK_ROWS = 64;

export const REVIEW_STEP = 'Codex turned off Estelle\'s hooks because the plugin changed. Run /hooks in Codex and press t, '
  + 'or choose "Trust all and continue" the next time Codex starts. Until then Estelle captures nothing from this '
  + 'machine and does not check file writes for credentials.';

/** Counts by Codex's own trust status. A hook that is not trusted does not run. */
export function summarizeHooks(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_HOOK_ROWS) return { status: 'unavailable' };
  const ours = rows.filter(row => row?.pluginId === PLUGIN_ID);
  if (!ours.length) return { status: 'not_installed' };
  const needs = ours.filter(row => row.enabled !== false && !['trusted', 'managed'].includes(row.trustStatus)).length;
  const result = { status: needs ? 'review_required' : 'trusted', hooks: ours.length, needs_review: needs };
  return needs ? { ...result, next_step: REVIEW_STEP } : result;
}

/** Codex's documented hooks/list over a private app-server, closed before returning. Never approves. */
export function codexHookTrust(cwd = process.cwd(), { spawnImpl = spawn, deadlineMs = DEADLINE_MS, env = process.env } = {}) {
  return new Promise(resolve => {
    let child;
    let bytes = 0;
    let buffer = '';
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return finish({ status: 'unavailable' });
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let row;
        try { row = JSON.parse(line); } catch { return finish({ status: 'unavailable' }); }
        if (row.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
        } else if (row.id === 2) finish(summarizeHooks(row.result?.data?.[0]?.hooks));
      }
      return undefined;
    };
    timer = setTimeout(() => finish({ status: 'unavailable' }), deadlineMs);
    try {
      child = spawnImpl('codex', ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.on('error', () => finish({ status: 'unavailable' }));
      child.on('exit', () => finish({ status: 'unavailable' }));
      child.stdin.on('error', () => finish({ status: 'unavailable' }));
      child.stdout.on('data', receive);
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'estelle-plugin-doctor', version: '1' } } });
    } catch { finish({ status: 'unavailable' }); }
  });
}
