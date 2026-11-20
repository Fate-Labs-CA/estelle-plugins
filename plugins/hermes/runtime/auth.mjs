import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usable = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && /^[\x21-\x7e]+$/.test(value);

/** Migration helper only. Native hooks and MCP share the canonical inherited environment key. */
export async function launchCredential(env = process.env, home = homedir()) {
  const inherited = env.ESTELLE_API_KEY || env.ESTELLE_KEY;
  if (inherited) return usable(inherited) ? inherited : null;
  const file = await open(join(home, '.estelle', 'auth.json'), 'r').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_000 || (process.platform !== 'win32' && (info.mode & 0o077))) return null;
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) return null;
    const stored = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return usable(stored.key) ? stored.key : null;
  } catch { return null; }
  finally { await file.close(); }
}
