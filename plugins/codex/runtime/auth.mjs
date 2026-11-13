import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as privateFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

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

export const CAPTURE_AUTH = Object.freeze({ issuer:'https://api.fatelabs.ca',
 client:'https://api.fatelabs.ca/oauth/clients/plugin',
 resource:'https://api.fatelabs.ca/mcp', scope:'estelle:mcp estelle:capture offline_access', bytes:16000,
 loginMs:600000 });
// The longest legitimate holder is a login, which its own deadline ends. A lock older than that belongs to a
// process that was killed (hosts kill hooks at their timeout) and would otherwise refuse every sign-in forever.
const LOCK_STALE_MS = CAPTURE_AUTH.loginMs + 60000;
const token = value => usable(value) && value.length >= 16;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = info => [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
const fields = ['schema','issuer','client_id','resource','scope','access_token','refresh_token',
 'expires_at','partition','state'].sort().join(',');

/** Only this resource/client's private credential. It never becomes a canonical environment key. */
export function captureRecord(value) {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==fields
  || value.schema!==1 || value.issuer!==CAPTURE_AUTH.issuer || value.client_id!==CAPTURE_AUTH.client
  || value.resource!==CAPTURE_AUTH.resource || value.scope!==CAPTURE_AUTH.scope
  || !token(value.access_token) || !token(value.refresh_token)
  || !Number.isSafeInteger(value.expires_at) || value.expires_at<0
  || !/^[a-f0-9]{32}$/.test(value.partition)
  || !['active','refresh_pending','logout_pending'].includes(value.state))throw Error('capture_record');
 return {...value};
}

function privateFile(info,directory=false) {
 if((directory?!info.isDirectory():!info.isFile()) || info.uid!==BigInt(process.getuid())
  || (info.mode&0o077n)!==0n)throw Error('capture_private');
}

/** One cooperative-process lock, one private file; no stale-lock takeover or native auth-store reads. */
export class CaptureCredentialOwner {
 #fs; #base; #directory; #path;
 constructor({home=homedir(),fs=privateFs}={}) {
  this.#fs=fs;this.#base=join(home,'.estelle-plugins');
  this.#directory=join(this.#base,'capture-auth');this.#path=join(this.#directory,'credential.json');
 }
 async #ready(create=false) {
  if(process.platform==='win32' || typeof process.getuid!=='function')throw Error('capture_unsupported_platform');
  for(const directory of [this.#base,this.#directory]) {
   if(create)await this.#fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
   let info;
   try{info=await this.#fs.lstat(directory,{bigint:true});}
   catch(error){if(!create&&error.code==='ENOENT')return false;throw error;}
   privateFile(info,true);
  }
  return true;
 }
 async #snapshot() {
  let file;
  try{file=await this.#fs.open(this.#path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if(error.code==='ENOENT')return null;throw Error('capture_private');}
  try{
   const info=await file.stat({bigint:true});privateFile(info);
   if(info.size>BigInt(CAPTURE_AUTH.bytes))throw Error('capture_bound');
   const bytes=Buffer.alloc(CAPTURE_AUTH.bytes+1),result=await file.read(bytes,0,bytes.length,0);
   if(result.bytesRead!==Number(info.size))throw Error('capture_incomplete');
   if(identity(await file.stat({bigint:true}))!==identity(info))throw Error('capture_conflict');
   const data=bytes.subarray(0,result.bytesRead);
   return {record:captureRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))),
    hash:digest(data),identity:identity(info)};
  }finally{await file.close();}
 }
 async read() {
  if(!await this.#ready())return null;
  return (await this.#snapshot())?.record??null;
 }
 async #flush() {
  const directory=await this.#fs.open(this.#directory,
   constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);
  try{privateFile(await directory.stat({bigint:true}),true);await directory.sync();}
  finally{await directory.close();}
 }
 async #match(expected) {
  const current=await this.#snapshot();
  if(expected===null?current!==null:current===null||current.hash!==expected.hash
   || current.identity!==expected.identity)throw Error('capture_conflict');
 }
 async #save(record,expected) {
  const bytes=Buffer.from(JSON.stringify(captureRecord(record)));
  if(bytes.length>CAPTURE_AUTH.bytes)throw Error('capture_bound');
  await this.#match(expected);
  const path=join(this.#directory,randomBytes(16).toString('hex')+'.tmp');let file;
  try{
   file=await this.#fs.open(path,'wx',0o600);await file.writeFile(bytes);await file.sync();
   await file.close();file=null;await this.#match(expected);
   await this.#fs.rename(path,this.#path);await this.#flush();
   const saved=await this.#snapshot();
   if(saved?.hash!==digest(bytes))throw Error('capture_write_unknown');
   return saved;
  }finally{if(file)await file.close();await this.#fs.unlink(path).catch(()=>{});}
 }
 /** A live holder has the lock now. A dead one's lock is not busy: only its age tells them apart. */
 async busy() {
  try{return Date.now()-Number((await this.#fs.lstat(join(this.#directory,'credential.lock'),{bigint:true})).mtimeNs/1000000n)<=LOCK_STALE_MS;}
  catch{return false;}
 }
 /** True when the path is free to claim. Two callers racing here is unlikely and not prevented: identical bytes pass the
  *  compare in #save, so both could spend the refresh, and the server's replay check then ends in a new sign-in. */
 async #clearDeadLock(path) {
  let info;
  try{info=await this.#fs.lstat(path,{bigint:true});}
  catch(error){if(error.code==='ENOENT')return true;throw error;}
  privateFile(info);
  if(Date.now()-Number(info.mtimeNs/1000000n)<=LOCK_STALE_MS)return false;
  await this.#fs.unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  return true;
 }
 async locked(action,{create=false}={}) {
  if(!await this.#ready(create))throw Error('capture_missing');
  const path=join(this.#directory,'credential.lock');let lock;
  try{lock=await this.#fs.open(path,'wx',0o600);}
  catch(error){
   if(error.code!=='EEXIST'||!await this.#clearDeadLock(path))throw Error('capture_busy');
   try{lock=await this.#fs.open(path,'wx',0o600);}catch{throw Error('capture_busy');}
  }
  try{
   const held=await lock.stat({bigint:true});privateFile(held);let snapshot=await this.#snapshot();
   return await action({get record(){return snapshot?.record??null;},
    save:async record=>{snapshot=await this.#save(record,snapshot);},
    remove:async()=>{await this.#match(snapshot);if(snapshot){await this.#fs.unlink(this.#path);await this.#flush();snapshot=null;}}});
  }finally{
   try{const a=await lock.stat({bigint:true}),b=await this.#fs.lstat(path,{bigint:true});
    if(a.dev===b.dev&&a.ino===b.ino)await this.#fs.unlink(path);
   }finally{await lock.close();}
  }
 }
}
