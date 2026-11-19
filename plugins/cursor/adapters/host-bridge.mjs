// The in-process side shared by Estelle's OpenCode plugin and Pi extension. Both hosts run plugins inside their own
// process, so each event is handed to the same `runtime/cli.mjs hook <host>` runner every other host uses, in a child
// Node process: one runner, one key from the environment, and a failure there can never take the host down.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SERVER_URL = 'https://api.fatelabs.ca/mcp';
export const SERVER_NAME = 'Estelle';
// The runner's own deadline is 12 s for network work (runtime/io.mjs); this is the outer bound, as on the other hosts.
export const HOOK_TIMEOUT_MS = 20_000;
export const END_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_ASSET_FILES = 64;

/** The runner's JSON answer, or null. Never rejects: a hook that fails leaves its own status for `doctor`. */
export function runHook(host, payload, { root = PLUGIN_ROOT, env = process.env, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(env.ESTELLE_NODE || 'node', [join(root, 'runtime', 'cli.mjs'), 'hook', host],
        { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { resolve(null); return; }
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    // Stderr carries the write warning on every host; it is kept short and never parsed as an answer.
    child.stderr.on('data', chunk => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).at(-1);
      try { resolve(line ? JSON.parse(line) : null); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Text the runner asked this host to place in front of the model, or ''. */
export const contextOf = output => (typeof output?.additionalContext === 'string' ? output.additionalContext : '');
/** The write warning the runner attached, or ''. It never blocks the tool. */
export const warningOf = output => (typeof output?.warning === 'string' ? output.warning : '');

async function markdownFiles(directory) {
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.md')).sort();
  return names.slice(0, MAX_ASSET_FILES);
}

/** The shared Estelle commands (commands/*.md), with the runner path these hosts can name exactly. */
export async function readCommands(root = PLUGIN_ROOT) {
  const cli = join(root, 'runtime', 'cli.mjs');
  const out = [];
  for (const file of await markdownFiles(join(root, 'commands'))) {
    const source = await readFile(join(root, 'commands', file), 'utf8');
    const [, description, body] = /^---\ndescription: (.+)\n---\n([\s\S]+)$/.exec(source) ?? [];
    if (!description) continue;
    out.push({ name: file.replace(/\.md$/, ''), description,
      template: body.replaceAll('<Estelle cli.mjs>', cli.replaceAll('"', '\\"')) });
  }
  return out;
}

/** The shared Estelle agents (agents/*.md): name, description and the prompt body. Their tool lists name Claude
 *  Code's tools, so they are not carried; each host gives the agent its own tools. */
export async function readAgents(root = PLUGIN_ROOT) {
  const out = [];
  for (const file of await markdownFiles(join(root, 'agents'))) {
    const source = await readFile(join(root, 'agents', file), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source);
    if (!match) continue;
    const field = key => new RegExp(`^${key}: (.+)$`, 'm').exec(match[1])?.[1]?.trim() ?? '';
    if (field('name') && field('description')) out.push({ name: field('name'), description: field('description'), prompt: match[2].trim() });
  }
  return out;
}

export const readInstructions = (root = PLUGIN_ROOT) => readFile(join(root, 'instructions.md'), 'utf8');
