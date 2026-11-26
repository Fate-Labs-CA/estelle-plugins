import { join } from 'node:path';
import { hash, readJson, writeJson } from './io.mjs';

/** Antigravity's PreInvocation is the prompt event, and the docs do not promise it fires once per message. This is true
 *  once for each (invocation number, prompt) pair per conversation, so a repeat does not recall or capture twice. */
export async function freshInvocation(stateDir, n) {
  const key = hash(`${n.invocation ?? ''}:${n.prompt ?? ''}`);
  const path = join(stateDir, 'invocation', `${hash(`antigravity:${n.sessionId}`)}.json`);
  const seen = await readJson(path, 16_000).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (seen?.key === key) return false;
  await writeJson(path, { key });
  return true;
}
