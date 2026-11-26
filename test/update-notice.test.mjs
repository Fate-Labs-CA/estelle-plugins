import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleHook } from '../runtime/hooks.mjs';
import { isBehind, noticeLine, updateNotice, DAY_MS } from '../runtime/update-check.mjs';
import { sendBatch } from '../runtime/stream.mjs';
import { VERSION } from '../runtime/version.mjs';

const OLD = '0.0.15';
const HOSTS = ['claude-code', 'codex', 'cursor', 'kimi', 'grok', 'qwen-code', 'gemini-cli', 'opencode', 'hermes', 'pi', 'dsh'];

async function state(t) {
  const dir = await mkdtemp(join(tmpdir(), 'estelle-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function server(latest = '0.0.24') {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ plugin: 'estelle-plugins', latest, hosts: { 'claude-code': latest, codex: latest } }),
      { status: 200 });
  };
  return { calls, fetchImpl };
}

/** The SessionStart payload each host really sends (the adapters' own normalizers accept them). */
const start = (host, dir) => {
  if (host === 'cursor') return { hook_event_name: 'sessionStart', conversation_id: 'upd-1', workspace_roots: [dir] };
  if (host === 'codex') return { session_id: 'upd-1', cwd: dir, hook_event_name: 'SessionStart', transcript_path: null, source: 'startup', model: 'm', permission_mode: 'default' };
  const name = { opencode: 'session.created', hermes: 'on_session_start', pi: 'session_start' }[host] ?? 'SessionStart';
  return { session_id: 'upd-1', cwd: dir, hook_event_name: name };
};
const quiet = async () => ({});
const run = (host, dir, srv, extra = {}) => handleHook({ host, payload: start(host, dir), stateDir: dir, request: quiet,
  update: { fetchImpl: srv.fetchImpl, current: OLD, env: { ESTELLE_API_URL: 'https://api.example.test' }, ...extra } });

test('Claude Code behind: systemMessage carries the exact update commands, once per day', async t => {
  const dir = await state(t);
  const srv = server();
  const out = await run('claude-code', dir, srv);
  assert.equal(out.systemMessage, `Estelle plugin ${OLD} is behind 0.0.24. Run \`/plugin marketplace update estelle-plugins\` then \`/plugin update estelle@estelle-plugins\`, or turn on auto-update in /plugin.`);
  assert.equal(srv.calls[0].url, 'https://api.example.test/plugin/latest');
  assert.equal(srv.calls[0].options.headers.Authorization, undefined, 'the check carries no credential');
  const again = await run('claude-code', dir, srv);
  assert.equal(again?.systemMessage, undefined, 'shown once per 24 h');
  assert.equal(srv.calls.length, 1, 'and asked of the server once per 24 h');
});

