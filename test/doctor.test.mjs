import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function doctor(t, env, handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const data = await mkdtemp(join(tmpdir(), 'estelle-doctor-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  return new Promise(done => execFile(process.execPath, [CLI, 'doctor'], { env: { PATH: process.env.PATH,
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

test('doctor that could not reach the server does not call the key good or bad', async t => {
  const result = await doctor(t, { ESTELLE_API_KEY: 'fixture-key' }, answer(503, {}));
  assert.equal(result.code, 1);
  assert.equal(result.json.key_check, 'server_unavailable');
  assert.match(result.json.key_message, /says nothing about the key/);
});
