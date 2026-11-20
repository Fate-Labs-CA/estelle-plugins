// Estelle's MCP tools from a shell, for hosts whose only tool is bash (mini-swe-agent). `node runtime/cli.mjs mcp tools`
// lists the tools; `node runtime/cli.mjs mcp call <tool> '<json>'` calls one and prints its text. It speaks streamable HTTP
// to the same server every other host uses, with the same ESTELLE_API_KEY, and never prints the key.
import { apiBase } from './io.mjs';
import { VERSION } from './version.mjs';

const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_ARGUMENT_BYTES = 200_000;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function mcpUrl(env = process.env) {
  if (!env.ESTELLE_MCP_URL) return `${apiBase(env)}/mcp`;
  // Same rule as the hook API: https, or http only to this machine.
  const url = new URL(env.ESTELLE_MCP_URL);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('invalid_mcp_url');
  return url.href;
}

/** The JSON-RPC message in a response body: plain JSON, or the first `data:` event of an SSE stream that carries `id`. */
export function rpcMessage(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const message = JSON.parse(line.slice(5));
    if (message?.id === id) return message;
  }
  throw new Error('mcp_no_response');
}

async function bounded(response) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('mcp_response_size');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}

/** One MCP client session: initialize, then requests. `fetchImpl` is injectable so tests drive a real server or a stub. */
export function mcpSession({ env = process.env, fetchImpl = fetch } = {}) {
  const key = env.ESTELLE_API_KEY;
  if (!key || /[\r\n]/.test(key)) throw new Error('credential_missing');
  const url = mcpUrl(env);
  let session = null;
  let next = 0;
  async function post(method, params, notification = false) {
    const id = notification ? undefined : ++next;
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL,
      ...(session ? { 'Mcp-Session-Id': session } : {}) };
    const response = await fetchImpl(url, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id }) }) });
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await bounded(response);
    if (response.status === 401) throw new Error('credential_rejected');
    if (!response.ok) throw new Error(`mcp_http_${response.status}`);
    if (notification) return null;
    const message = rpcMessage(text, id);
    if (message.error) throw new Error(`mcp_error: ${String(message.error.message ?? message.error.code).slice(0, 300)}`);
    return message.result;
  }
  let ready;
  const start = () => (ready ??= post('initialize', { protocolVersion: PROTOCOL, capabilities: {},
    clientInfo: { name: 'estelle-plugins-shell', version: VERSION } }).then(() => post('notifications/initialized', null, true)));
  return {
    async tools() { await start(); return (await post('tools/list', {}))?.tools ?? []; },
    async call(name, args) { await start(); return post('tools/call', { name, arguments: args }); },
  };
}

/** The printed answer of a tool call: its text blocks, then any structured content. */
export function resultText(result) {
  const text = (result?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
  const structured = result?.structuredContent && !text ? JSON.stringify(result.structuredContent, null, 2) : '';
  return [text || structured, result?.isError ? '(the tool reported an error)' : ''].filter(Boolean).join('\n');
}

/** `mcp tools` or `mcp call <tool> [json]`. Returns the text to print; throws a short code on failure. */
export async function runMcpCommand(argv, options = {}) {
  const [action, name, raw] = argv;
  const client = mcpSession(options);
  if (action === 'tools') {
    return (await client.tools()).map(tool => `${tool.name}: ${String(tool.description ?? '').split('\n')[0].slice(0, 200)}`).join('\n');
  }
  if (action !== 'call' || !TOOL_NAME.test(name ?? '')) throw new Error('usage');
  if (raw && Buffer.byteLength(raw) > MAX_ARGUMENT_BYTES) throw new Error('arguments_size');
  let args;
  try { args = raw ? JSON.parse(raw) : {}; } catch { throw new Error('arguments_json'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments_json');
  return resultText(await client.call(name, args));
}
