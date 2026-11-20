import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mcpUrl, rpcMessage, runMcpCommand } from '../runtime/mcp-call.mjs';

const root = resolve(import.meta.dirname, '..');
const KEY = 'est_fixture_key';

/** A strict streamable-HTTP server: SSE for initialize, a session id required afterwards, 401 without the key. */
async function server(t) {
  const seen = [];
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      seen.push({ method: message.method, session: req.headers['mcp-session-id'] ?? null, accept: req.headers.accept });
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('{}'); return; }
      if (!/application\/json/.test(req.headers.accept) || !/text\/event-stream/.test(req.headers.accept)) { res.writeHead(406).end(); return; }
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } })}\n\n`);
        return;
      }
      if (req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(400).end('{}'); return; }
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      const result = message.method === 'tools/list'
        ? { tools: [{ name: 'verify', description: 'Check a symbol.\nMore.' }, { name: 'estelle_grep', description: 'Search.' }] }
        : { content: [{ type: 'text', text: `called ${message.params.name} with ${JSON.stringify(message.params.arguments)}` }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => http.close(done)));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, seen };
}

test('lists and calls Estelle tools over streamable HTTP, carrying the session id after initialize', async t => {
  const { url, seen } = await server(t);
  const env = { ESTELLE_API_KEY: KEY, ESTELLE_MCP_URL: url };
  assert.equal(await runMcpCommand(['tools'], { env }), 'verify: Check a symbol.\nestelle_grep: Search.');
  assert.equal(await runMcpCommand(['call', 'verify', '{"symbol":"main"}'], { env }), 'called verify with {"symbol":"main"}');
  assert.deepEqual(seen.map(row => [row.method, row.session]), [['initialize', null], ['notifications/initialized', 'sess-1'],
    ['tools/list', 'sess-1'], ['initialize', null], ['notifications/initialized', 'sess-1'], ['tools/call', 'sess-1']]);
});

test('refuses without a key, names a rejected key, and checks arguments before any request', async t => {
  const { url, seen } = await server(t);
  await assert.rejects(runMcpCommand(['tools'], { env: { ESTELLE_MCP_URL: url } }), { message: 'credential_missing' });
  await assert.rejects(runMcpCommand(['tools'], { env: { ESTELLE_API_KEY: 'wrong', ESTELLE_MCP_URL: url } }), { message: 'credential_rejected' });
  const before = seen.length;
  await assert.rejects(runMcpCommand(['call', 'verify', '{bad'], { env: { ESTELLE_API_KEY: KEY, ESTELLE_MCP_URL: url } }), { message: 'arguments_json' });
  await assert.rejects(runMcpCommand(['call', 'verify', '[1]'], { env: { ESTELLE_API_KEY: KEY, ESTELLE_MCP_URL: url } }), { message: 'arguments_json' });
  await assert.rejects(runMcpCommand(['call', '../x'], { env: { ESTELLE_API_KEY: KEY, ESTELLE_MCP_URL: url } }), { message: 'usage' });
  assert.equal(seen.length, before);
});

test('the endpoint is the hosted server by default, and only https or this machine otherwise', () => {
  assert.equal(mcpUrl({}), 'https://api.fatelabs.ca/mcp');
  assert.equal(mcpUrl({ ESTELLE_MCP_URL: 'http://127.0.0.1:9/mcp' }), 'http://127.0.0.1:9/mcp');
  assert.throws(() => mcpUrl({ ESTELLE_MCP_URL: 'http://example.com/mcp' }), /invalid_mcp_url/);
  assert.deepEqual(rpcMessage('event: message\ndata: {"id":2,"result":{}}\n\n', 2), { id: 2, result: {} });
  assert.throws(() => rpcMessage('data: {"id":1}\n', 2), /mcp_no_response/);
});

test('`cli.mjs mcp` is wired: the command prints the tools, and says what failed without printing the key', async t => {
  const { url } = await server(t);
  const run = env => new Promise(done => {
    const child = spawn(process.execPath, [join(root, 'runtime', 'cli.mjs'), 'mcp', 'tools'], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => done({ code, out, err }));
  });
  const ok = await run({ ESTELLE_API_KEY: KEY, ESTELLE_MCP_URL: url });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^verify: Check a symbol\./);
  const bad = await run({ ESTELLE_API_KEY: 'wrong-key-value', ESTELLE_MCP_URL: url });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /credential_rejected/);
  assert.doesNotMatch(bad.err + bad.out, /wrong-key-value/);
});

test('the mini-swe-agent config extends the default one and points the model at the bridge', async () => {
  const text = await readFile(join(root, 'plugins', 'mini-swe-agent', 'estelle.yaml'), 'utf8');
  assert.match(text, /^agent:\n  system_template: \|\n    You are a helpful assistant that can interact with a computer\.\n/m);
  assert.match(text, /node "\$ESTELLE_PLUGIN_ROOT\/runtime\/cli\.mjs" mcp tools/);
  assert.match(text, /mcp call <tool> '<json arguments>'/);
  assert.doesNotMatch(text, /instance_template|model:|environment:/, 'only the system prompt changes');
  await readFile(join(root, 'plugins', 'mini-swe-agent', 'runtime', 'mcp-call.mjs'));
});
