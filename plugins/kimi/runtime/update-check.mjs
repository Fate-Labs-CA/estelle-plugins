// Tell the person once a day when this plugin is behind the release the server advertises (issue #2156).
// Claude Code does not auto-update a third-party marketplace unless the person turns that on, so an install can sit
// on an old release unnoticed. Bounded (1.5 s), silent on any failure, and never a decision: it only adds a line.
import { join } from 'node:path';
import { VERSION } from './version.mjs';
import { apiBase, readJson, writeJson } from './io.mjs';

export const CHECK_TIMEOUT_MS = 1500;
export const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;   // after a failed check, ask again in an hour, not at the next session
const MAX_BODY = 4096;
const SOURCE = 'https://github.com/Fate-Labs-CA/estelle-plugins';

/** `[major, minor, patch]` for `0.0.24`, or null. */
export function parseVersion(value) {
  const match = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? match.slice(1).map(Number) : null;
}

/** Whether `have` is older than `latest`. An unreadable version is not behind. */
export function isBehind(have, latest) {
  const a = parseVersion(have), b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The exact update steps for one host, each taken from that host's install guide in docs/install/. */
export function updateSteps(host, latest) {
  switch (host) {
    case 'claude-code':
      return 'Run `/plugin marketplace update estelle-plugins` then `/plugin update estelle@estelle-plugins`, or turn on auto-update in /plugin.';
    case 'codex':
      return 'Run `codex plugin marketplace upgrade estelle-plugins`, reinstall Estelle, then approve its hooks again.';
    case 'cursor':
      return 'Update Estelle from the Customize page, then run Developer: Reload Window.';
    case 'kimi':
      return 'Run `/plugins remove estelle`, `/reload`, `/plugins install https://github.com/Fate-Labs-CA/estelle-plugins`, then `/reload`.';
    case 'grok':
      return `Run \`grok plugin install Fate-Labs-CA/estelle-plugins@v${latest}#plugins/grok\`, then start a fresh session.`;
    case 'qwen-code':
      return 'Pull your estelle-plugins clone, run `qwen extensions install ./estelle-plugins/plugins/qwen`, then restart Qwen Code.';
    case 'opencode':
      return 'Run `opencode plugin @fatelabs/opencode-estelle -g`, then restart OpenCode.';
    case 'hermes':
      return 'Run `hermes plugins install Fate-Labs-CA/estelle-plugins/plugins/hermes --enable`, then restart Hermes.';
    case 'pi':
      return 'Run `pi install npm:@fatelabs/pi-estelle`, then restart Pi or run /reload.';
    default:
      return `Update it from ${SOURCE} (see docs/install for your host).`;
  }
}

export function noticeLine(host, have, latest) {
  return `Estelle plugin ${have} is behind ${latest}. ${updateSteps(host, latest)}`;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  for (let reads = 0; reads < MAX_BODY; reads++) {
    const { done, value } = await reader.read();
    if (done) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bytes += value.length;
    if (bytes > MAX_BODY) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return null;
}

async function fetchLatest(host, { env, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${apiBase(env)}/plugin/latest`, { redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json',
      'X-Estelle-Client-Version': `estelle-plugins/${VERSION}` } });
  if (!response.ok) return null;
  const body = await boundedJson(response);
  const latest = body?.hosts?.[host] ?? body?.latest;
  return parseVersion(latest) ? latest : null;
}

/** The one-line notice, or null. At most one network read and one notice per 24 h per host; the state is a small file in
 *  the plugin's state dir. `ESTELLE_PLUGIN_UPDATE_CHECK=0` turns the whole thing off. */
export async function updateNotice({ host, stateDir, env = process.env, fetchImpl = fetch, now = Date.now(),
  timeoutMs = CHECK_TIMEOUT_MS, current = VERSION }) {
  if (env.ESTELLE_PLUGIN_UPDATE_CHECK === '0') return null;
  const path = join(stateDir, `update-check-${/^[a-z-]+$/.test(host) ? host : 'unknown'}.json`);
  const state = await readJson(path).catch(() => ({}));
  const at = value => (Number.isFinite(value) ? value : 0);
  if (now - at(state.shownAt) < DAY_MS && state.shownFor === current) return null;
  let next = state;
  let latest = parseVersion(state.latest) && now - at(state.checkedAt) < DAY_MS ? state.latest : null;
  if (!latest && !(state.failedAt && now - at(state.failedAt) < RETRY_MS)) {
    try { latest = await fetchLatest(host, { env, fetchImpl, timeoutMs }); } catch { latest = null; }
    next = latest ? { ...state, latest, checkedAt: now, failedAt: undefined } : { ...state, failedAt: now };
    await writeJson(path, next).catch(() => {});
  }
  if (!latest || !isBehind(current, latest)) return null;
  await writeJson(path, { ...next, shownAt: now, shownFor: current }).catch(() => {});
  return noticeLine(host, current, latest);
}
