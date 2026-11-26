import { mkdir, writeFile, opendir, lstat, rmdir, rename, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { readJson, writeJson } from './io.mjs';

const CLAIM_ATTEMPTS = 20;
const CLAIM_RETRY_MS = 5;

export async function beginContext(path, turnId) {
  const requestId = randomUUID();
  await writeJson(path, { turnId, requestId, text: null });
  return requestId;
}

async function removeEmpty(path) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    try { await rmdir(path); return; }
    catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return;
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt === CLAIM_ATTEMPTS - 1) throw error;
    }
    await setTimeout(CLAIM_RETRY_MS);
  }
}

// Idempotent cleanup only; dead-owner election must keep its raw unlink winner check.
async function unlinkOwned(path) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    try { await unlink(path); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt === CLAIM_ATTEMPTS - 1) throw error;
    }
    await setTimeout(CLAIM_RETRY_MS);
  }
}

async function releaseGuard(path, owner) {
  await unlinkOwned(`${path}/${owner}`);
  await removeEmpty(path);
}

async function guardOwner(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const directory = await opendir(path, { bufferSize: 2 });
  const names = [];
  // A legitimate published guard has exactly one regular PID+opaque-token owner.
  // Look at at most two entries; never enumerate or recursively remove unknown state.
  for await (const entry of directory) {
    if (!entry.isFile() || entry.isSymbolicLink() || names.length === 1) return null;
    names.push(entry.name);
  }
  if (!names.length) return '';
  const match = /^([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.owner$/.exec(names[0]);
  if (!match || Number(match[1]) > 2_147_483_647) return null;
  return { name: names[0], pid: Number(match[1]) };
}

async function reclaimGuard(path) {
  let owner;
  try { owner = await guardOwner(path); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (owner === '') { await removeEmpty(path); return true; }
  if (!owner) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') return true; }
  // Only the unlink winner may attempt rmdir. A stale observer must not remove
  // a replacement owner; its different opaque filename makes this unlink fail.
  try { await unlink(`${path}/${owner.name}`); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  await removeEmpty(path);
  return true;
}

async function guardedRename(path, claimed) {
  const guard = `${path}.claim-lock`;
  const token = randomUUID();
  const candidate = `${path}.${token}.claim-candidate`;
  const owner = `${process.pid}.${token}.owner`;
  try { await mkdir(candidate, { mode: 0o700 }); }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  let published = false;
  try {
    await writeFile(`${candidate}/${owner}`, '', { flag: 'wx', mode: 0o600 });
    try { await rename(candidate, guard); published = true; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      let observed;
      try { observed = await reclaimGuard(guard); }
      catch (inspectionError) {
        if (!['EPERM', 'EACCES'].includes(inspectionError.code)) throw inspectionError;
        return { error: inspectionError };
      }
      // Windows may report a conflict just before its owner removes the guard.
      // Retry that ambiguity, but retain a persistent permission error verbatim.
      if (!observed && ['EPERM', 'EACCES'].includes(error.code)) return { error };
      return 'busy';
    }
    try { await rename(path, claimed); return 'claimed'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return 'missing'; }
    finally { await releaseGuard(guard, owner); }
  } finally {
    if (!published) {
      await unlinkOwned(`${candidate}/${owner}`);
      await removeEmpty(candidate);
    }
  }
}

async function claim(path, retry) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const claimed = `${path}.${randomUUID()}.claimed`;
    const result = await guardedRename(path, claimed);
    if (result === 'claimed') return claimed;
    if (result === 'missing' && !retry) return null;
    if (result === 'busy' && attempt === CLAIM_ATTEMPTS - 1) throw new Error('context_claim_locked');
    if (typeof result === 'object' && attempt === CLAIM_ATTEMPTS - 1) throw result.error;
    await setTimeout(CLAIM_RETRY_MS);
  }
  return null;
}

async function restore(claimed, path) {
  // An intervening new prompt owns the path. Never replace it with an older result.
  try { await link(claimed, path); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
}

export async function saveContext(path, turnId, requestId, text, degraded = false) {
  const claimed = await claim(path, true);
  if (!claimed) return false;
  try {
    const stored = await readJson(claimed);
    const matches = stored.turnId === turnId && stored.requestId === requestId;
    if (matches) await writeJson(claimed, { ...stored, text, degraded: degraded === true });
    const restored = await restore(claimed, path);
    return matches && restored;
  } finally { await unlink(claimed); }
}

export async function takeContext(path, turnId) {
  if (!turnId) return null;
  const claimed = await claim(path, false);
  if (!claimed) return null;
  try {
    const stored = await readJson(claimed);
    if (stored.turnId === turnId && typeof stored.text === 'string' && stored.text) return { text: stored.text, degraded: stored.degraded === true };
    await restore(claimed, path);
    return null;
  } finally { await unlink(claimed); }
}
