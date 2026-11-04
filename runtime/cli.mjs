#!/usr/bin/env node
import { readFile, opendir } from 'node:fs/promises';
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
  const keyPresent = Boolean(process.env.ESTELLE_API_KEY);
  // Presence is not validity: a revoked key is present. Anything but `accepted` is not a pass.
  const keyCheck = keyPresent ? await checkKey(process.env.ESTELLE_API_KEY, { base: api, version: VERSION }) : 'not_checked_no_key';
  console.log(JSON.stringify({ version: VERSION, node: process.version, api,
    credential: keyPresent ? 'environment' : 'missing', key_check: keyCheck,
    ...(KEY_MESSAGES[keyCheck] ? { key_message: KEY_MESSAGES[keyCheck] } : {}),
    status: await status(stateDirectory()) }, null, 2));
  if (keyCheck !== 'accepted') process.exitCode = 1;
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
    const output = await handleHook({ host, payload, stateDir: stateDirectory(), request: apiClient() });
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
} else if (command === 'continue-cloud') {
  try {
    const { runNativeContinue } = await import('./native-export.mjs');
    console.log(JSON.stringify(await runNativeContinue(process.argv.slice(3))));
  } catch (error) {
    const { nativeErrorCode } = await import('./native-export.mjs');
    console.error(`Native continuation could not be completed (${nativeErrorCode(error)}). No safe-to-close acknowledgment was issued.`);
    process.exitCode = 1;
  }
} else if (command === 'setup') {
  try {
    const { runSetupArgs } = await import('./setup.mjs');
    const result = await runSetupArgs(process.argv.slice(3));
    console.log(JSON.stringify(result));
    if (!['planned', 'applied', 'unchanged'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: 'pending_setup_unavailable' }));
    process.exitCode = 1;
  }
} else {
  console.error('Usage: node runtime/cli.mjs hook <claude-code|codex|kimi|grok|cursor> | doctor | setup <host> [--apply] [--expect SHA256]');
  process.exitCode = 1;
}
