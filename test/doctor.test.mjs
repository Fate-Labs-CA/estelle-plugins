import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkKey } from '../runtime/key-check.mjs';

const CLI = resolve(import.meta.dirname, '..', 'runtime', 'cli.mjs');
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
const OK = { jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } };

test('checkKey tells apart the answers a person has to act on differently', async () => {
  const cases = [[reply(200, OK), 'accepted'], [reply(401, {}), 'rejected'], [reply(402, {}), 'account_refused'],
    [reply(200, { error: { code: -32001 } }), 'rejected'], [reply(200, { error: { code: -32002 } }), 'account_refused'],
    [reply(503, {}), 'server_unavailable'], [reply(200, { nope: 1 }), 'unexpected_response'],
    [async () => { throw new Error('no route'); }, 'unreachable']];
  for (const [fetchImpl, expected] of cases) assert.equal(await checkKey('fixture-key', { fetchImpl }), expected);
});

test('a malformed key is never sent', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent++; return new Response('{}'); };
  assert.equal(await checkKey('bad\nkey', { fetchImpl }), 'malformed');
  assert.equal(sent, 0);
});

test('a reply past the read cap could not be checked, rather than being parsed in part', async () => {
  const fetchImpl = async () => new Response('x'.repeat(40000), { status: 200 });
  assert.equal(await checkKey('fixture-key', { fetchImpl }), 'unreachable');
});

async function doctor(t, env, handler, cli = CLI) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const data = await mkdtemp(join(tmpdir(), 'estelle-doctor-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  return new Promise(done => execFile(process.execPath, [cli, 'doctor'], { env: { PATH: process.env.PATH,
    ESTELLE_PLUGIN_DATA: data, ESTELLE_API_URL: `http://127.0.0.1:${server.address().port}`, ...env } },
  (error, stdout) => done({ code: error?.code ?? 0, output: stdout, json: JSON.parse(stdout) })));
}

const answer = (status, body) => (request, response) => {
  request.resume();
  request.on('end', () => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); });
};

test('doctor exits clean on a key the server accepts and red on a present key it rejects', async t => {
  const good = await doctor(t, { ESTELLE_API_KEY: 'fixture-key' }, answer(200, OK));
  assert.equal(good.code, 0);
  assert.equal(good.json.key_check, 'accepted');
  const bad = await doctor(t, { ESTELLE_API_KEY: 'fixture-key' }, answer(401, {}));
  assert.equal(bad.code, 1, 'presence alone used to exit 0 here');
  assert.equal(bad.json.credential, 'environment');
  assert.equal(bad.json.key_check, 'rejected');
  assert.match(bad.json.key_message, /rejected.*401/);
  assert(!bad.output.includes('fixture-key'));
});

test('doctor with no key sends nothing and says capture is off', async t => {
  let requests = 0;
  const result = await doctor(t, {}, (request, response) => { requests++; response.end(); });
  assert.equal(requests, 0);
  assert.equal(result.code, 1);
  assert.equal(result.json.key_check, 'not_checked_no_key');
  assert.match(result.json.key_message, /capture is off/);
});

const CREDENTIAL = { [['ESTELLE', 'API', 'KEY'].join('_')]: 'fixture' };
const CODEX_CLI = resolve(import.meta.dirname, '..', 'plugins', 'codex', 'runtime', 'cli.mjs');

/** A directory holding a `codex` that answers initialize and hooks/list with one hook in this trust state. */
async function fakeCodex(t, trustStatus) {
  const directory = await mkdtemp(join(tmpdir(), 'estelle-fake-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = { pluginId: 'estelle@estelle-plugins', trustStatus, enabled: true };
  await writeFile(join(directory, 'codex'), `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const { id } = JSON.parse(line);
  if (id === 1) console.log(JSON.stringify({ id, result: {} }));
  if (id === 2) console.log(JSON.stringify({ id, result: { data: [{ hooks: [${JSON.stringify(hook)}] }] } }));
});`, { mode: 0o755 });
  return directory;
}

test('the Codex package fails doctor unless Codex says its hooks will run', { skip: process.platform === 'win32' }, async t => {
  const trusted = await doctor(t, { ...CREDENTIAL, PATH: await fakeCodex(t, 'trusted') }, answer(200, OK), CODEX_CLI);
  assert.equal(trusted.json.codex_hooks.status, 'trusted');
  assert.equal(trusted.code, 0);
  const modified = await doctor(t, { ...CREDENTIAL, PATH: await fakeCodex(t, 'modified') }, answer(200, OK), CODEX_CLI);
  assert.equal(modified.json.codex_hooks.status, 'review_required');
  assert.match(modified.json.codex_hooks.next_step, /Run \/hooks in Codex and press t/);
  assert.equal(modified.code, 1);
});

test('an unmeasured Codex is not a pass: with no codex to ask, doctor says so and fails', async t => {
  const empty = await mkdtemp(join(tmpdir(), 'estelle-no-codex-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const result = await doctor(t, { ...CREDENTIAL, PATH: empty }, answer(200, OK), CODEX_CLI);
  assert.equal(result.json.key_check, 'accepted');
  assert.equal(result.json.codex_hooks.status, 'unavailable');
  assert.equal(result.code, 1);
});

test('other packages never start Codex and carry no Codex field', async t => {
  const result = await doctor(t, CREDENTIAL, answer(200, OK));
  assert.equal(Object.hasOwn(result.json, 'codex_hooks'), false);
  assert.equal(result.code, 0);
});

test('doctor that could not reach the server does not call the key good or bad', async t => {
  const result = await doctor(t, { ESTELLE_API_KEY: 'fixture-key' }, answer(503, {}));
  assert.equal(result.code, 1);
  assert.equal(result.json.key_check, 'server_unavailable');
  assert.match(result.json.key_message, /says nothing about the key/);
});

test('doctor with a capture grant and a foreign API URL names the capture problem and still checks the key state', async t => {
  if (process.platform === 'win32') return;
  const home = await mkdtemp(join(tmpdir(), 'estelle-doctor-capture-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.estelle-plugins', 'capture-auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(home, '.estelle-plugins'), 0o700);
  await writeFile(join(directory, 'credential.json'), JSON.stringify({ schema: 1, issuer: 'https://api.fatelabs.ca',
    client_id: 'https://api.fatelabs.ca/oauth/clients/plugin', resource: 'https://api.fatelabs.ca/mcp',
    scope: 'estelle:mcp estelle:capture offline_access', access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
    expires_at: 4102444800, partition: 'a'.repeat(32), state: 'active' }), { mode: 0o600 });
  const result = await doctor(t, { HOME: home }, (request, response) => response.end());
  assert.equal(result.json.capture_auth, 'capture_origin');
  assert.equal(result.json.key_check, 'not_checked_no_key');
  assert.equal(result.code, 1);
  assert(!result.output.includes('synthetic-'));
});
