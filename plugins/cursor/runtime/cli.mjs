#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { apiBase, apiClient, errorCode, MAX_JSON_BYTES, readJson, recordStatus, stateDirectory } from './io.mjs';
import { checkKey, KEY_MESSAGES } from './key-check.mjs';
import { VERSION } from './version.mjs';

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw new Error('input_size');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('input_json'); }
}

async function status(stateDir) {
  let directory;
  try { directory = await opendir(join(stateDir, 'status')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  const MAX_STATUS_ROWS = 64;
  for await (const entry of directory) {
    if (rows.length >= MAX_STATUS_ROWS) break;
    if (!entry.isFile() || !/^[a-z-]+\.json$/.test(entry.name)) continue;
    rows.push(await readJson(join(stateDir, 'status', entry.name), 16_000));
  }
  return rows;
}

async function doctor() {
  const api = apiBase();
  // Capture-only sign-in is a separate, narrower credential; the canonical key wins when both exist.
  const { captureHookContext } = await import('./capture-auth.mjs');
  let capture = null;
  let captureError;
  try { capture = await captureHookContext(); } catch (error) { captureError = errorCode(error); }
  if (capture) {
    console.log(JSON.stringify({ version: VERSION, node: process.version, api,
      credential: 'capture_scoped', capture_auth: 'configured_not_probed', mcp_auth: 'not_probed',
      hook_execution: 'not_observed', automatic_pr_verification: 'not_available', work_metrics: 'not_available',
      status: await status(stateDirectory(process.env, capture.partition)) }, null, 2));
    return;
  }
  const keyPresent = Boolean(process.env.ESTELLE_API_KEY);
  // Presence is not validity: a revoked key is present. Anything but `accepted` is not a pass.
  const keyCheck = keyPresent ? await checkKey(process.env.ESTELLE_API_KEY, { base: api, version: VERSION }) : 'not_checked_no_key';
  // Only the Codex package asks Codex: nothing else should start an app-server on this machine.
  const codexHooks = existsSync(new URL('../.codex-plugin/plugin.json', import.meta.url))
    ? await (await import('./codex-trust.mjs')).codexHookTrust() : undefined;
  console.log(JSON.stringify({ version: VERSION, node: process.version, api,
    credential: keyPresent ? 'environment' : 'missing', ...(captureError ? { capture_auth: captureError } : {}), key_check: keyCheck,
    ...(KEY_MESSAGES[keyCheck] ? { key_message: KEY_MESSAGES[keyCheck] } : {}),
    ...(codexHooks ? { codex_hooks: codexHooks } : {}),
    status: await status(stateDirectory()) }, null, 2));
  // As with the key: not being able to tell that hooks will run is not a pass.
  if (keyCheck !== 'accepted' || (codexHooks && codexHooks.status !== 'trusted')) process.exitCode = 1;
}

const [command, host] = process.argv.slice(2);
if (command === 'doctor') {
  doctor().catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
} else if (command === 'hook') {
  let payload;
  // Optional integration failures must not abort a user's turn. They remain visible in doctor.
  try {
    payload = await readInput();
    const { handleHook } = await import('./hooks.mjs');
    const output = await handleHook({ host, payload, stateDir: stateDirectory(), request: apiClient(),
      requestContext: async () => {
        const { captureHookContext } = await import('./capture-auth.mjs');
        const capture = await captureHookContext();
        if (capture) return { ...capture, stateDir: stateDirectory(process.env, capture.partition) };
        // Only Claude Code has the one-step sign-in. Elsewhere the install doc already asks for a key.
        return host === 'claude-code' && !process.env.ESTELLE_API_KEY && process.platform !== 'win32' ? { signedOut: true } : null;
      } });
    if (output) console.log(JSON.stringify(output));
  } catch (error) {
    if (host === 'cursor') {
      const { defaultOutput } = await import('../adapters/cursor.mjs');
      const output = defaultOutput(payload?.hook_event_name);
      if (output) console.log(JSON.stringify(output));
    }
    try {
      const directory = stateDirectory({ ...process.env, ESTELLE_PLUGIN_DATA: undefined });
      await recordStatus(directory, { host: /^[a-z-]+$/.test(host || '') ? host : 'unknown',
        event: 'unknown', mode: 'runner', status: 'failed', code: errorCode(error) });
    } catch {
      console.error('Estelle could not save hook diagnostics. Check the plugin data directory permissions.');
    }
  }
} else if (command === 'move') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { moveCommand } = await import('./move.mjs');
  await moveCommand(host, Buffer.concat(chunks).toString('utf8'));
} else if (command === 'continue-cloud') {
  try {
    const { runNativeContinue } = await import('./native-export.mjs');
    console.log(JSON.stringify(await runNativeContinue(process.argv.slice(3))));
  } catch (error) {
    const { nativeErrorCode } = await import('./native-export.mjs');
    console.error(`Native continuation could not be completed (${nativeErrorCode(error)}). No safe-to-close acknowledgment was issued.`);
    process.exitCode = 1;
  }
} else if (command === 'dsh-telemetry') {
  // `dsh --profile <name> --dump-config | node runtime/cli.mjs dsh-telemetry`: the Silo's check on what dsh will mount.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { telemetryCheck, TELEMETRY_OFF } = await import('./dsh-telemetry.mjs');
  const verdict = telemetryCheck(Buffer.concat(chunks).toString('utf8'));
  console.log(verdict);
  if (verdict !== TELEMETRY_OFF) process.exitCode = 1;
} else if (command === 'mcp-headers') {
  // Always a JSON object and exit 0: anything else would stop Claude Code falling back to its own OAuth.
  let headers = {};
  try { headers = await (await import('./capture-auth.mjs')).mcpHeaders(); } catch { headers = {}; }
  console.log(JSON.stringify(headers));
} else if (command === 'setup') {
  try {
    const { runSetupArgs } = await import('./setup.mjs');
    const result = await runSetupArgs(process.argv.slice(3));
    console.log(JSON.stringify(result));
    if (!['planned', 'applied', 'unchanged', 'capture_configured', 'capture_already_configured',
      'capture_signed_out', 'capture_not_configured'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: 'pending_setup_unavailable' }));
    process.exitCode = 1;
  }
} else {
  console.error('Usage: node runtime/cli.mjs hook <claude-code|codex|kimi|grok|cursor|dsh> | doctor | setup <host> [--apply] [--expect SHA256] | setup <host> --login | setup <host> --logout');
  process.exitCode = 1;
}
