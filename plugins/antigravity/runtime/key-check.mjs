/** Ask the server whether a key works, with a method that spends nothing. Reports a word, never the key or a body. */
const CAP = 16384, TIMEOUT_MS = 8000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const usable = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  for (let reads = 0; reads < CAP; reads++) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    bytes += value.length;
    if (bytes > CAP) { await reader.cancel(); throw new Error('response_bound'); }
    chunks.push(value);
  }
  throw new Error('response_bound');
}

/** `accepted`, `rejected` (401), `account_refused` (a valid key the plan or balance stops), or a could-not-check word. */
export async function checkKey(key, { base = 'https://api.fatelabs.ca', fetchImpl = fetch, version = '0' } = {}) {
  if (!usable(key)) return 'malformed';
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'estelle-plugin-doctor', version } } });
  try {
    const response = await fetchImpl(`${base}/mcp`, { method: 'POST', redirect: 'error', body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
    if (response.status === 401) return 'rejected';
    if (response.status === 402) return 'account_refused';
    if (response.status !== 200) return 'server_unavailable';
    const reply = JSON.parse(await boundedText(response));
    if (reply?.error?.code === -32001) return 'rejected';
    if (reply?.error?.code === -32002) return 'account_refused';
    return object(reply?.result?.capabilities) ? 'accepted' : 'unexpected_response';
  } catch {
    return 'unreachable';
  }
}

export const KEY_MESSAGES = Object.freeze({
  not_checked_no_key: 'ESTELLE_API_KEY is not set, so session capture is off. Claude Code MCP signs in through /mcp and does not need it; other hosts do.',
  accepted: 'The server accepted ESTELLE_API_KEY.',
  rejected: 'The server rejected ESTELLE_API_KEY (HTTP 401). It is wrong, revoked or from another environment. Create a new key in your Estelle account, replace the old one, then quit and reopen your host app.',
  account_refused: 'The server knows this key, but the account behind it cannot use this right now. Check the plan and balance.',
  malformed: 'ESTELLE_API_KEY is set but is not a usable key. It is empty or contains spaces or line breaks.',
  server_unavailable: 'The key could not be checked because the server did not answer normally. This says nothing about the key.',
  unexpected_response: 'The key could not be checked because the server sent an unexpected reply. This says nothing about the key.',
  unreachable: 'The key could not be checked because the server could not be reached. This says nothing about the key.',
});
