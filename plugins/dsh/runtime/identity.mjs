// Shared public timeline identity. This is a name, never a Rooms write credential.
const HARNESSES = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex',
  kimi: 'kimi-code', 'kimi-code': 'kimi-code', grok: 'grok', cursor: 'cursor',
  dsh: 'deepseek-harness', 'deepseek-harness': 'deepseek-harness' };
export function canonicalHost(host) {
  const value = HARNESSES[host];
  if (!value) throw new Error('unsupported_host');
  return value;
}
export function cloudExecutionIdentity(env = process.env) {
  const value = env.ESTELLE_EXECUTION_SESSION_ID;
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^ade-launch-[a-f0-9]{16}$/.test(value)) throw new Error('cloud_execution_identity_invalid');
  return value;
}
export function timelineIdentity(host, session, env = process.env) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw new Error('session_missing');
  const canonical = canonicalHost(host);
  return cloudExecutionIdentity(env) || `${canonical}-${session}`;
}