test('every host shows the line in its own place and the commands match its install guide', async t => {
  for (const host of HOSTS.filter(name => name !== 'kimi' && name !== 'grok')) {   // their stderr channel has its own test
    const dir = await state(t);
    const out = await run(host, dir, server());
    const text = JSON.stringify(out);
    const line = noticeLine(host, OLD, '0.0.24');
    assert.ok(text.includes(JSON.stringify(line).slice(1, -1)) || text.includes('behind 0.0.24'), `${host}: ${text}`);
    if (host === 'claude-code' || host === 'codex' || host === 'gemini-cli') assert.equal(out.systemMessage, line);
    if (host === 'cursor') assert.equal(out.user_message, line);
    if (host === 'pi') assert.equal(out.warning, line);
  }
  assert.match(noticeLine('codex', OLD, '0.0.24'), /codex plugin marketplace upgrade estelle-plugins/);
  assert.match(noticeLine('grok', OLD, '0.0.24'), /estelle-plugins@v0\.0\.24#plugins\/grok/);
  assert.match(noticeLine('gemini-cli', OLD, '0.0.24'), /gemini extensions install .*plugins\/gemini/);
});

test('hosts with no user channel get the line through the start context, Kimi through stderr', async t => {
  const dir = await state(t);
  assert.match(JSON.stringify(await run('opencode', dir, server())), /tell the person this once/);
  const written = [];
  const original = console.error;
  console.error = line => written.push(String(line));
  try {
    await run('kimi', await state(t), server());
    await run('grok', await state(t), server());
  } finally { console.error = original; }
  assert.equal(written.filter(line => line.includes('behind 0.0.24')).length, 2);
});

test('a current plugin says nothing', async t => {
  const dir = await state(t);
  const out = await run('claude-code', dir, server('0.0.15'));
  assert.equal(out?.systemMessage, undefined);
});

test('failure is silent and bounded: a hanging server costs at most the timeout, a refusal costs one retry window', async t => {
  const dir = await state(t);
  const hang = { calls: [], fetchImpl: (_url, options) => new Promise((_, reject) => {
    const keepAlive = setInterval(() => {}, 20);   // AbortSignal.timeout's own timer is unref'd, a real socket is not
    options.signal.addEventListener('abort', () => { clearInterval(keepAlive); reject(new Error('timeout')); });
  }) };
  const began = Date.now();
  const out = await run('claude-code', dir, hang, { timeoutMs: 80 });
  assert.equal(out?.systemMessage, undefined);
  assert.ok(Date.now() - began < 1500);
  const failing = { calls: [], fetchImpl: async () => { failing.calls.push(1); throw new Error('down'); } };
  await run('claude-code', dir, failing);
  assert.equal(failing.calls.length, 0, 'a failed check is not retried at the next session');
});

test('a bare handleHook (no update option) never touches the network', async t => {
  const dir = await state(t);
  const out = await handleHook({ host: 'claude-code', payload: start('claude-code', dir), stateDir: dir, request: quiet });
  assert.equal(out?.systemMessage, undefined);
});

test('the kill switch and non-SessionStart events skip it', async t => {
  const dir = await state(t);
  const srv = server();
  assert.equal(await updateNotice({ host: 'claude-code', stateDir: dir, fetchImpl: srv.fetchImpl, current: OLD, env: { ESTELLE_PLUGIN_UPDATE_CHECK: '0' } }), null);
  await handleHook({ host: 'claude-code', payload: { session_id: 'upd-1', cwd: dir, hook_event_name: 'Stop' }, stateDir: dir, request: quiet,
    update: { fetchImpl: srv.fetchImpl, current: OLD } });
  assert.equal(srv.calls.length, 0);
});

test('a day later it asks and tells again', async t => {
  const dir = await state(t);
  const srv = server();
  const t0 = Date.now();
  assert.ok(await updateNotice({ host: 'claude-code', stateDir: dir, fetchImpl: srv.fetchImpl, current: OLD, now: t0 }));
  assert.equal(await updateNotice({ host: 'claude-code', stateDir: dir, fetchImpl: srv.fetchImpl, current: OLD, now: t0 + 1000 }), null);
  assert.ok(await updateNotice({ host: 'claude-code', stateDir: dir, fetchImpl: srv.fetchImpl, current: OLD, now: t0 + DAY_MS + 1 }));
  assert.equal(srv.calls.length, 2);
});

test('a hostile or oversize server body is ignored', async t => {
  const dir = await state(t);
  const body = { fetchImpl: async () => new Response('x'.repeat(10_000), { status: 200 }) };
  assert.equal(await updateNotice({ host: 'claude-code', stateDir: dir, ...body, current: OLD }), null);
  const evil = { fetchImpl: async () => new Response(JSON.stringify({ latest: '9.9.9`; rm -rf ~' }), { status: 200 }) };
  assert.equal(await updateNotice({ host: 'claude-code', stateDir: await state(t), ...evil, current: OLD }), null);
});

test('version comparison reads numbers, not strings', () => {
  assert.equal(isBehind('0.0.9', '0.0.24'), true);
  assert.equal(isBehind('0.0.24', '0.0.24'), false);
  assert.equal(isBehind('0.1.0', '0.0.24'), false);
  assert.equal(isBehind('junk', '0.0.24'), false);
});

test('session event batches carry the plugin version and host', async () => {
  const sent = [];
  await sendBatch(async (route, body) => { sent.push({ route, body }); return {}; }, 's1', [{ event_id: 'e', kind: 'customer_message' }], 'codex');
  assert.equal(sent[0].body.plugin_version, VERSION);
  assert.equal(sent[0].body.host, 'codex');
});
